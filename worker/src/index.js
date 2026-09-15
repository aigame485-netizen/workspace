/**
 * Canvas Workspace API（Cloudflare Workers + R2）
 *
 * 旧GAS（GAS.txt）と互換のAPI。クライアント（ブラウザ・cli_bridge.py）は
 * 接続先URLと合言葉を差し替えるだけで、GASと同じように使える。
 *
 * - 成否はHTTPステータスではなくJSONの status で返す（HTTPは原則200）
 *   cli_bridge.py は404などを「一時不調」とみなしてリトライするため
 * - 本文（暗号文）の中身は解釈しない。受け取った文字列をそのままR2へ保存する
 * - R2のキーはパスそのまま（CLIファイル: cli/{path}、Canvasボード: boards/{name}.json）
 */

const CLI_PREFIX = 'cli/';
const BOARD_PREFIX = 'boards/';
const BOARD_SUFFIX = '.json';

// 無料プランのサブリクエスト上限（50回/リクエスト）に対する、一括処理の件数上限
const BATCH_MAX_ITEMS = 40;
// メモリ上限（128MB）に対する、一括取得で返す本文の合計の目安
const BATCH_MAX_BYTES = 20 * 1024 * 1024;

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      return await handleRequest(request, env, cors);
    } catch (err) {
      return jsonResponse({ status: 'error', message: 'Global Error: ' + String(err) }, cors);
    }
  },
};

// ============================================================
//  振り分け
// ============================================================

async function handleRequest(request, env, cors) {
  const params = new URL(request.url).searchParams;

  if (!(await isAuthorized(params.get('auth'), env.SECRET_KEY))) {
    return jsonResponse({ status: 'error', message: '合言葉が違います' }, cors);
  }

  const action = params.get('action') || '';

  // CLI連携
  if (action.startsWith('cli_')) {
    return jsonResponse(await handleCli(action, params, request, env), cors);
  }

  // Canvasボード: 一覧・削除
  if (action === 'list') return jsonResponse(await listBoards(env), cors);
  if (action === 'delete') return jsonResponse(await deleteBoard(params, env), cors);

  // Canvasボード: 読込・保存
  // ボードは解析せずにそのまま流す（大きなボディのJSON処理でCPU時間を使わないため）
  const boardName = params.get('boardName') || 'default';
  const key = BOARD_PREFIX + boardName + BOARD_SUFFIX;
  const body = request.method === 'POST' ? await request.arrayBuffer() : null;

  if (action === 'download' || !body || body.byteLength === 0) {
    const obj = await env.BUCKET.get(key);
    if (!obj) return jsonResponse({ status: 'error', message: 'File not found' }, cors);
    // 保存されている文字列を {status} で包まずにそのまま返す（GASと同じ）
    return new Response(obj.body, {
      status: 200,
      headers: { ...cors, 'Content-Type': JSON_CONTENT_TYPE },
    });
  }

  await env.BUCKET.put(key, body);
  return jsonResponse({ status: 'success' }, cors);
}

// ============================================================
//  CLIファイル
// ============================================================

async function handleCli(action, params, request, env) {
  switch (action) {
    case 'cli_capabilities':
      return {
        status: 'success',
        version: 2,
        features: ['upload_batch', 'download_batch', 'folder_store', 'id_cache'],
      };

    case 'cli_list': {
      const objects = await listAll(env, CLI_PREFIX);
      const files = objects.map((o) => ({
        path: o.key.slice(CLI_PREFIX.length),
        updatedAt: o.uploaded.toISOString(),
        size: o.size,
      }));
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { status: 'success', files };
    }

    case 'cli_download': {
      const path = params.get('path');
      if (!path) return errorResult('pathが必要です');
      const obj = await env.BUCKET.get(CLI_PREFIX + path);
      if (!obj) return errorResult('File not found: ' + path);
      return {
        status: 'success',
        path,
        content: await obj.text(),
        updatedAt: obj.uploaded.toISOString(),
      };
    }

    case 'cli_upload': {
      const path = params.get('path');
      if (!path) return errorResult('pathが必要です');
      // ボディは解析せずそのまま保存する（空なら空文字）
      const body = request.method === 'POST' ? await request.arrayBuffer() : new ArrayBuffer(0);
      const saved = await env.BUCKET.put(CLI_PREFIX + path, body);
      return { status: 'success', path, updatedAt: saved.uploaded.toISOString() };
    }

    case 'cli_upload_batch':
      return uploadBatch(request, env);

    case 'cli_download_batch':
      return downloadBatch(request, env);

    case 'cli_delete': {
      const path = params.get('path');
      if (!path) return errorResult('pathが必要です');
      if (path === '*') return { status: 'success', deletedCount: await deleteAllCli(env) };

      const key = CLI_PREFIX + path;
      const exists = await env.BUCKET.head(key);
      if (!exists) return { status: 'success', deletedCount: 0 };
      await env.BUCKET.delete(key);
      return { status: 'success', deletedCount: 1 };
    }

    default:
      // 未知の cli_* はCanvas側へ落とさずエラーにする（誤ってボードを上書きしないため）
      return errorResult('未知のCLIアクション: ' + action);
  }
}

