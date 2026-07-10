/**
 * セリフ使用済みチェッカー
 * ウィンドウの1つを「メイン」（👑）に指定すると、同じタブ内の他ウィンドウにある
 * 「」内のセリフをメインの本文と照合し、既に使われていそうなものを黄色でハイライトする。
 *
 * 判定ロジック:
 *  1. 空白を除去し、「……」「♡♡」など同一記号の連続を1つに圧縮（正規化）
 *  2. 正規化後の文字列同士でレーベンシュタイン距離を計算し、
 *     一致率 = 1 - 距離/長い方の文字数 が閾値（既定90%）以上なら「使用済み」とみなす
 *  3. 短いセリフ（正規化後4文字以下）は誤検出しやすいので完全一致のみ
 */

// ========================================
// 状態
// ========================================
// タブごとのメインウィンドウID（例: {1: 3, 2: null, 3: null}）
const mainWinByTab = { 1: null, 2: null, 3: null };
// 使用済みマークの保持（クリア用）: { winId: [TextMarker, ...] }
const usedSerifuMarks = {};
// 一致率の閾値（%）
let serifuThreshold = 90;
// デバウンス用タイマー
let serifuCheckTimer = null;

// 連続すると1つに圧縮する記号類（伸ばし・間・ハート等の「揺れ」を吸収する）
const SERIFU_SYM_RUN = /([…‥。、，．！？!?♡❤♥☆★〜~ーっッ・])\1+/g;

// ========================================
// 正規化・類似度
// ========================================
function normalizeSerifu(s) {
    return s
        .replace(/[\s　]/g, '')       // 空白・全角空白を除去
        .replace(SERIFU_SYM_RUN, '$1');   // 同一記号の連続を1つに圧縮
}

// レーベンシュタイン距離（2行DP・メモリ節約版）
function levenshtein(a, b) {
    const la = a.length, lb = b.length;
    if (la === 0) return lb;
    if (lb === 0) return la;
    let prev = new Array(lb + 1);
    let curr = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
        curr[0] = i;
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= lb; j++) {
            const cost = (ca === b.charCodeAt(j - 1)) ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[lb];
}

/**
 * 正規化済みセリフ target がメインのセリフ一覧に「使用済み」として含まれるか判定
 * @returns {number|null} 一致率(%)。未使用ならnull
 */
function findUsedMatch(target, mainQuotes) {
    const lt = target.length;
    if (lt === 0) return null;
    const thr = serifuThreshold / 100;
    for (const q of mainQuotes) {
        const lq = q.length;
        const maxLen = Math.max(lt, lq);
        // 短文は完全一致のみ（「うん」「え？」等の誤検出防止）
        if (lt <= 4 || lq <= 4) {
            if (target === q) return 100;
            continue;
        }
        // 長さ差だけで閾値を割るものはスキップ（高速化）
        if (Math.abs(lt - lq) / maxLen > (1 - thr)) continue;
        const sim = 1 - levenshtein(target, q) / maxLen;
        if (sim >= thr) return Math.round(sim * 100);
    }
    return null;
}

// テキストから「」内のセリフを抽出する（改行を跨ぐものは対象外）
function extractQuotes(text) {
    const result = [];
    const re = /「([^「」\n]+)」/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        result.push({ raw: m[1], start: m.index, end: m.index + m[0].length });
    }
    return result;
}

// ========================================
// ハイライト処理本体
// ========================================
function clearSerifuMarks(winId) {
    if (usedSerifuMarks[winId]) {
        for (const mk of usedSerifuMarks[winId]) mk.clear();
    }
    usedSerifuMarks[winId] = [];
}

function runSerifuCheck() {
    if (!window.cmEditorInstances) return;
    const editors = window.cmEditorInstances;
    const mainIdNum = mainWinByTab[currentTabId];
    const mainWinId = mainIdNum ? ('win-' + mainIdNum) : null;

    // 👑ボタンの表示状態を全ウィンドウ分更新
    document.querySelectorAll('.btn-main-toggle').forEach(btn => {
        const idNum = parseInt(btn.id.split('-').pop());
        btn.classList.toggle('btn-active', idNum === mainIdNum);
    });

    // メイン未指定、またはメインのエディタが無い場合は全マーク解除して終了
    if (!mainWinId || !editors[mainWinId]) {
        for (const winId of Object.keys(editors)) clearSerifuMarks(winId);
        return;
    }

    // メイン本文からセリフ一覧を作成（正規化して重複除去）
    const mainQuotes = [...new Set(
        extractQuotes(editors[mainWinId].getValue()).map(q => normalizeSerifu(q.raw))
    )].filter(q => q.length > 0);

    // 他ウィンドウのセリフを照合してマーク
    for (const [winId, editor] of Object.entries(editors)) {
        clearSerifuMarks(winId);
        if (winId === mainWinId) continue;
        const text = editor.getValue();
        for (const q of extractQuotes(text)) {
            const sim = findUsedMatch(normalizeSerifu(q.raw), mainQuotes);
            if (sim === null) continue;
            const mk = editor.markText(
                editor.posFromIndex(q.start),
                editor.posFromIndex(q.end),
                { className: 'cm-used-serifu', title: `使用済み？（一致率 ${sim}%）` }
            );
            usedSerifuMarks[winId].push(mk);
        }
    }
}

// デバウンス付きで照合を予約する（エディタのchangeごとに呼ばれる）
function scheduleSerifuCheck(delay = 1200) {
    clearTimeout(serifuCheckTimer);
    serifuCheckTimer = setTimeout(() => {
        try { runSerifuCheck(); } catch (e) { console.error('セリフ照合エラー:', e); }
    }, delay);
}

// ========================================
// UI操作
// ========================================
// ウィンドウの👑ボタンから呼ばれる（メイン指定のトグル）
async function toggleMainWindow(idNum) {
    const cur = mainWinByTab[currentTabId];
    mainWinByTab[currentTabId] = (cur === idNum) ? null : idNum;
    await setSetting(`main_win_tab_${currentTabId}`, mainWinByTab[currentTabId]);
    scheduleSerifuCheck(0);
}

// ヘッダーの一致率入力から呼ばれる
async function changeSerifuThreshold(val) {
    let pct = Math.round(parseFloat(val) || 90);
    if (pct < 60) pct = 60;
    if (pct > 100) pct = 100;
    serifuThreshold = pct;
    const input = document.getElementById('serifuThresholdInput');
    if (input && parseFloat(input.value) !== pct) input.value = pct;
    await setSetting('serifu_threshold', pct);
    scheduleSerifuCheck(0);
}

// 初期化（main.jsのonload末尾から呼ばれる。DB初期化済みが前提）
async function initSerifuCheck() {
    for (let i = 1; i <= 3; i++) {
        const saved = await getSetting(`main_win_tab_${i}`);
        if (saved) mainWinByTab[i] = saved;
    }
    const savedThr = await getSetting('serifu_threshold');
    if (savedThr) {
        serifuThreshold = savedThr;
        const input = document.getElementById('serifuThresholdInput');
        if (input) input.value = savedThr;
    }
    // エディタ生成が終わったころに初回照合
    scheduleSerifuCheck(1500);
}

// グローバル公開
window.scheduleSerifuCheck = scheduleSerifuCheck;
window.toggleMainWindow = toggleMainWindow;
window.changeSerifuThreshold = changeSerifuThreshold;
window.initSerifuCheck = initSerifuCheck;

console.log("✅ セリフ使用済みチェッカー読み込み完了");