/**
 * 一括アップロード。ボディ {"files":[{path, content}]}
 * 件数上限を超えた分は remaining で差し戻す（cli_bridge.py が再送する）
 */
async function uploadBatch(request, env) {
  const payload = await readJsonBody(request);
  if (payload === undefined) return errorResult('POST bodyがJSONとして不正です');

  const items = payload && payload.files;
  if (!Array.isArray(items)) return errorResult('files配列が必要です');

  const results = [];
  const remaining = [];

  for (let i = 0; i < items.length; i++) {
    if (i >= BATCH_MAX_ITEMS) {
      for (let j = i; j < items.length; j++) remaining.push((items[j] && items[j].path) || '');
      break;
    }

    const item = items[i];
    if (!item || !item.path) {
      results.push({ path: (item && item.path) || '', ok: false, message: 'pathが必要です' });
      continue;
    }
    try {
      const content = item.content == null ? '' : String(item.content);
      const saved = await env.BUCKET.put(CLI_PREFIX + item.path, content);
      results.push({ path: item.path, ok: true, updatedAt: saved.uploaded.toISOString() });
    } catch (err) {
      results.push({ path: item.path, ok: false, message: String(err) });
    }
  }

  return { status: 'success', results, remaining };
}

/**
 * 一括ダウンロード。ボディ {"paths":[...]}
 * 件数上限、または本文の合計が約20MBを超えたら、残りを remaining で返す
 */
async function downloadBatch(request, env) {
  const payload = await readJsonBody(request);
  if (payload === undefined) return errorResult('POST bodyがJSONとして不正です');

  const paths = payload && payload.paths;
  if (!Array.isArray(paths)) return errorResult('paths配列が必要です');

  const files = [];
  const missing = [];
  const remaining = [];
  let totalBytes = 0;

  for (let i = 0; i < paths.length; i++) {
    if (i >= BATCH_MAX_ITEMS || totalBytes > BATCH_MAX_BYTES) {
      remaining.push(...paths.slice(i));
      break;
    }

    const path = paths[i];
    try {
      const obj = (typeof path === 'string' && path) ? await env.BUCKET.get(CLI_PREFIX + path) : null;
      if (!obj) { missing.push(path); continue; }
      files.push({ path, content: await obj.text(), updatedAt: obj.uploaded.toISOString() });
      totalBytes += obj.size;
    } catch (err) {
      missing.push(path);
    }
  }

  return { status: 'success', files, missing, remaining };
}

/**
 * cli/ 配下を全件削除する（Canvasボードは消さない）。
 * delete() には1回で最大1000キーを渡せる。消した分は一覧から消えるので、
 * cursorを使わず先頭から取り直す。
 */
async function deleteAllCli(env) {
  let count = 0;
  for (;;) {
    const page = await env.BUCKET.list({ prefix: CLI_PREFIX, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length === 0) break;
    await env.BUCKET.delete(keys);
    count += keys.length;
    if (!page.truncated) break;
  }
  return count;
}

// ============================================================
//  Canvasボード
// ============================================================

async function listBoards(env) {
  const objects = await listAll(env, BOARD_PREFIX);
  const infoMap = {};
  for (const o of objects) {
    if (!o.key.endsWith(BOARD_SUFFIX)) continue;
    const name = o.key.slice(BOARD_PREFIX.length, -BOARD_SUFFIX.length);
    infoMap[name] = o.uploaded.toISOString();
  }
  const names = Object.keys(infoMap).sort();
  return {
    status: 'success',
    boards: names,
    boardsInfo: names.map((name) => ({ name, updatedAt: infoMap[name] })),
  };
}

async function deleteBoard(params, env) {
  const boardName = params.get('boardName');
  if (!boardName) return errorResult('名前がありません');

  const key = BOARD_PREFIX + boardName + BOARD_SUFFIX;
  const exists = await env.BUCKET.head(key);
  if (!exists) return { status: 'success', deletedCount: 0 };
  await env.BUCKET.delete(key);
  return { status: 'success', deletedCount: 1 };
}

// ============================================================
//  共通
// ============================================================

/** prefix 配下のオブジェクトを全件取る（list() は1回1000件までなので cursor で続きを取る） */
async function listAll(env, prefix) {
  const objects = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

/**
 * 合言葉の照合。定数時間で比較する。
 * timingSafeEqual は長さが違うと使えないので、両方をSHA-256にそろえてから比べる。
 * SECRET_KEY が未登録なら全て拒否する。
 */
async function isAuthorized(given, secret) {
  if (!secret || typeof given !== 'string' || given === '') return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** ボディをJSONとして読む。不正なJSONなら undefined を返す */
async function readJsonBody(request) {
  const text = request.method === 'POST' ? await request.text() : '';
  try {
    return JSON.parse(text || '{}');
  } catch (err) {
    return undefined;
  }
}

function errorResult(message) {
  return { status: 'error', message };
}

/**
 * 許可したOriginにだけ Access-Control-Allow-Origin を返す。
 * エラー応答にも同じヘッダを付ける（付けないとブラウザがエラー内容を読めない）
 */
function corsHeaders(request, env) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(data, cors) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...cors, 'Content-Type': JSON_CONTENT_TYPE },
  });
}
