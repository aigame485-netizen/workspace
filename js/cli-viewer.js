// =========================================
// CLI Viewer モジュール
// PC上のClaude CLIがアップロードしたファイルを
// スマホから閲覧・編集し、指示パッドでAIへの指示を作る
// =========================================

// --- 状態管理 ---
let cliViewerActive = false;
let cliEditorInstance = null;
let cliCurrentFile = null;
let cliFileList = [];
let cliFontSize = 14;
let cliMemoExpanded = true;        // 下部パネル（指示パッド/提案）の展開状態
let cliEditMode = false;           // 編集モードON/OFF
let cliOriginalContent = '';       // 編集前の元テキスト（変更検知用）
let cliHasUnsavedChanges = false;  // 未保存の変更があるか
let cliActiveTab = 'instruction';  // 'instruction' | 'proposals'
let cliDraftSaveTimer = null;      // 下書き自動保存タイマー
let cliInstructionSaveTimer = null; // 指示パッドの自動保存タイマー
let cliPendingServerContent = null; // サーバー側の新しい内容（更新バナー表示中）

// このセッションで cli_list を取り直したか。
// 起動時の一覧はキャッシュ由来（＝古い可能性がある）なので、それを根拠に
// 「キャッシュは最新」と判断してしまうと更新を取りこぼす。取得済みの時だけ信用する。
let cliFileListFresh = false;
let cliFileListFetchedAt = null;   // 一覧を最後にサーバーから取得した時刻（表示用）

// 1回の先読みでまとめて取得する最大ファイル数（GASの実行時間に配慮した上限）
const CLI_PREFETCH_LIMIT = 15;
let cliImageMode = false;           // 現在開いているファイルが画像かどうか
let cliPreviewMode = false;         // マークダウンを整形表示しているか
let cliPreviewTimer = null;         // 整形表示の再描画を間引くためのタイマー
let cliPreviewLastFile = null;      // 整形表示が最後に描画したファイル（別ファイルなら先頭へ戻す）
let cliOpenFolders = new Set();     // 展開中のフォルダパス（再描画で畳み直されないよう覚えておく）
let cliStatusTimer = null;          // 進捗トーストを自動で引っ込めるタイマー
const CLI_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

// --- サブ参照ペイン ---
// メイン(編集できる本文) + サブ2枠(閲覧専用)をヘッダーのタブで切り替える。
// 3枠ともDOMを残したまま display だけ入れ替えるので、往復してもスクロール位置が保たれる。
let cliActivePane = 'main';                    // 'main' | 1 | 2
const cliSubPaths   = { 1: null, 2: null };    // 各サブが開いているファイルパス
const cliSubLoaded  = { 1: false, 2: false };  // 中身を描画済みか
const cliSubLoading = { 1: false, 2: false };  // 読み込み中か（タブ切替との二重起動よけ）
let cliMainCursor = null;                      // メインへ戻る時に復元するカーソル位置

// =========================================
// モード切替
// =========================================

// 今CLIモードかどうか（main.js からCanvasの遅延ロード判定に使う）
window.cliIsActive = () => cliViewerActive;

function toggleCliViewer() {
    const turningOn = !cliViewerActive;

    // CLIから作業場へ戻る時の未保存確認は、状態を切り替える「前」に行う。
    // 先に cliViewerActive を反転してしまうと、キャンセルしたのに画面はCLIのまま
    // フラグだけOFFになり、進捗トーストが出なくなる／📡が初期化からやり直しになる
    if (!turningOn && cliHasUnsavedChanges) {
        if (!confirm('未保存の変更があります。破棄して戻りますか？')) return;
    }

    cliViewerActive = turningOn;
    const canvas = document.getElementById('canvas');
    const header = document.querySelector('header');
    const viewer = document.getElementById('cli-viewer');
    const cliBtn = document.querySelector('.btn-cli');
    const tabbar = document.getElementById('cli-tabbar');
    // CLIモード中はヘッダーのh1を隠してペイン切替タブの幅を稼ぐ（CSS側で参照）
    document.body.classList.toggle('cli-mode', cliViewerActive);

    if (cliViewerActive) {
        canvas.style.display = 'none';
        // ヘッダー内のCLI以外の要素を非表示（CLIモード専用表示）
        // ※ ペイン切替タブ(#cli-tabbar)はCLIモード専用なのでここでは触らない
        Array.from(header.children).forEach(el => {
            if (!el.classList.contains('btn-cli') && el.tagName !== 'H1' && el.id !== 'cli-tabbar') {
                el.dataset.cliHidden = el.style.display || '';
                el.style.display = 'none';
            }
        });
        if (tabbar) tabbar.style.display = 'flex';
        viewer.style.display = 'flex';
        cliBtn.classList.add('active');
        initCliViewer();
    } else {
        // 作業場へ戻る前にメインペインへ畳んでおく（次にCLIへ入った時の見え方を揃える）
        cliSwitchPane('main');
        if (tabbar) tabbar.style.display = 'none';
        // 未保存変更の確認は冒頭で済ませてある
        // 編集モードを解除（明示的に破棄→下書きも消す）
        if (cliEditMode) cliExitEditMode(true);
        cliHideImage();
        cliDismissDraftBanner();
        // CLIモードで起動した場合、Canvasのウィンドウはまだ復元していない。ここで初めて読み込む
        if (window.ensureCanvasLoaded) window.ensureCanvasLoaded();
        canvas.style.display = '';
        // ヘッダー要素を復元
        Array.from(header.children).forEach(el => {
            if (el.dataset.cliHidden !== undefined) {
                el.style.display = el.dataset.cliHidden;
                delete el.dataset.cliHidden;
            }
        });
        viewer.style.display = 'none';
        cliBtn.classList.remove('active');
        destroyCliEditor();
        closeCliSidebar();
        // 文字数バッジを非表示
        const badge = document.getElementById('cli-charcount-badge');
        if (badge) badge.style.display = 'none';
    }
}

// =========================================
// 初期化・破棄
// =========================================

async function initCliViewer() {
    if (!cliEditorInstance) {
        const textarea = document.getElementById('cli-viewer-textarea');
        cliEditorInstance = CodeMirror.fromTextArea(textarea, {
            mode: "markdown",
            theme: "workspace-dark",
            lineWrapping: true,
            readOnly: true,
            // IME対策: 変換候補ウィンドウを実カーソル位置の真下に出す（cm-init.js参照）
            inputStyle: "contenteditable",
            spellcheck: false,
            viewportMargin: Infinity
        });
        cliEditorInstance.getWrapperElement().style.fontSize = cliFontSize + "px";
        // 書体はCSS変数で一元管理（ヘッダーの書体セレクトから変更される）
        cliEditorInstance.getWrapperElement().style.fontFamily = "var(--editor-font)";
        setTimeout(() => cliEditorInstance.refresh(), 100);

        // 範囲選択時に文字数バッジへ選択文字数を表示する
        cliEditorInstance.on("cursorActivity", cliUpdateCharCount);

        // 指示パッドの自動保存を初期化（localStorageから復元＋入力リスナー登録）
        cliSetupInstructionAutosave();

        // 本文が変わったら整形表示も追従させる（setValueによる差し替えも拾える）
        cliEditorInstance.on('changes', cliSchedulePreviewRender);

        // 整形表示のON/OFFを復元
        try {
            cliPreviewMode = (localStorage.getItem('cli_preview_mode') === '1');
        } catch (_) { cliPreviewMode = false; }
        cliApplyPreviewMode();
    }

    // ファイル一覧はローカルキャッシュから即表示する（GASには繋がない）。
    // フォルダ構成はめったに変わらないので、取り直しはサイドバーの「🔄 一覧を更新」だけで行う。
    const hasCache = await cliLoadCachedFileList();
    if (!hasCache) {
        // 初回だけは手がかりが無いのでサーバーから取ってくる
        cliRefreshFileList();
    }

    // サブ参照ペインの復元（パスだけ戻す。中身はタブを開いた時にキャッシュから読む）
    cliRestoreSubPanes();

    // 使用済みセリフ塗り分けのON/OFF復元
    cliInitSerifuCheck();
}

function destroyCliEditor() {
    if (cliEditorInstance) {
        cliEditorInstance.toTextArea();
        cliEditorInstance = null;
    }
}

// =========================================
// サイドバー制御
// =========================================

// PC判定（サイドバー常時表示レイアウトが適用される幅かどうか）
function cliIsPcLayout() {
    return window.matchMedia('(min-width: 1024px)').matches;
}

function toggleCliSidebar() {
    // PCではサイドバーが常時表示なので、☰は「畳む/戻す」のトグルとして動作
    if (cliIsPcLayout()) {
        document.getElementById('cli-viewer').classList.toggle('pc-sidebar-hidden');
        // 本文エリアの幅が変わるのでCodeMirrorの座標計算を更新（transition完了後）
        setTimeout(() => { if (cliEditorInstance) cliEditorInstance.refresh(); }, 320);
        return;
    }

    const sidebar = document.getElementById('cli-sidebar');
    const overlay = document.getElementById('cli-sidebar-overlay');
    const isOpen = sidebar.classList.contains('open');

    if (isOpen) {
        closeCliSidebar();
    } else {
        sidebar.classList.add('open');
        overlay.classList.add('show');
    }
}

function closeCliSidebar() {
    document.getElementById('cli-sidebar').classList.remove('open');
    document.getElementById('cli-sidebar-overlay').classList.remove('show');
}

// =========================================
// CLI内 接続設定（暗号キー・合言葉）
// クラウドモーダルまで戻らなくても設定変更できる簡易版。
// 保存処理は main.js の関数（IndexedDB）をそのまま利用する。
// =========================================

// 実装は main.js の openConnectionSettings() 系に統合済み（合言葉・暗号キーの入力口は1箇所だけ）

// =========================================
// 進捗トースト
// CLIモードではヘッダーが隠れて #status-indicator が見えないため、
// main.js の updateStatus() からここへ流して画面上部に出す。
// =========================================

// 作業場（Canvas）側の保存通知。CLIビューアとは無関係なのでトーストには出さない。
// CLI側の保存は「💾 保存中...」「✅ 保存完了」と絵文字付きなので、完全一致では引っかからない
const CLI_STATUS_IGNORE = ['変更...', '保存済', '保存中...', '保存完了', '切替中...'];

function cliOnStatus(msg, saved, isError) {
    const el = document.getElementById('cli-status-toast');
    if (!el || !cliViewerActive) return;

    // 「Ready」は待機状態なので何も出さない
    if (!msg || msg === 'Ready') { el.classList.remove('show'); return; }

    // 作業場側の通知は無視（何も保存していないのに「保存済」が降りてくるのを防ぐ）
    if (CLI_STATUS_IGNORE.includes(msg)) return;

    if (cliStatusTimer) clearTimeout(cliStatusTimer);

    const state = isError ? 'error' : (saved ? 'done' : 'busy');
    const icon = (state === 'busy') ? '<span class="cli-status-spinner"></span>' : '';
    el.className = 'cli-status-toast show ' + state;
    el.innerHTML = icon + '<span>' + escapeHtml(msg) + '</span>';

    // 完了・失敗は自動で引っ込める。処理中は出したままにする
    if (state === 'done') cliStatusTimer = setTimeout(() => el.classList.remove('show'), 2000);
    else if (state === 'error') cliStatusTimer = setTimeout(() => el.classList.remove('show'), 6000);
}
window.cliOnStatus = cliOnStatus;

// =========================================
// マークダウン整形表示
// 閲覧中は本文と差し替え、編集中はエディタと分割表示にする
// （PCは左右、スマホは上下に割る）
// =========================================

function toggleCliPreview() {
    if (cliImageMode) { alert('画像ファイルは整形表示できません'); return; }

    // 整形表示は閲覧専用。編集中に押されたら、編集モードを抜けてから切り替える
    if (!cliPreviewMode && cliEditMode) {
        if (cliHasUnsavedChanges && !confirm('未保存の変更があります。破棄して整形表示にしますか？')) return;
        cliExitEditMode(true);
    }
    cliSetPreviewMode(!cliPreviewMode);
}

// 整形⇔原文の切替。切替前に見ていた行を覚えておき、切替後に同じ場所へ合わせる
function cliSetPreviewMode(on) {
    if (cliPreviewMode === on) return;
    const anchorLine = cliPreviewMode ? cliPreviewTopLine() : cliEditorTopLine();
    cliPreviewMode = on;
    try { localStorage.setItem('cli_preview_mode', on ? '1' : '0'); } catch (_) {}
    cliApplyPreviewMode(anchorLine);
}

function cliApplyPreviewMode(anchorLine = null) {
    const viewer = document.getElementById('cli-viewer');
    if (viewer) viewer.classList.toggle('cli-preview-on', cliPreviewMode);
    cliUpdatePreviewButton();

    if (cliPreviewMode) {
        cliRenderPreview();
        if (anchorLine !== null) cliScrollPreviewToLine(anchorLine);
    }

    // 表示が切り替わった直後は座標がずれているので、計算し直してから位置を合わせる
    if (cliEditorInstance) {
        setTimeout(() => {
            cliEditorInstance.refresh();
            if (!cliPreviewMode && anchorLine !== null) cliScrollEditorToLine(anchorLine);
        }, 50);
    }
}

// =========================================
// 整形表示と原文のスクロール位置あわせ
// 整形表示の各ブロックに元の行番号(data-line)を振っておき、それを手がかりにする
// =========================================

// エディタの一番上に見えている行
function cliEditorTopLine() {
    if (!cliEditorInstance) return 0;
    try {
        return cliEditorInstance.lineAtHeight(cliEditorInstance.getScrollInfo().top, 'local');
    } catch (_) { return 0; }
}

// エディタを指定行が先頭に来るようスクロール
function cliScrollEditorToLine(line) {
    if (!cliEditorInstance) return;
    const max = Math.max(0, cliEditorInstance.lineCount() - 1);
    const n = Math.max(0, Math.min(line, max));
    const coords = cliEditorInstance.charCoords({ line: n, ch: 0 }, 'local');
    cliEditorInstance.scrollTo(null, coords.top);
}

// 整形表示の一番上に見えているブロックの、元の行番号
function cliPreviewTopLine() {
    const el = document.getElementById('cli-preview');
    if (!el) return 0;
    const top = el.scrollTop + 4;
    let line = 0;
    for (const node of el.querySelectorAll('[data-line]')) {
        if (node.offsetTop <= top) line = parseInt(node.dataset.line, 10) || 0;
        else break;
    }
    return line;
}

// 整形表示を、指定行を含むブロックが先頭に来るようスクロール
function cliScrollPreviewToLine(line) {
    const el = document.getElementById('cli-preview');
    if (!el) return;
    let target = null;
    for (const node of el.querySelectorAll('[data-line]')) {
        if ((parseInt(node.dataset.line, 10) || 0) <= line) target = node;
        else break;
    }
    el.scrollTop = target ? target.offsetTop : 0;
}

function cliUpdatePreviewButton() {
    const btn = document.getElementById('cli-btn-preview');
    if (!btn) return;
    btn.textContent = cliPreviewMode ? '📄 原文' : '📖 整形';
    btn.classList.toggle('btn-active', cliPreviewMode);
    btn.title = cliPreviewMode ? 'マークダウンの原文表示に戻す' : 'マークダウンを整形して表示（表が読みやすくなります）';
}

// 連続入力で作り直し続けないよう、少し待ってから描画する
function cliSchedulePreviewRender() {
    if (!cliPreviewMode) return;
    if (cliPreviewTimer) clearTimeout(cliPreviewTimer);
    cliPreviewTimer = setTimeout(cliRenderPreview, 250);
}

function cliRenderPreview() {
    const el = document.getElementById('cli-preview');
    if (!el || !cliEditorInstance) return;

    const md = cliEditorInstance.getValue();
    // 別のファイルを開いた時は、前のファイルのスクロール位置を引き継がない
    const sameFile = (cliPreviewLastFile === cliCurrentFile);
    cliPreviewLastFile = cliCurrentFile;
    const prevScroll = sameFile ? el.scrollTop : 0;

    if (typeof marked === 'undefined') {
        // CDNが読めなかった場合は原文をそのまま出す（表示が空になるのを防ぐ）
        el.innerHTML = '<p class="cli-preview-error">整形用ライブラリを読み込めませんでした。原文を表示します。</p>'
            + '<pre class="cli-preview-raw">' + escapeHtml(md) + '</pre>';
        return;
    }

    const opts = { gfm: true, breaks: true };
    el.innerHTML = marked.parse(md, opts);

    // 幅の広い表は、本文ごと横に伸びないよう個別にスクロールさせる
    // （data-lineを振る前に囲む。囲んだdivの方が最上位の要素になるため）
    el.querySelectorAll('table').forEach(table => {
        if (table.parentElement && table.parentElement.classList.contains('md-table-wrap')) return;
        const wrap = document.createElement('div');
        wrap.className = 'md-table-wrap';
        table.parentNode.insertBefore(wrap, table);
        wrap.appendChild(table);
    });

    // 原文の何行目から作られたブロックかを記録する（スクロール位置あわせ用）
    // marked のトークンは元テキスト(raw)を持っているので、改行数を積み上げれば行番号が出る
    try {
        const lines = [];
        let line = 0;
        marked.lexer(md, opts).forEach(token => {
            if (token.type !== 'space') lines.push(line);
            line += (token.raw.match(/\n/g) || []).length;
        });
        const blocks = el.children;
        for (let i = 0; i < blocks.length && i < lines.length; i++) {
            blocks[i].dataset.line = lines[i];
        }
    } catch (_) { /* 対応づけに失敗しても表示自体には影響させない */ }

    // 本文と同じ文字サイズに揃える
    el.style.fontSize = cliFontSize + 'px';
    el.scrollTop = prevScroll;
}

// =========================================
// ファイル一覧の取得と表示
// =========================================

// サイドバーの「🔄 一覧を更新」専用。
// ここでしかファイル一覧のためにGASへ繋がない（開いているファイルの中身には触らない）。
async function cliRefreshFileList() {
    const pass = await getAuthPassword();
    if (!pass) return;

    const treeEl = document.getElementById('cli-file-tree');
    const btn = document.getElementById('cli-btn-refresh-list');
    if (btn) { btn.disabled = true; btn.textContent = '🔄 更新中...'; }

    try {
        updateStatus('CLI一覧取得中...', false);
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_list`;
        const res = await fetch(url, { method: 'POST' });
        const json = await res.json();

        if (json.status === 'success') {
            cliFileList = json.files;
            cliFileListFresh = true;
            cliFileListFetchedAt = Date.now();
            await cliSaveFileListToCache(cliFileList);
            cliRenderFileTree(cliFileList);
            cliUpdateListMeta();
            updateStatus('CLI一覧取得完了', true);
        } else {
            if (json.message && json.message.includes("合言葉")) await clearAuthPassword();
            throw new Error(json.message);
        }
    } catch (e) {
        treeEl.innerHTML = `<div style="color:#f56565; padding:10px;">エラー: ${e.message}</div>`;
        updateStatus('CLI取得失敗', false, true);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 一覧を更新'; }
    }
}

// 一覧の鮮度（最後にサーバーから取り直した時刻）をサイドバーに出す
function cliUpdateListMeta() {
    const el = document.getElementById('cli-list-meta');
    if (!el) return;
    if (!cliFileListFetchedAt) {
        el.textContent = '一覧: 未取得';
        return;
    }
    const d = new Date(cliFileListFetchedAt);
    const sameDay = (new Date().toDateString() === d.toDateString());
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const label = sameDay ? hhmm : `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
    el.textContent = `一覧: ${label} 取得` + (cliFileListFresh ? '' : '（保存分）');
}

// =========================================
// 画像ファイル判定・表示ヘルパー
// =========================================

function cliIsImagePath(path) {
    const ext = '.' + path.split('.').pop().toLowerCase();
    return CLI_IMAGE_EXTENSIONS.includes(ext);
}

function cliTryParseImageContent(content) {
    try {
        const parsed = JSON.parse(content);
        if (parsed && parsed.type === 'image' && parsed.data) {
            return parsed;
        }
    } catch (_) {}
    return null;
}

function cliShowImage(imageObj) {
    cliImageMode = true;
    // 画像表示中は整形表示を一旦畳む（設定自体は保持し、次にmdを開くと戻る）
    const viewer = document.getElementById('cli-viewer');
    if (viewer) viewer.classList.remove('cli-preview-on');
    const area = document.getElementById('cli-viewer-area');
    // CodeMirrorを非表示
    if (cliEditorInstance) {
        cliEditorInstance.getWrapperElement().style.display = 'none';
    }
    // 既存の画像コンテナがあれば再利用
    let container = document.getElementById('cli-image-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'cli-image-container';
        container.className = 'cli-image-container';
        area.appendChild(container);
    }
    container.style.display = 'flex';
    container.innerHTML = `<img src="data:${imageObj.mimeType};base64,${imageObj.data}" alt="uploaded image" class="cli-image-preview">`;
}

function cliHideImage() {
    cliImageMode = false;
    // 画像から離れたら、整形表示の設定を復帰させる
    const viewer = document.getElementById('cli-viewer');
    if (viewer) viewer.classList.toggle('cli-preview-on', cliPreviewMode);
    if (cliPreviewMode) cliSchedulePreviewRender();
    const container = document.getElementById('cli-image-container');
    if (container) {
        container.style.display = 'none';
        container.innerHTML = '';
    }
    if (cliEditorInstance) {
        cliEditorInstance.getWrapperElement().style.display = '';
    }
}

// =========================================
// ファイルツリーのレンダリング
// =========================================

function cliRenderFileTree(files) {
    const treeEl = document.getElementById('cli-file-tree');
    treeEl.innerHTML = '';

    if (!files || files.length === 0) {
        treeEl.innerHTML = '<div style="text-align:center; color:#718096; padding:20px;">CLIファイルがありません<br><span style="font-size:0.8rem;">CLIから「push」でファイルをアップロードしてください</span></div>';
        return;
    }

    const root = cliBuildFileTree(files);

    // 今開いているファイルまでの道筋は自動で開けておく（選択中のファイルが埋もれないように）
    if (cliCurrentFile) {
        const parts = cliCurrentFile.split('/');
        parts.pop();
        let prefix = '';
        parts.forEach(p => {
            prefix = prefix ? prefix + '/' + p : p;
            cliOpenFolders.add(prefix);
        });
    }

    // フォルダ → ルート直下のファイル、の順に並べる
    [...root.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
        .forEach(dir => treeEl.appendChild(cliCreateFolderNode(dir)));

    root.files.forEach(f => treeEl.appendChild(cliCreateFileItem(f)));
}

// パスの配列から階層構造を組み立てる
// 例: 4作目/シナリオ/日常.md → { dirs: { 4作目: { dirs: { シナリオ: { files: [日常.md] } } } } }
function cliBuildFileTree(files) {
    const root = { name: '', path: '', dirs: new Map(), files: [] };

    files.forEach(f => {
        const parts = f.path.split('/');
        parts.pop();  // ファイル名を除いた部分がフォルダ階層
        let node = root;
        let prefix = '';
        parts.forEach(p => {
            prefix = prefix ? prefix + '/' + p : p;
            if (!node.dirs.has(p)) {
                node.dirs.set(p, { name: p, path: prefix, dirs: new Map(), files: [] });
            }
            node = node.dirs.get(p);
        });
        node.files.push(f);
    });

    return root;
}

// そのフォルダ以下にあるファイルを全部集める（件数表示とフォルダ削除に使う）
function cliCollectFiles(node, out = []) {
    node.files.forEach(f => out.push(f));
    node.dirs.forEach(d => cliCollectFiles(d, out));
    return out;
}

function cliCreateFolderNode(node) {
    const contained = cliCollectFiles(node);
    const isOpen = cliOpenFolders.has(node.path);

    const folderDiv = document.createElement('div');
    folderDiv.className = 'cli-folder' + (isOpen ? ' open' : '');

    const header = document.createElement('div');
    header.className = 'cli-folder-header';

    const arrow = document.createElement('span');
    arrow.className = 'cli-folder-arrow';
    arrow.textContent = '▶';

    const headerLabel = document.createElement('span');
    headerLabel.className = 'cli-folder-label';
    const renderLabel = () => {
        const icon = folderDiv.classList.contains('open') ? '📂' : '📁';
        headerLabel.innerHTML = `${icon} ${escapeHtml(node.name)} <span style="color:#a0aec0; font-weight:normal;">(${contained.length})</span>`;
    };
    renderLabel();

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'cli-folder-delete';
    deleteBtn.textContent = '🗑';
    deleteBtn.title = 'フォルダごと削除（中のフォルダも含む）';
    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        cliDeleteFolder(node.path, contained);
    };

    header.appendChild(arrow);
    header.appendChild(headerLabel);
    header.appendChild(deleteBtn);

    header.onclick = (e) => {
        if (e.target === deleteBtn) return;
        const nowOpen = folderDiv.classList.toggle('open');
        if (nowOpen) cliOpenFolders.add(node.path);
        else cliOpenFolders.delete(node.path);
        renderLabel();
    };

    const childrenDiv = document.createElement('div');
    childrenDiv.className = 'cli-folder-files';

    // 子フォルダを先に、その下にファイルを並べる
    [...node.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
        .forEach(dir => childrenDiv.appendChild(cliCreateFolderNode(dir)));

    node.files.forEach(f => childrenDiv.appendChild(cliCreateFileItem(f)));

    folderDiv.appendChild(header);
    folderDiv.appendChild(childrenDiv);
    return folderDiv;
}

function cliCreateFileItem(fileInfo) {
    const fileName = fileInfo.path.split('/').pop();
    // 「今アクティブなペインが開いているファイル」に👉を付ける（メイン/サブで指す先が変わる）
    const isSelected = (cliActivePane === 'main')
        ? (cliCurrentFile === fileInfo.path)
        : (cliSubPaths[cliActivePane] === fileInfo.path);
    // 他のサブが掴んでいるファイルは📚で見分けられるようにする
    const inOtherSub = !isSelected && (cliSubPaths[1] === fileInfo.path || cliSubPaths[2] === fileInfo.path);
    const item = document.createElement('div');
    item.className = 'cli-file-item' + (isSelected ? ' selected' : '');

    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'flex-grow:1; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    const fileIcon = cliIsImagePath(fileInfo.path) ? '🖼️' : '📄';
    nameSpan.textContent = (isSelected ? '👉 ' : (inOtherSub ? '📚 ' : fileIcon + ' ')) + fileName;
    nameSpan.onclick = () => cliHandleFileClick(fileInfo.path);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'cli-file-delete';
    deleteBtn.textContent = '🗑';
    deleteBtn.title = '削除';
    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        cliDeleteFile(fileInfo.path);
    };

    item.appendChild(nameSpan);
    item.appendChild(deleteBtn);
    return item;
}

// =========================================
// ファイルを開く（キャッシュ → サーバー取得）
// =========================================

async function cliOpenFile(path) {
    // 別ファイルの編集中なら先に処理
    if (cliEditMode && cliCurrentFile && cliCurrentFile !== path) {
        if (cliHasUnsavedChanges) {
            if (!confirm('現在のファイルに未保存の変更があります。別のファイルを開きますか？')) return;
        }
        cliExitEditMode(true);
    }

    cliCurrentFile = path;
    document.getElementById('cli-current-filename').textContent = path;
    cliDismissDraftBanner();

    const isImage = cliIsImagePath(path);

    // 画像ファイルの場合は下書き・編集モードなし
    if (isImage) {
        cliHideImage();
        if (cliEditMode) cliExitEditMode(true);
        cliEditorInstance.setValue('🖼️ 画像を読み込み中...');
        closeCliSidebar();

        // 【高速化】キャッシュが最新世代なら通信せずに表示する（画像は特に効果が大きい）
        const cachedImage = await cliGetCachedFile(path);
        if (cliIsCacheFresh(path, cachedImage)) {
            const cachedObj = cliTryParseImageContent(cachedImage.content);
            if (cachedObj) {
                cliShowImage(cachedObj);
                cliRenderFileTree(cliFileList);
                updateStatus('🖼️ 表示完了（キャッシュ最新）', true);
                return;
            }
        }

        const pass = await getAuthPassword();
        if (!pass) return;

        try {
            updateStatus('画像取得中...', false);
            const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_download&path=${encodeURIComponent(path)}`;
            const res = await fetch(url, { method: 'POST' });
            const json = await res.json();

            if (json.status === 'success') {
                let content = json.content;

                // 暗号化データの復号
                try {
                    const parsed = JSON.parse(content);
                    if (parsed && parsed.encrypted) {
                        const encKey = await getEncryptionKey();
                        if (!encKey) {
                            cliEditorInstance.setValue('[暗号化データ] 暗号キーを設定してください');
                            cliRenderFileTree(cliFileList);
                            return;
                        }
                        try {
                            content = await decryptData(parsed, encKey);
                        } catch (decErr) {
                            cliEditorInstance.setValue('[復号失敗] 暗号キーが正しいか確認してください');
                            cliRenderFileTree(cliFileList);
                            return;
                        }
                    }
                } catch (_) {}

                const imageObj = cliTryParseImageContent(content);
                if (imageObj) {
                    cliShowImage(imageObj);
                    await cliSaveFileToCache(path, content, json.updatedAt);
                    updateStatus('🖼️ 画像表示完了', true);
                } else {
                    cliEditorInstance.setValue('[画像データの解析に失敗しました]');
                    updateStatus('画像解析失敗', false, true);
                }
            } else {
                throw new Error(json.message);
            }
        } catch (e) {
            cliEditorInstance.setValue('エラー: ' + e.message);
            updateStatus('取得失敗', false, true);
        }

        cliRenderFileTree(cliFileList);
        return;
    }

    // === テキストファイルの場合（従来の処理） ===
    cliHideImage();

    // 下書きチェック
    const draft = await cliGetDraft(path);
    if (draft) {
        const cached = await cliGetCachedFile(path);
        cliEditorInstance.setValue(draft.content);
        cliEnterEditMode(cached ? cached.content : '');
        cliHasUnsavedChanges = true;
        cliUpdateEditButtons();
        closeCliSidebar();
        setTimeout(() => cliEditorInstance.refresh(), 50);
        cliShowDraftBanner(draft.lastFetched);
        cliRenderFileTree(cliFileList);
        cliUpdateCharCount();
        updateStatus('📝 下書き復元', true);
        return;
    }

    // キャッシュから即表示
    const cached = await cliGetCachedFile(path);
    if (cached) {
        cliEditorInstance.setValue(cached.content);
    } else {
        cliEditorInstance.setValue('読み込み中...');
    }

    closeCliSidebar();
    setTimeout(() => cliEditorInstance.refresh(), 50);
    cliUpdateCharCount();

    // 【高速化】キャッシュがサーバーと同一世代なら、取りに行かずここで確定させる。
    // 複数ファイルを行き来する時の待ち時間がゼロになる。
    if (cliIsCacheFresh(path, cached)) {
        cliOriginalContent = cached.content;
        cliHasUnsavedChanges = false;
        cliPendingServerContent = null;
        cliUpdateEditButtons();
        cliRenderFileTree(cliFileList);
        updateStatus('表示完了（キャッシュ最新）', true);
        cliPrefetchSiblings(path);   // 待たずに裏で同フォルダを先読み
        return;
    }

    // サーバーから最新を取得
    const pass = await getAuthPassword();
    if (!pass) return;

    try {
        updateStatus('ファイル取得中...', false);
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_download&path=${encodeURIComponent(path)}`;
        const res = await fetch(url, { method: 'POST' });
        const json = await res.json();

        if (json.status === 'success') {
            let content = json.content;

            // 暗号化データの復号
            try {
                const parsed = JSON.parse(content);
                if (parsed && parsed.encrypted) {
                    const encKey = await getEncryptionKey();
                    if (!encKey) {
                        content = '[暗号化データ] 暗号キーを設定してください';
                    } else {
                        try {
                            content = await decryptData(parsed, encKey);
                        } catch (decErr) {
                            content = '[復号失敗] 暗号キーが正しいか確認してください';
                        }
                    }
                }
            } catch (parseErr) {
                // JSONでなければ平文としてそのまま使う
            }

            // 復号後にも画像JSONかチェック（拡張子に依らず画像データだった場合）
            const imageObj = cliTryParseImageContent(content);
            if (imageObj) {
                cliShowImage(imageObj);
                await cliSaveFileToCache(path, content, json.updatedAt);
                updateStatus('🖼️ 画像表示完了', true);
                cliRenderFileTree(cliFileList);
                return;
            }

            if (cached && cached.content === content) {
                cliOriginalContent = content;
                cliHasUnsavedChanges = false;
                cliUpdateEditButtons();
                await cliSaveFileToCache(path, content, json.updatedAt);
                updateStatus('取得完了', true);
            } else if (!cached) {
                cliEditorInstance.setValue(content);
                cliOriginalContent = content;
                cliHasUnsavedChanges = false;
                cliUpdateEditButtons();
                cliUpdateCharCount();
                await cliSaveFileToCache(path, content, json.updatedAt);
                updateStatus('取得完了', true);
            } else {
                cliPendingServerContent = content;
                await cliSaveFileToCache(path, content, json.updatedAt);
                cliShowUpdateBanner();
                updateStatus('📥 新バージョンあり', true);
            }
        } else {
            throw new Error(json.message);
        }
    } catch (e) {
        if (!cached) {
            cliEditorInstance.setValue('エラー: ' + e.message);
        }
        updateStatus('取得失敗', false, true);
    }

    cliRenderFileTree(cliFileList);
}

// =========================================
// ファイル削除
// =========================================

async function cliDeleteFile(path) {
    if (!confirm(`「${path}」を削除しますか？`)) return;

    const pass = await getAuthPassword();
    if (!pass) return;

    try {
        updateStatus('削除中...', false);
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_delete&path=${encodeURIComponent(path)}`;
        const res = await fetch(url, { method: 'POST' });
        const json = await res.json();

        if (json.status === 'success') {
            updateStatus('削除完了', true);
            if (cliCurrentFile === path) {
                cliCurrentFile = null;
                if (cliEditorInstance) cliEditorInstance.setValue('');
                document.getElementById('cli-current-filename').textContent = 'ファイルを選択';
            }
            await cliDeleteCachedFile(path);
            // ローカルのリストからも除去
            cliFileList = cliFileList.filter(f => f.path !== path);
            await cliSaveFileListToCache(cliFileList);
            cliRenderFileTree(cliFileList);
        } else {
            throw new Error(json.message);
        }
    } catch (e) {
        alert('削除失敗: ' + e.message);
        updateStatus('削除失敗', false, true);
    }
}

async function cliDeleteFolder(folderName, files) {
    if (!confirm(`「${folderName}」フォルダ内の${files.length}ファイルを全て削除しますか？`)) return;

    const pass = await getAuthPassword();
    if (!pass) return;

    try {
        updateStatus(`${folderName} 削除中...`, false);
        let deleted = 0;

        for (const f of files) {
            try {
                const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_delete&path=${encodeURIComponent(f.path)}`;
                const res = await fetch(url, { method: 'POST' });
                const json = await res.json();
                if (json.status === 'success') {
                    deleted++;
                    if (cliCurrentFile === f.path) {
                        cliCurrentFile = null;
                        if (cliEditorInstance) cliEditorInstance.setValue('');
                        document.getElementById('cli-current-filename').textContent = 'ファイルを選択';
                    }
                    await cliDeleteCachedFile(f.path);
                }
            } catch (_) {}
        }

        cliFileList = cliFileList.filter(f => {
            const folder = f.path.split('/').slice(0, -1).join('/');
            return folder !== folderName;
        });
        await cliSaveFileListToCache(cliFileList);
        cliRenderFileTree(cliFileList);

        updateStatus('削除完了', true);
        alert(`${deleted}件のファイルを削除しました`);
    } catch (e) {
        alert('フォルダ削除失敗: ' + e.message);
        updateStatus('削除失敗', false, true);
    }
}

async function cliDeleteAllFiles() {
    if (!confirm('CLIファイルを全て削除しますか？\n（この操作は取り消せません）')) return;

    const pass = await getAuthPassword();
    if (!pass) return;

    try {
        updateStatus('全削除中...', false);
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_delete&path=*`;
        const res = await fetch(url, { method: 'POST' });
        const json = await res.json();

        if (json.status === 'success') {
            updateStatus('全削除完了', true);
            cliCurrentFile = null;
            cliFileList = [];
            if (cliEditorInstance) cliEditorInstance.setValue('');
            document.getElementById('cli-current-filename').textContent = 'ファイルを選択';
            cliRenderFileTree([]);
            await cliSaveFileListToCache([]);
            // キャッシュもクリア
            await cliClearAllCache();
            alert(`${json.deletedCount}件のファイルを削除しました`);
        } else {
            throw new Error(json.message);
        }
    } catch (e) {
        alert('全削除失敗: ' + e.message);
        updateStatus('全削除失敗', false, true);
    }
}

// =========================================
// フォントサイズ変更
// =========================================

function cliChangeFontSize(delta) {
    cliFontSize += delta;
    if (cliFontSize < 10) cliFontSize = 10;
    if (cliFontSize > 60) cliFontSize = 60;

    if (cliEditorInstance) {
        cliEditorInstance.getWrapperElement().style.fontSize = cliFontSize + 'px';
        cliEditorInstance.refresh();
    }
    const preview = document.getElementById('cli-preview');
    if (preview) preview.style.fontSize = cliFontSize + 'px';
}

// =========================================
// 下部パネル（指示パッド / 提案）の開閉
// =========================================

function toggleCliMemoExpand() {
    cliMemoExpanded = !cliMemoExpanded;
    const body = document.getElementById('cli-memo-body');
    const btn = document.getElementById('cli-memo-toggle');

    if (cliMemoExpanded) {
        body.classList.remove('collapsed');
        btn.textContent = '▲';
    } else {
        body.classList.add('collapsed');
        btn.textContent = '▼';
    }

    // CodeMirrorのサイズを再計算
    if (cliEditorInstance) setTimeout(() => cliEditorInstance.refresh(), 100);
}

// =========================================
// IndexedDB キャッシュ操作
// =========================================

async function cliSaveFileToCache(path, content, serverModified) {
    if (!db) return;
    try {
        const tx = db.transaction([STORE_CLI_CACHE], 'readwrite');
        tx.objectStore(STORE_CLI_CACHE).put({
            path: path,
            content: content,
            lastFetched: Date.now(),
            serverModified: serverModified || null
        });
    } catch (e) { /* キャッシュ書き込み失敗は無視 */ }
}

async function cliGetCachedFile(path) {
    if (!db) return null;
    try {
        const tx = db.transaction([STORE_CLI_CACHE], 'readonly');
        const req = tx.objectStore(STORE_CLI_CACHE).get(path);
        return await new Promise(r => req.onsuccess = () => r(req.result));
    } catch (e) { return null; }
}

async function cliDeleteCachedFile(path) {
    if (!db) return;
    try {
        const tx = db.transaction([STORE_CLI_CACHE], 'readwrite');
        tx.objectStore(STORE_CLI_CACHE).delete(path);
    } catch (e) { /* 無視 */ }
}

async function cliClearAllCache() {
    if (!db) return;
    try {
        const tx = db.transaction([STORE_CLI_CACHE], 'readwrite');
        tx.objectStore(STORE_CLI_CACHE).clear();
    } catch (e) { /* 無視 */ }
}

// 保存済みのファイル一覧を読み出して即描画する。
// 戻り値: 使える一覧があったか（無ければ初回とみなしてサーバーから取る）
async function cliLoadCachedFileList() {
    if (!db) return false;
    try {
        // settingsストアから前回のファイルリストを取得
        const cached = await getSetting('cli_file_list_cache');
        const at = await getSetting('cli_file_list_cache_at');
        if (at) cliFileListFetchedAt = parseInt(at, 10) || null;
        if (cached) {
            const files = JSON.parse(cached);
            if (files && files.length > 0) {
                cliFileList = files;
                cliRenderFileTree(cliFileList);
                cliUpdateListMeta();
                return true;
            }
        }
    } catch (e) { /* キャッシュ読み込み失敗は無視 */ }
    cliUpdateListMeta();
    return false;
}

async function cliSaveFileListToCache(files) {
    try {
        await setSetting('cli_file_list_cache', JSON.stringify(files));
        if (cliFileListFetchedAt) {
            await setSetting('cli_file_list_cache_at', String(cliFileListFetchedAt));
        }
    } catch (e) { /* 無視 */ }
}

// =========================================
// 通信の省略と先読み（読み込み高速化）
// =========================================
//
// これまではファイルを開くたびに必ず cli_download を1往復していたため、
// 中身が変わっていなくてもGAS起動の固定費（1.5〜3秒）を毎回払っていた。
// cli_list が全ファイルの updatedAt を返してくれるので、
// それとキャッシュの serverModified を突き合わせれば「取りに行く必要があるか」が判定できる。

/** cli_listの結果から、そのパスのサーバー側更新時刻を引く */
function cliRemoteUpdatedAt(path) {
    if (!Array.isArray(cliFileList)) return null;
    const hit = cliFileList.find(f => f.path === path);
    return hit ? (hit.updatedAt || null) : null;
}

/** キャッシュがサーバーと同一世代か（＝ダウンロード不要か） */
function cliIsCacheFresh(path, cached) {
    if (!cached || !cached.serverModified) return false;
    if (!cliFileListFresh) return false;   // 一覧がこのセッションで未取得なら信用しない
    const remote = cliRemoteUpdatedAt(path);
    if (!remote) return false;           // 一覧が未取得なら安全側に倒して取りに行く
    return cached.serverModified === remote;
}

// --- GASの世代判定（バッチAPIが使えるか） ---
// 重要: 旧版GASに対して body付きで未知のactionを投げると、
// Canvasボードの保存処理に落ちて creative_board_default.json を壊す危険がある。
// cli_capabilities は body無しで投げるため旧版でも副作用が無く、プローブとして安全。
let cliGasVersion = null;

async function cliEnsureGasVersion() {
    if (cliGasVersion !== null) return cliGasVersion;
    const pass = await getAuthPassword();
    if (!pass) return 1;
    try {
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_capabilities`;
        const res = await fetch(url, { method: 'POST' });
        const json = await res.json();
        cliGasVersion = (json && json.version) ? json.version : 1;
    } catch (e) {
        cliGasVersion = 1;
    }
    return cliGasVersion;
}

/**
 * 同じフォルダの兄弟ファイルを1リクエストでまとめて先読みしてキャッシュに入れる。
 * 失敗しても表示には影響しないので、エラーは握りつぶしてよい（あくまで先読み）。
 */
async function cliPrefetchSiblings(path) {
    try {
        // 一覧がこのセッションで未取得だと更新判定ができず、
        // 先読みしてもキャッシュを信用できない（＝無駄打ち）ので何もしない
        if (!cliFileListFresh) return;
        if (await cliEnsureGasVersion() < 2) return;
        if (!Array.isArray(cliFileList)) return;

        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
        const siblings = cliFileList
            .filter(f => f.path !== path)
            .filter(f => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '') === dir)
            .filter(f => !cliIsImagePath(f.path));   // 画像は重いので先読みしない

        const stale = [];
        for (const f of siblings) {
            const cached = await cliGetCachedFile(f.path);
            if (!cliIsCacheFresh(f.path, cached)) stale.push(f.path);
            if (stale.length >= CLI_PREFETCH_LIMIT) break;
        }
        if (stale.length === 0) return;

        const pass = await getAuthPassword();
        if (!pass) return;

        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_download_batch`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ paths: stale })
        });
        const json = await res.json();
        if (!json || json.status !== 'success') return;

        const encKey = await getEncryptionKey();
        for (const f of (json.files || [])) {
            let content = f.content;
            try {
                const parsed = JSON.parse(content);
                if (parsed && parsed.encrypted) {
                    if (!encKey) continue;
                    content = await decryptData(parsed, encKey);
                }
            } catch (_) { /* 平文ならそのまま */ }
            await cliSaveFileToCache(f.path, content, f.updatedAt);
        }
    } catch (e) { /* 先読みの失敗は無視 */ }
}

// =========================================
// 編集モード制御
// =========================================

/**
 * 編集モードのON/OFF切替
 * ONにするとCodeMirrorが編集可能になり、保存ボタンが現れる
 */
function toggleCliEditMode() {
    if (!cliCurrentFile) {
        alert('先にファイルを開いてください');
        return;
    }
    if (cliImageMode) {
        alert('画像ファイルは編集できません');
        return;
    }
    if (cliEditMode) {
        // 編集モード終了
        if (cliHasUnsavedChanges) {
            if (!confirm('未保存の変更があります。破棄しますか？')) return;
        }
        cliExitEditMode(true);
    } else {
        // 整形表示中なら原文に戻してから編集を始める（整形表示は閲覧専用のため）
        if (cliPreviewMode) {
            const anchorLine = cliPreviewTopLine();
            cliSetPreviewMode(false);
            // 見ていた場所にカーソルを置く。
            // これをやらないと cliEnterEditMode() の focus() で先頭へ飛んでしまう
            const max = Math.max(0, cliEditorInstance.lineCount() - 1);
            cliEditorInstance.setCursor({ line: Math.max(0, Math.min(anchorLine, max)), ch: 0 });
        }
        // 編集モード開始
        cliEnterEditMode();
    }
}

function cliEnterEditMode(overrideOriginal = null) {
    cliEditMode = true;
    cliOriginalContent = overrideOriginal !== null ? overrideOriginal : cliEditorInstance.getValue();
    cliHasUnsavedChanges = false;

    // CodeMirrorを編集可能にする
    cliEditorInstance.setOption('readOnly', false);

    // 変更検知リスナーを追加
    cliEditorInstance.on('change', cliOnEditorChange);

    // ビジュアルフィードバック
    document.getElementById('cli-viewer').classList.add('cli-edit-mode');
    cliUpdateEditButtons();
    updateStatus('✏️ 編集モード', true);

    // カーソルをエディタに合わせる
    cliEditorInstance.focus();
}

function cliExitEditMode(clearDraft = false) {
    cliEditMode = false;
    cliHasUnsavedChanges = false;

    // 下書きを消す（ユーザーが明示的に破棄した場合）
    if (clearDraft && cliCurrentFile) {
        cliClearDraft(cliCurrentFile);
    }

    // CodeMirrorをreadOnlyに戻す
    cliEditorInstance.setOption('readOnly', true);

    // 変更検知リスナーを解除
    cliEditorInstance.off('change', cliOnEditorChange);

    // ビジュアルフィードバック
    document.getElementById('cli-viewer').classList.remove('cli-edit-mode');
    cliUpdateEditButtons();
    updateStatus('Ready', true);
}

function cliOnEditorChange() {
    const currentText = cliEditorInstance.getValue();
    cliHasUnsavedChanges = (currentText !== cliOriginalContent);
    cliUpdateEditButtons();
    cliUpdateCharCount();

    // IndexedDBへ下書き自動保存
    if (cliEditMode && cliCurrentFile) {
        if (cliDraftSaveTimer) clearTimeout(cliDraftSaveTimer);
        if (cliHasUnsavedChanges) {
            cliDraftSaveTimer = setTimeout(() => {
                cliSaveDraft(cliCurrentFile, currentText);
            }, 1000);  // 作業場（付箋）の自動保存と同じ1秒に統一
        } else {
            // 元に戻った場合、下書きを消す
            cliClearDraft(cliCurrentFile);
        }
    }
}

/**
 * 編集ボタン・保存ボタンの表示状態を更新
 */
function cliUpdateEditButtons() {
    const editBtn = document.getElementById('cli-btn-edit');
    const saveBtn = document.getElementById('cli-btn-save');
    if (!editBtn || !saveBtn) return;

    if (cliEditMode) {
        editBtn.textContent = '📖 閲覧';
        editBtn.classList.add('btn-active');
        saveBtn.style.display = 'inline-block';
        saveBtn.disabled = !cliHasUnsavedChanges;
        // 未保存がある場合は保存ボタンを強調
        if (cliHasUnsavedChanges) {
            saveBtn.classList.add('cli-save-pulse');
        } else {
            saveBtn.classList.remove('cli-save-pulse');
        }
    } else {
        editBtn.textContent = '📝 編集';
        editBtn.classList.remove('btn-active');
        saveBtn.style.display = 'none';
    }
}

/**
 * 編集したファイルをGASに保存（暗号化→cli_upload）
 */
async function cliSaveFile() {
    if (!cliCurrentFile) return;
    if (!cliEditMode) return;

    const content = cliEditorInstance.getValue();

    // 内容に変更がなければスキップ
    if (content === cliOriginalContent) {
        alert('変更がありません');
        return;
    }

    const pass = await getAuthPassword();
    if (!pass) return;

    // 暗号化処理
    let body = content;
    const encKey = await getEncryptionKey();
    if (encKey) {
        try {
            const encObj = await encryptData(content, encKey);
            body = JSON.stringify({ encrypted: true, ...encObj });
        } catch (encErr) {
            alert('暗号化に失敗しました: ' + encErr.message);
            return;
        }
    }

    try {
        updateStatus('💾 保存中...', false);
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_upload&path=${encodeURIComponent(cliCurrentFile)}`;
        const res = await fetch(url, {
            method: 'POST',
            body: body
        });
        const json = await res.json();

        if (json.status === 'success') {
            // 成功: 元テキストを更新して変更フラグをクリア
            cliOriginalContent = content;
            cliHasUnsavedChanges = false;
            cliUpdateEditButtons();

            // キャッシュも更新
            await cliSaveFileToCache(cliCurrentFile, content, new Date().toISOString());

            // 下書きを消す（GASに保存できたので不要）
            await cliClearDraft(cliCurrentFile);
            cliDismissDraftBanner();

            updateStatus('✅ 保存完了', true);
            showCliSaveToast();
        } else {
            throw new Error(json.message);
        }
    } catch (e) {
        alert('保存失敗: ' + e.message);
        updateStatus('保存失敗', false, true);
    }
}

/**
 * 保存完了トースト通知
 */
function showCliSaveToast() {
    const existing = document.querySelector('.cli-save-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'cli-save-toast';
    toast.textContent = '✅ 保存しました — CLIから pull で取得できます';
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

// =========================================
// タブ切替（指示パッド / 提案）
// =========================================

function cliSwitchTab(tabName) {
    cliActiveTab = tabName;

    // タブボタンの状態更新
    document.querySelectorAll('.cli-memo-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // コンテンツの表示切替
    document.getElementById('cli-tab-instruction').classList.toggle('active', tabName === 'instruction');
    document.getElementById('cli-tab-proposals').classList.toggle('active', tabName === 'proposals');

    // 提案タブ初回表示時に自動読み込み
    if (tabName === 'proposals' && !cliProposalsLoaded) {
        cliRefreshProposals();
    }

    // CodeMirrorのサイズ再計算
    if (cliEditorInstance) setTimeout(() => cliEditorInstance.refresh(), 100);
}

// =========================================
// 指示パッド機能
// =========================================

async function cliCopyInstruction() {
    const textarea = document.getElementById('cli-instruction-content');
    const text = textarea.value.trim();

    // キーボード（Ctrl+Enter）からも呼ばれるので、空の時はダイアログではなくトーストで返す
    if (!text) {
        updateStatus('📋 指示パッドが空です', true);
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        showCliCopyToast();
    } catch (e) {
        // フォールバック: execCommand
        textarea.select();
        document.execCommand('copy');
        showCliCopyToast();
    }
}

function cliClearInstruction() {
    const textarea = document.getElementById('cli-instruction-content');
    if (textarea.value.trim() && !confirm('指示パッドの内容を消去しますか？')) return;
    textarea.value = '';
    cliSaveInstructionDraft();  // 空になった状態をlocalStorageへも反映
}

// =========================================
// 指示パッドの自動保存・復元（localStorage）
// ブラウザのフォーム自動復元に頼らず、指示パッドの内容だけを
// 明示的に保存する。別画面を介した指示出しでも内容が残る。
// =========================================

const CLI_INSTRUCTION_DRAFT_KEY = 'cli_instruction_draft';

// 現在の指示パッドの内容をlocalStorageへ保存
function cliSaveInstructionDraft() {
    try {
        const textarea = document.getElementById('cli-instruction-content');
        if (!textarea) return;
        localStorage.setItem(CLI_INSTRUCTION_DRAFT_KEY, textarea.value);
    } catch (e) { /* 保存失敗は無視 */ }
}

// 変更のたびにデバウンスして保存（作業場・CLI本文と同じ1秒）
function cliScheduleInstructionSave() {
    if (cliInstructionSaveTimer) clearTimeout(cliInstructionSaveTimer);
    cliInstructionSaveTimer = setTimeout(cliSaveInstructionDraft, 1000);
}

// localStorageから指示パッドの内容を復元
function cliRestoreInstructionDraft() {
    try {
        const textarea = document.getElementById('cli-instruction-content');
        if (!textarea) return;
        const saved = localStorage.getItem(CLI_INSTRUCTION_DRAFT_KEY);
        if (saved !== null) textarea.value = saved;
    } catch (e) { /* 復元失敗は無視 */ }
}

// 自動保存のセットアップ（初回初期化時のみ：復元＋入力リスナー登録）
function cliSetupInstructionAutosave() {
    const textarea = document.getElementById('cli-instruction-content');
    if (!textarea) return;
    cliRestoreInstructionDraft();
    // キーボード入力はデバウンス保存（挿入系はvalue直接書換のため各所で明示保存する）
    textarea.addEventListener('input', cliScheduleInstructionSave);
}

// --- カーソル位置への共通挿入ヘルパー ---
function cliInsertIntoInstruction(text) {
    const textarea = document.getElementById('cli-instruction-content');
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;

    // 直前に文字があり、改行で終わっていなければ改行を挟んで見やすくする
    let insert = text;
    const before = val.substring(0, start);
    if (before.length > 0 && !before.endsWith('\n')) {
        insert = '\n' + insert;
    }

    textarea.value = before + insert + val.substring(end);
    const pos = start + insert.length;
    textarea.selectionStart = textarea.selectionEnd = pos;
    cliSaveInstructionDraft();  // 挿入はinputイベントが出ないので明示保存
    setTimeout(() => textarea.focus(), 50);
}

// --- 今開いているファイルのパスを挿入 ---
function cliInsertCurrentPath() {
    if (!cliCurrentFile) {
        updateStatus('先にファイルを開いてください', true);
        return;
    }
    cliInsertIntoInstruction(cliCurrentFile);
    fbShowInsertToast(cliCurrentFile);
}

// =========================================
// 指示テンプレート管理（localStorageに保存）
// =========================================

const CLI_TEMPLATE_KEY = 'cli_instruction_templates';

// 既定テンプレ（初回のみ投入）
const CLI_DEFAULT_TEMPLATES = [
    '上記ファイルを読んで、内容を把握してください。',
    '以下の指示に従って修正してください：\n・',
    '誤字脱字・表現の不自然な箇所をチェックして、修正案を出してください。'
];

function cliGetTemplates() {
    try {
        const raw = localStorage.getItem(CLI_TEMPLATE_KEY);
        if (raw === null) {
            // 初回：既定テンプレを保存して返す
            localStorage.setItem(CLI_TEMPLATE_KEY, JSON.stringify(CLI_DEFAULT_TEMPLATES));
            return [...CLI_DEFAULT_TEMPLATES];
        }
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }
}

function cliSaveTemplates(arr) {
    try {
        localStorage.setItem(CLI_TEMPLATE_KEY, JSON.stringify(arr));
    } catch (e) {
        alert('テンプレの保存に失敗しました: ' + e.message);
    }
}

// ポップの開閉
function cliToggleTemplatePopup() {
    const popup = document.getElementById('cli-template-popup');
    if (!popup) return;
    const willShow = (popup.style.display === 'none' || popup.style.display === '');
    popup.style.display = willShow ? 'flex' : 'none';
    if (willShow) cliRenderTemplates();
}

// テンプレ一覧の描画
function cliRenderTemplates() {
    const listEl = document.getElementById('cli-template-list');
    if (!listEl) return;

    const templates = cliGetTemplates();
    listEl.innerHTML = '';

    if (templates.length === 0) {
        listEl.innerHTML = '<div class="cli-template-empty">テンプレがありません。下で登録してください。</div>';
        return;
    }

    templates.forEach((tpl, idx) => {
        const row = document.createElement('div');
        row.className = 'cli-template-item';

        const insertBtn = document.createElement('button');
        insertBtn.className = 'tmpl-insert';
        insertBtn.textContent = tpl;
        insertBtn.title = 'クリックで指示パッドに挿入';
        insertBtn.addEventListener('click', () => cliInsertTemplate(idx));

        const delBtn = document.createElement('button');
        delBtn.className = 'tmpl-del';
        delBtn.textContent = '🗑️';
        delBtn.title = 'このテンプレを削除';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            cliDeleteTemplate(idx);
        });

        row.appendChild(insertBtn);
        row.appendChild(delBtn);
        listEl.appendChild(row);
    });
}

// テンプレを指示パッドへ挿入
function cliInsertTemplate(idx) {
    const templates = cliGetTemplates();
    const tpl = templates[idx];
    if (tpl === undefined) return;
    cliInsertIntoInstruction(tpl);
    cliToggleTemplatePopup(); // 挿入したら閉じる
}

// 入力欄から新規登録
function cliRegisterTemplate() {
    const input = document.getElementById('cli-template-input');
    const text = input.value.trim();
    if (!text) {
        alert('登録するテンプレ文を入力してください。');
        return;
    }
    const templates = cliGetTemplates();
    templates.push(text);
    cliSaveTemplates(templates);
    input.value = '';
    cliRenderTemplates();
}

// 指示パッドの現在内容をテンプレ登録
function cliRegisterTemplateFromInstruction() {
    const text = document.getElementById('cli-instruction-content').value.trim();
    if (!text) {
        alert('指示パッドが空です。');
        return;
    }
    const templates = cliGetTemplates();
    templates.push(text);
    cliSaveTemplates(templates);
    cliRenderTemplates();
}

// テンプレ削除
function cliDeleteTemplate(idx) {
    const templates = cliGetTemplates();
    if (templates[idx] === undefined) return;
    const preview = templates[idx].length > 20 ? templates[idx].slice(0, 20) + '…' : templates[idx];
    if (!confirm(`このテンプレを削除しますか？\n\n「${preview}」`)) return;
    templates.splice(idx, 1);
    cliSaveTemplates(templates);
    cliRenderTemplates();
}

function showCliCopyToast() {
    const existing = document.querySelector('.cli-copy-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'cli-copy-toast';
    toast.textContent = '📋 クリップボードにコピーしました';
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

// =========================================
// フォルダツリーブラウザ
// =========================================

let fbTreeData = null;      // ツリーデータ（IndexedDBに保存し、再訪時も即表示できるようにする）
let fbTreeFlat = [];        // フラット化したリスト（検索用）
let fbTreeFetchedAt = null; // ツリーを最後にサーバーから取得した時刻（表示用）
let fbCacheLoaded = false;  // IndexedDBからの読み出しを試したか

// パス挿入のフォルダ構造はPC側で push-tree した時にしか変わらないので、
// モーダルを開くたびにGASへ取りに行かず、保存済みのものを即出す。
// 取り直しはモーダル内の「🔄 更新」ボタンだけ。
async function cliOpenFolderBrowser() {
    const modal = document.getElementById('folderBrowserModal');
    modal.classList.add('show');

    const treeEl = document.getElementById('folder-browser-tree');
    const searchEl = document.getElementById('folder-browser-search');
    searchEl.value = '';

    // 初回だけIndexedDBから読み出す（2回目以降はメモリ上のものをそのまま使う）
    if (!fbTreeData && !fbCacheLoaded) await fbLoadCachedTree();

    if (fbTreeData) {
        fbRenderTree(fbTreeData.tree, treeEl);
        fbUpdateTreeMeta();
        return;   // ここでは通信しない
    }

    // 保存されたものが無い初回だけサーバーから取ってくる
    treeEl.innerHTML = '<div style="text-align:center; color:#718096; padding:20px;">📡 フォルダ構造を取得中...</div>';
    await fbFetchTree();
}

function closeFolderBrowser() {
    document.getElementById('folderBrowserModal').classList.remove('show');
}

// 保存済みのフォルダ構造を読み出す（GASには繋がない）
async function fbLoadCachedTree() {
    fbCacheLoaded = true;
    try {
        const cached = await getSetting('cli_folder_tree_cache');
        const at = await getSetting('cli_folder_tree_cache_at');
        if (at) fbTreeFetchedAt = parseInt(at, 10) || null;
        if (cached) {
            const data = JSON.parse(cached);
            if (data && data.tree) {
                fbTreeData = data;
                fbTreeFlat = fbFlattenTree(fbTreeData.tree);
                return true;
            }
        }
    } catch (_) { /* 読み出し失敗は無視（サーバーから取り直せる） */ }
    return false;
}

async function fbSaveCachedTree(data) {
    try {
        await setSetting('cli_folder_tree_cache', JSON.stringify(data));
        if (fbTreeFetchedAt) {
            await setSetting('cli_folder_tree_cache_at', String(fbTreeFetchedAt));
        }
    } catch (_) { /* 無視 */ }
}

// フォルダ構造をいつ取り直したかをモーダル下部に出す
function fbUpdateTreeMeta() {
    const el = document.getElementById('fb-tree-meta');
    if (!el) return;
    if (!fbTreeFetchedAt) { el.textContent = '構造: 未取得'; return; }
    const d = new Date(fbTreeFetchedAt);
    const sameDay = (new Date().toDateString() === d.toDateString());
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    el.textContent = '構造: ' + (sameDay ? hhmm : `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`) + ' 取得';
}

// 「🔄 更新」ボタン専用。ここでだけGASに繋いでフォルダ構造を取り直す
async function fbFetchTree() {
    const pass = await getAuthPassword();
    if (!pass) return;

    const treeEl = document.getElementById('folder-browser-tree');
    const btn = document.getElementById('fb-btn-refresh');
    if (btn) { btn.disabled = true; btn.textContent = '🔄 更新中...'; }

    try {
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_download&path=${encodeURIComponent('_system/folder_tree.json')}`;
        const res = await fetch(url, { method: 'POST' });
        const json = await res.json();

        if (json.status === 'success') {
            let content = json.content;

            // 暗号化データの復号
            try {
                const parsed = JSON.parse(content);
                if (parsed && parsed.encrypted) {
                    const encKey = await getEncryptionKey();
                    if (encKey) {
                        content = await decryptData(parsed, encKey);
                    } else {
                        treeEl.innerHTML = '<div class="fb-no-results">🔐 暗号キーを設定してください</div>';
                        return;
                    }
                }
            } catch (_) {}

            const newData = JSON.parse(content);
            const unchanged = (fbTreeData && JSON.stringify(fbTreeData.tree) === JSON.stringify(newData.tree));

            fbTreeFetchedAt = Date.now();
            fbTreeData = newData;
            fbTreeFlat = fbFlattenTree(fbTreeData.tree);
            await fbSaveCachedTree(fbTreeData);
            fbUpdateTreeMeta();

            // 中身が同じなら再描画しない（フォルダの展開状態を畳み直さないため）
            if (unchanged) {
                updateStatus('フォルダ構造は最新です', true);
                return;
            }

            // 絞り込み中に更新すると検索語と表示がずれるので、検索欄を空に戻す
            const searchEl = document.getElementById('folder-browser-search');
            if (searchEl) searchEl.value = '';
            fbRenderTree(fbTreeData.tree, treeEl);
            updateStatus('フォルダ構造を更新', true);
        } else {
            treeEl.innerHTML = '<div class="fb-no-results">フォルダ構造がまだアップロードされていません<br><span style="font-size:0.75rem;">PC側で push-tree を実行してください</span></div>';
        }
    } catch (e) {
        treeEl.innerHTML = `<div class="fb-no-results">取得エラー: ${e.message}</div>`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 更新'; }
    }
}

function fbFlattenTree(items, result = []) {
    for (const item of items) {
        result.push(item);
        if (item.children) {
            fbFlattenTree(item.children, result);
        }
    }
    return result;
}

function fbRenderTree(items, container) {
    container.innerHTML = '';
    if (!items || items.length === 0) {
        container.innerHTML = '<div class="fb-no-results">フォルダが空です</div>';
        return;
    }
    items.forEach(item => {
        container.appendChild(fbCreateNode(item));
    });
}

function fbCreateNode(item) {
    const wrapper = document.createElement('div');

    if (item.type === 'dir') {
        // フォルダ行
        const row = document.createElement('div');
        row.className = 'fb-item fb-dir';

        const arrow = document.createElement('span');
        arrow.className = 'fb-item-arrow';
        arrow.textContent = '▶';

        const icon = document.createElement('span');
        icon.className = 'fb-item-icon';
        icon.textContent = '📁';

        const name = document.createElement('span');
        name.className = 'fb-item-name';
        name.textContent = item.name;

        const hint = document.createElement('span');
        hint.className = 'fb-insert-hint';
        hint.textContent = '挿入';

        row.appendChild(arrow);
        row.appendChild(icon);
        row.appendChild(name);
        row.appendChild(hint);

        // 子要素コンテナ
        const childContainer = document.createElement('div');
        childContainer.className = 'fb-children';

        if (item.children && item.children.length > 0) {
            item.children.forEach(child => {
                childContainer.appendChild(fbCreateNode(child));
            });
        }

        // フォルダクリック: 展開/折りたたみ + 長押しでパス挿入
        let tapTimer = null;
        let tapped = false;

        row.addEventListener('click', (e) => {
            e.stopPropagation();
            // 展開/折りたたみ
            const isOpen = childContainer.classList.contains('open');
            childContainer.classList.toggle('open');
            arrow.classList.toggle('open');
            icon.textContent = childContainer.classList.contains('open') ? '📂' : '📁';
        });

        // パス挿入はhintボタンをタップ
        hint.addEventListener('click', (e) => {
            e.stopPropagation();
            fbInsertPath(item.path);
        });

        wrapper.appendChild(row);
        wrapper.appendChild(childContainer);
    } else {
        // ファイル行
        const row = document.createElement('div');
        row.className = 'fb-item fb-file';

        const icon = document.createElement('span');
        icon.className = 'fb-item-icon';
        icon.textContent = '📄';

        const name = document.createElement('span');
        name.className = 'fb-item-name';
        name.textContent = item.name;

        const hint = document.createElement('span');
        hint.className = 'fb-insert-hint';
        hint.textContent = '挿入';

        row.appendChild(icon);
        row.appendChild(name);
        row.appendChild(hint);

        row.addEventListener('click', (e) => {
            e.stopPropagation();
            fbInsertPath(item.path);
        });

        wrapper.appendChild(row);
    }

    return wrapper;
}

function fbInsertPath(path) {
    const textarea = document.getElementById('cli-instruction-content');

    // カーソル位置にパスを挿入
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const insert = path;

    textarea.value = text.substring(0, start) + insert + text.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + insert.length;
    cliSaveInstructionDraft();  // 挿入はinputイベントが出ないので明示保存

    // モーダルを閉じる
    closeFolderBrowser();

    // トースト表示
    fbShowInsertToast(path);

    // 指示パッドにフォーカス
    setTimeout(() => textarea.focus(), 100);
}

function fbShowInsertToast(path) {
    const existing = document.querySelector('.fb-inserted-toast');
    if (existing) existing.remove();

    const displayPath = path.length > 40 ? '...' + path.slice(-37) : path;

    const toast = document.createElement('div');
    toast.className = 'fb-inserted-toast';
    toast.textContent = `📂 ${displayPath} を挿入しました`;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

// 検索フィルター
function cliFolderSearch(query) {
    const treeEl = document.getElementById('folder-browser-tree');
    query = query.trim().toLowerCase();

    if (!fbTreeData) return;

    if (!query) {
        fbRenderTree(fbTreeData.tree, treeEl);
        return;
    }

    // フラットリストから検索
    const matches = fbTreeFlat.filter(item =>
        item.name.toLowerCase().includes(query) ||
        item.path.toLowerCase().includes(query)
    );

    treeEl.innerHTML = '';

    if (matches.length === 0) {
        treeEl.innerHTML = '<div class="fb-no-results">一致するパスがありません</div>';
        return;
    }

    // 検索結果をフラットに表示
    matches.forEach(item => {
        const row = document.createElement('div');
        row.className = 'fb-item ' + (item.type === 'dir' ? 'fb-dir' : 'fb-file');

        const icon = document.createElement('span');
        icon.className = 'fb-item-icon';
        icon.textContent = item.type === 'dir' ? '📂' : '📄';

        const nameWrap = document.createElement('div');
        nameWrap.style.cssText = 'flex:1; overflow:hidden;';

        const name = document.createElement('div');
        name.className = 'fb-item-name';
        name.textContent = item.name;

        const pathPreview = document.createElement('div');
        pathPreview.className = 'fb-path-preview';
        pathPreview.textContent = item.path;

        nameWrap.appendChild(name);
        nameWrap.appendChild(pathPreview);

        row.appendChild(icon);
        row.appendChild(nameWrap);

        row.addEventListener('click', () => fbInsertPath(item.path));

        treeEl.appendChild(row);
    });
}

// =========================================
// IndexedDB 下書き自動保存
// =========================================

async function cliSaveDraft(path, content) {
    if (!db) return;
    try {
        const tx = db.transaction([STORE_CLI_CACHE], 'readwrite');
        tx.objectStore(STORE_CLI_CACHE).put({
            path: `draft:${path}`,
            content: content,
            lastFetched: Date.now(),
            serverModified: null
        });
    } catch (e) { /* 下書き保存失敗は無視 */ }
}

async function cliGetDraft(path) {
    if (!db) return null;
    try {
        const tx = db.transaction([STORE_CLI_CACHE], 'readonly');
        const req = tx.objectStore(STORE_CLI_CACHE).get(`draft:${path}`);
        return await new Promise(r => req.onsuccess = () => r(req.result));
    } catch (e) { return null; }
}

async function cliClearDraft(path) {
    if (!db) return;
    try {
        const tx = db.transaction([STORE_CLI_CACHE], 'readwrite');
        tx.objectStore(STORE_CLI_CACHE).delete(`draft:${path}`);
    } catch (e) { /* 無視 */ }
}

// =========================================
// 下書きバナー制御
// =========================================

function cliShowDraftBanner(savedTimestamp) {
    const banner = document.getElementById('cli-draft-banner');
    const text = document.getElementById('cli-draft-banner-text');
    const time = new Date(savedTimestamp).toLocaleString('ja-JP');
    text.textContent = `📝 下書きを復元しました（${time}保存）`;
    banner.style.display = 'flex';
}

function cliDismissDraftBanner() {
    const banner = document.getElementById('cli-draft-banner');
    if (banner) banner.style.display = 'none';
}

async function cliDiscardDraftAndRefresh() {
    if (!cliCurrentFile) return;
    if (!confirm('下書きを破棄してサーバーから最新版を取得しますか？')) return;

    // 下書きを消す
    await cliClearDraft(cliCurrentFile);
    cliDismissDraftBanner();

    // 編集モード解除
    if (cliEditMode) cliExitEditMode(false);

    // サーバーから再取得
    const pass = await getAuthPassword();
    if (!pass) return;

    try {
        updateStatus('ファイル取得中...', false);
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_download&path=${encodeURIComponent(cliCurrentFile)}`;
        const res = await fetch(url, { method: 'POST' });
        const json = await res.json();

        if (json.status === 'success') {
            let content = json.content;

            try {
                const parsed = JSON.parse(content);
                if (parsed && parsed.encrypted) {
                    const encKey = await getEncryptionKey();
                    if (!encKey) {
                        content = '[暗号化データ] 暗号キーを設定してください';
                    } else {
                        try {
                            content = await decryptData(parsed, encKey);
                        } catch (decErr) {
                            content = '[復号失敗] 暗号キーが正しいか確認してください';
                        }
                    }
                }
            } catch (parseErr) { }

            cliEditorInstance.setValue(content);
            cliOriginalContent = content;
            cliHasUnsavedChanges = false;
            cliUpdateEditButtons();
            cliUpdateCharCount();
            await cliSaveFileToCache(cliCurrentFile, content, json.updatedAt);
            updateStatus('✅ サーバー版に戻しました', true);
        } else {
            throw new Error(json.message);
        }
    } catch (e) {
        alert('取得失敗: ' + e.message);
        updateStatus('取得失敗', false, true);
    }
}

// =========================================
// 文字数カウント
// =========================================

/**
 * 文字数バッジを更新する
 * エディタの内容から文字数を計算し、バッジに表示する
 */
function cliUpdateCharCount() {
    const badge = document.getElementById('cli-charcount-badge');
    if (!badge || !cliEditorInstance) return;

    if (!cliCurrentFile) {
        badge.style.display = 'none';
        return;
    }

    const text = cliEditorInstance.getValue();
    const charCount = text.length;

    // 読みやすい形式に変換（1000以上はK表記）
    let displayText;
    if (charCount >= 10000) {
        displayText = (charCount / 1000).toFixed(1) + 'K字';
    } else {
        displayText = charCount.toLocaleString() + '字';
    }

    // 範囲選択中は選択文字数を先頭に表示
    if (cliEditorInstance.somethingSelected()) {
        displayText = '選択 ' + cliEditorInstance.getSelection().length.toLocaleString() + ' / ' + displayText;
    }

    badge.textContent = displayText;
    badge.style.display = 'inline-block';
}

/**
 * 文字数の詳細をトースト表示する
 */
function cliShowCharCountDetail() {
    if (!cliEditorInstance || !cliCurrentFile) return;

    const text = cliEditorInstance.getValue();
    const lines = cliEditorInstance.lineCount();
    const totalChars = text.length;
    // 空白・改行を除いた文字数
    const noSpaceChars = text.replace(/[\s\n\r\t　]/g, '').length;

    // 既存のトーストを削除
    const existing = document.querySelector('.cli-charcount-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'cli-charcount-toast';
    toast.innerHTML = `
        <span class="charcount-label">行数</span> <span class="charcount-value">${lines.toLocaleString()}</span>　
        <span class="charcount-label">文字数</span> <span class="charcount-value">${totalChars.toLocaleString()}</span>　
        <span class="charcount-label">空白除</span> <span class="charcount-value">${noSpaceChars.toLocaleString()}</span>
    `;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// =========================================
// 更新通知バナー制御
// =========================================

function cliShowUpdateBanner() {
    const banner = document.getElementById('cli-update-banner');
    if (banner) banner.style.display = 'flex';
}

function cliDismissUpdateBanner() {
    const banner = document.getElementById('cli-update-banner');
    if (banner) banner.style.display = 'none';
    cliPendingServerContent = null;
}

function cliApplyServerUpdate() {
    if (!cliPendingServerContent || !cliEditorInstance) return;

    // 編集中は確認ダイアログ
    if (cliEditMode) {
        if (!confirm('編集中の内容がサーバー版に置き換わります。よろしいですか？')) return;
    }

    const scrollInfo = cliEditorInstance.getScrollInfo();
    cliEditorInstance.setValue(cliPendingServerContent);
    cliOriginalContent = cliPendingServerContent;
    cliHasUnsavedChanges = false;
    cliUpdateEditButtons();
    cliUpdateCharCount();
    cliEditorInstance.scrollTo(scrollInfo.left, scrollInfo.top);
    cliPendingServerContent = null;
    cliDismissUpdateBanner();
    updateStatus('✅ 最新版に更新', true);
}

// =========================================
// ヘッダーの🔄。開いているファイルの中身だけを取り直す
// （ファイル一覧はサイドバーの「🔄 一覧を更新」が担当）
// =========================================

async function cliRefreshCurrentFile() {
    if (!cliEditorInstance) return;
    if (!cliCurrentFile) {
        updateStatus('ファイルが開かれていません', true);
        return;
    }

    const pass = await getAuthPassword();
    if (!pass) return;

    try {
        updateStatus('ファイル再取得中...', false);
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_download&path=${encodeURIComponent(cliCurrentFile)}`;
        const res = await fetch(url, { method: 'POST' });
        const json = await res.json();

        if (json.status === 'success') {
            let content = json.content;

            try {
                const parsed = JSON.parse(content);
                if (parsed && parsed.encrypted) {
                    const encKey = await getEncryptionKey();
                    if (!encKey) return;
                    try {
                        content = await decryptData(parsed, encKey);
                    } catch (_) { return; }
                }
            } catch (_) { }

            const currentContent = cliEditorInstance.getValue();
            if (currentContent === content) {
                await cliSaveFileToCache(cliCurrentFile, content, json.updatedAt);
                updateStatus('最新版です', true);
                return;
            }

            if (cliEditMode) {
                // 編集中 → バナーで通知のみ（直接上書きしない）
                cliPendingServerContent = content;
                await cliSaveFileToCache(cliCurrentFile, content, json.updatedAt);
                cliShowUpdateBanner();
                updateStatus('📥 新バージョンあり', true);
            } else {
                // 閲覧中 → スクロール位置を保持しつつ直接更新
                const scrollInfo = cliEditorInstance.getScrollInfo();
                cliEditorInstance.setValue(content);
                cliOriginalContent = content;
                cliHasUnsavedChanges = false;
                cliUpdateEditButtons();
                cliUpdateCharCount();
                cliEditorInstance.scrollTo(scrollInfo.left, scrollInfo.top);
                await cliSaveFileToCache(cliCurrentFile, content, json.updatedAt);
                cliPendingServerContent = null;
                cliDismissUpdateBanner();
                updateStatus('✅ ファイル内容を更新', true);
            }
        }
    } catch (e) {
        updateStatus('ファイル取得失敗', false, true);
    }
}

// =========================================
// 提案ビューア（8案提案のスマホ表示・直接挿入）
// =========================================

let cliProposalsData = [];    // { path, data } の配列
let cliProposalsLoaded = false;

async function cliRefreshProposals() {
    const container = document.getElementById('cli-proposals-container');
    container.innerHTML = '<div class="cli-proposals-empty">🔄 提案を読み込み中...</div>';

    const pass = await getAuthPassword();
    if (!pass) return;

    try {
        updateStatus('提案取得中...', false);
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_list`;
        const res = await fetch(url, { method: 'POST' });
        const json = await res.json();

        if (json.status !== 'success') throw new Error(json.message);

        // _proposals/ プレフィックスのファイルを抽出
        const proposalFiles = (json.files || []).filter(f => f.path.startsWith('_proposals/'));

        if (proposalFiles.length === 0) {
            cliProposalsData = [];
            cliProposalsLoaded = true;
            cliRenderProposals();
            cliUpdateProposalsBadge();
            updateStatus('Ready', true);
            return;
        }

        // 各ファイルをダウンロード＆パース
        cliProposalsData = [];
        for (const f of proposalFiles) {
            try {
                const dlUrl = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_download&path=${encodeURIComponent(f.path)}`;
                const dlRes = await fetch(dlUrl, { method: 'POST' });
                const dlJson = await dlRes.json();

                if (dlJson.status === 'success') {
                    let content = dlJson.content;

                    // 暗号化の復号
                    try {
                        const parsed = JSON.parse(content);
                        if (parsed && parsed.encrypted) {
                            const encKey = await getEncryptionKey();
                            if (encKey) {
                                content = await decryptData(parsed, encKey);
                            } else {
                                continue;
                            }
                        }
                    } catch (_) {}

                    const data = JSON.parse(content);
                    if (data.type === 'proposals') {
                        cliProposalsData.push({ path: f.path, data: data });
                    }
                }
            } catch (_) { /* 個別ファイルのエラーはスキップ */ }
        }

        cliProposalsLoaded = true;
        cliRenderProposals();
        cliUpdateProposalsBadge();
        updateStatus('Ready', true);

    } catch (e) {
        container.innerHTML = `<div class="cli-proposals-empty" style="color:#f56565;">エラー: ${e.message}</div>`;
        updateStatus('提案取得失敗', false, true);
    }
}

function cliRenderProposals() {
    const container = document.getElementById('cli-proposals-container');
    container.innerHTML = '';

    // 全setsをフラット化（新しい順）
    const allSets = [];
    for (const pf of cliProposalsData) {
        for (const set of (pf.data.sets || [])) {
            allSets.push({ ...set, _filePath: pf.path, _created: pf.data.created });
        }
    }

    if (allSets.length === 0) {
        container.innerHTML = '<div class="cli-proposals-empty">💡 提案データがありません<br><span style="font-size:0.75rem;">PCから8案提案を実行してください</span></div>';
        return;
    }

    // 新しい順にソート
    allSets.sort((a, b) => (b._created || '').localeCompare(a._created || ''));

    allSets.forEach((set, setIdx) => {
        const setDiv = document.createElement('div');
        setDiv.className = 'cli-proposal-set open'; // デフォルト展開

        // ヘッダー
        const header = document.createElement('div');
        header.className = 'cli-proposal-set-header';

        const sourceLabel = (set.source || '').split('/').pop() || '提案';
        const markerLabel = set.marker ? ` — ${set.marker}` : '';
        header.innerHTML = `
            <span class="cli-proposal-set-arrow">▶</span>
            <span class="cli-proposal-set-title">💡 ${sourceLabel}${markerLabel}</span>
            <span style="font-size:0.7rem; color:#718096;">${set.proposals ? set.proposals.length + '案' : ''}</span>
        `;
        header.onclick = () => setDiv.classList.toggle('open');

        // ボディ
        const body = document.createElement('div');
        body.className = 'cli-proposal-set-body';

        // 前の文脈
        if (set.context_before) {
            const ctxBefore = document.createElement('div');
            ctxBefore.className = 'cli-proposal-context';
            ctxBefore.textContent = '前: ' + set.context_before;
            body.appendChild(ctxBefore);
        }

        // 各案カード
        if (set.proposals) {
            set.proposals.forEach((p) => {
                const card = document.createElement('div');
                card.className = 'cli-proposal-card';

                card.innerHTML = `
                    <span class="cli-proposal-num">${p.id}</span>
                    <span class="cli-proposal-text">${escapeHtml(p.text)}</span>
                    <span class="cli-proposal-insert-hint">挿入▶</span>
                `;

                card.onclick = () => cliInsertProposal(p.text, p.id);
                body.appendChild(card);
            });
        }

        // 後の文脈
        if (set.context_after) {
            const ctxAfter = document.createElement('div');
            ctxAfter.className = 'cli-proposal-context cli-proposal-context-after';
            ctxAfter.textContent = '後: ' + set.context_after;
            body.appendChild(ctxAfter);
        }

        setDiv.appendChild(header);
        setDiv.appendChild(body);
        container.appendChild(setDiv);
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function cliInsertProposal(text, proposalId) {
    if (!cliCurrentFile) {
        alert('先にファイルを開いてから案を挿入してください');
        return;
    }
    if (!cliEditorInstance) return;

    // 編集モードでなければ自動で切り替え
    if (!cliEditMode) {
        if (cliImageMode) {
            alert('画像ファイルには挿入できません');
            return;
        }
        cliEnterEditMode();
    }

    // カーソル位置に挿入
    cliEditorInstance.replaceSelection(text);
    cliEditorInstance.focus();

    // トースト表示
    cliShowProposalToast(proposalId);
}

function cliShowProposalToast(proposalId) {
    const existing = document.querySelector('.cli-proposal-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'cli-proposal-toast';
    toast.textContent = `✅ 案${proposalId}を挿入しました`;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

async function cliDeleteAllProposals() {
    if (cliProposalsData.length === 0) {
        alert('削除する提案がありません');
        return;
    }
    if (!confirm(`提案を全て削除しますか？（${cliProposalsData.length}ファイル）`)) return;

    const pass = await getAuthPassword();
    if (!pass) return;

    try {
        updateStatus('提案削除中...', false);

        const paths = cliProposalsData.map(p => p.path);
        for (const path of paths) {
            const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_delete&path=${encodeURIComponent(path)}`;
            await fetch(url, { method: 'POST' });
        }

        // ファイル一覧のキャッシュからも除去
        cliFileList = cliFileList.filter(f => !f.path.startsWith('_proposals/'));

        cliProposalsData = [];
        cliRenderProposals();
        cliUpdateProposalsBadge();
        updateStatus('提案削除完了', true);
        alert(`${paths.length}件の提案を削除しました`);
    } catch (e) {
        alert('提案削除失敗: ' + e.message);
        updateStatus('提案削除失敗', false, true);
    }
}

function cliUpdateProposalsBadge() {
    const badge = document.getElementById('cli-proposals-badge');
    if (!badge) return;

    let total = 0;
    for (const pf of cliProposalsData) {
        total += (pf.data.sets || []).length;
    }

    if (total > 0) {
        badge.textContent = total;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

console.log("✅ CLI Viewer モジュール読み込み完了（下書き自動保存・文字数カウント・更新通知・提案ビューア対応）");

// =========================================
// サブ参照ペイン
// シナリオ(メイン)を書きながら、セリフブレストや設定mdをチラ見するための枠。
// ・ヘッダーの [📄メイン][📚サブ1][📚サブ2] で全画面切替（スマホ縦で3枠同時表示は無理なため）
// ・サブは閲覧専用・整形固定。保存/編集の口はメインだけに残す
// ・開いているパスはlocalStorageに残し、次回は「キャッシュから無通信で」復元する
// =========================================

const CLI_SUB_PATHS_KEY = 'cli_sub_paths';
const CLI_SERIFU_KEY = 'cli_serifu_check';   // 使用済みセリフ塗り分けのON/OFF

/** タブのクリック。✕(破棄)と本体クリックをここで振り分ける */
function cliPaneTabClick(ev, pane) {
    if (ev && ev.target && ev.target.classList.contains('cli-pane-tab-close')) {
        ev.stopPropagation();
        cliClearSub(pane);
        return;
    }
    cliSwitchPane(pane);
}

/** 表示ペインの切替（'main' | 1 | 2） */
function cliSwitchPane(pane) {
    if (pane !== 'main' && pane !== 1 && pane !== 2) return;

    // メインを離れる時はカーソル位置を覚えておく。
    // キーボード操作だとここが飛ぶと打ち直しになるので、戻った時に必ず復元する
    if (cliActivePane === 'main' && cliEditorInstance) {
        try { cliMainCursor = cliEditorInstance.getCursor(); } catch (_) {}
    }

    cliActivePane = pane;
    const viewer = document.getElementById('cli-viewer');
    if (viewer) viewer.classList.toggle('cli-sub-mode', pane !== 'main');

    [1, 2].forEach(n => {
        const el = document.getElementById('cli-sub-pane-' + n);
        if (el) el.style.display = (pane === n) ? 'flex' : 'none';
    });

    const nameEl = document.getElementById('cli-current-filename');
    if (pane === 'main') {
        if (nameEl) nameEl.textContent = cliCurrentFile || 'ファイルを選択';
        // CodeMirrorは非表示中に幅を測れないので、戻ったら再計算してからカーソルを戻す
        setTimeout(() => {
            if (!cliEditorInstance) return;
            cliEditorInstance.refresh();
            if (cliEditMode) {
                if (cliMainCursor) { try { cliEditorInstance.setCursor(cliMainCursor); } catch (_) {} }
                cliEditorInstance.focus();
            }
        }, 30);
    } else {
        if (nameEl) nameEl.textContent = cliSubPaths[pane] || ('サブ' + pane + '（空）');
        // 復元直後など、まだ中身を入れていなければここで読み込む（通信はしない）
        if (cliSubPaths[pane] && !cliSubLoaded[pane] && !cliSubLoading[pane]) {
            cliLoadSub(pane, cliSubPaths[pane], { allowServer: false });
        } else if (cliSubLoaded[pane]) {
            // 表示済みのサブは、前に見た後でメイン本文が進んでいる可能性があるので塗り直す
            // （メイン編集中はサブが隠れているので、戻ってきたこの瞬間に追いつかせる）
            cliApplyUsedSerifu(pane);
        }
    }

    cliUpdatePaneTabs();
    cliUpdateSidebarTarget();
    if (cliFileList && cliFileList.length) cliRenderFileTree(cliFileList);
}

/** タブの見た目を状態に合わせて描き直す */
function cliUpdatePaneTabs() {
    const paint = (id, label, pane, isEmpty) => {
        const el = document.getElementById(id);
        if (!el) return;
        const active = (cliActivePane === pane);
        el.classList.toggle('active', active);
        el.classList.toggle('empty', !!isEmpty);
        let html = '<span class="cli-pane-tab-label">' + escapeHtml(label) + '</span>';
        // ✕はアクティブなサブにだけ出す（隣のタブを誤って空にしないため）
        if (pane !== 'main' && active && !isEmpty) {
            html += '<span class="cli-pane-tab-close" title="このサブを空にする">✕</span>';
        }
        el.innerHTML = html;
    };
    paint('cli-pane-tab-main', '📄 メイン', 'main', false);
    [1, 2].forEach(n => {
        const path = cliSubPaths[n];
        paint('cli-pane-tab-' + n, path ? '📚 ' + cliSubShortName(path) : '📚 ＋', n, !path);
    });
}

/** タブに載せる短い名前（拡張子を落として省略） */
function cliSubShortName(path) {
    const name = path.split('/').pop().replace(/\.[^.]+$/, '');
    return name.length > 8 ? name.slice(0, 8) + '…' : name;
}

/** サイドバーに「選んだファイルがどこへ入るか」を出す（アクティブペイン方式の誤爆よけ） */
function cliUpdateSidebarTarget() {
    const el = document.getElementById('cli-sidebar-target');
    if (!el) return;
    if (cliActivePane === 'main') {
        el.style.display = 'none';
    } else {
        el.style.display = '';
        el.textContent = '📚 選んだファイルは サブ' + cliActivePane + ' に読み込まれます';
    }
}

/** サイドバーのファイルをタップした時の行き先 */
function cliHandleFileClick(path) {
    if (cliActivePane === 'main') {
        cliOpenFile(path);
    } else {
        cliLoadSub(cliActivePane, path, { fromSidebar: true, allowServer: true });
    }
}

/**
 * サブにファイルを読み込む。
 * opts.allowServer : キャッシュが古い/無い時にGASへ取りに行くか
 * opts.forceServer : 必ず取りに行くか（🔄）
 * opts.fromSidebar : サイドバーからの選択か（サイドバーを閉じる）
 */
async function cliLoadSub(slot, path, opts) {
    opts = opts || {};
    const allowServer = (opts.allowServer !== false);
    const forceServer = !!opts.forceServer;
    if (slot !== 1 && slot !== 2) return;

    const changed = (cliSubPaths[slot] !== path);
    cliSubPaths[slot] = path;
    cliSubLoaded[slot] = false;
    cliSubLoading[slot] = true;
    cliSaveSubPaths();
    cliUpdatePaneTabs();
    cliSetSubPathLabel(slot, path, '');

    if (opts.fromSidebar) closeCliSidebar();
    if (cliActivePane !== slot) cliSwitchPane(slot);

    // 別ファイルに切り替えた時と、まだ何も出ていない時だけ「読み込み中」を出す。
    // 🔄での取り直しでは今見ている内容を消さない（読んでいる途中で真っ白になるのを防ぐ）
    const shownEl = document.getElementById('cli-sub-preview-' + slot);
    const hasShown = !!(shownEl && shownEl.style.display !== 'none' && shownEl.innerHTML.trim());
    if (changed || !hasShown) cliShowSubEmpty(slot, '📚 読み込み中...');

    try {
        const cached = await cliGetCachedFile(path);

        // まずキャッシュで即表示（サブは閲覧専用なので、古くても表示を止める理由がない）
        if (cached && !forceServer) {
            cliRenderSub(slot, cached.content);
            cliSubLoaded[slot] = true;
            const fresh = cliIsCacheFresh(path, cached);
            cliSetSubPathLabel(slot, path, fresh ? '' : '（保存分）');
            // 世代が確認できていて最新なら、ここで確定（通信ゼロ）
            if (fresh || !allowServer) { cliSubLoading[slot] = false; return; }
        } else if (!cached && !allowServer && !forceServer) {
            // 起動時の復元でキャッシュが無かった場合は、取りに行かず取得ボタンを出す
            cliShowSubEmpty(slot,
                '📚 保存分がありません<br><span class="cli-sub-empty-hint">' + escapeHtml(path) + '</span>',
                slot);
            cliSubLoading[slot] = false;
            return;
        }

        // サーバーから取り直して差し替える（サブは編集しないので衝突の心配がなく、黙って更新してよい）
        const got = await cliFetchSubContent(path);
        if (got) {
            cliRenderSub(slot, got.content);
            cliSubLoaded[slot] = true;
            cliSetSubPathLabel(slot, path, '');
            if (got.cacheable) await cliSaveFileToCache(path, got.content, got.updatedAt);
            updateStatus('📚 サブ' + slot + ' 取得完了', true);
        } else if (!cliSubLoaded[slot]) {
            cliShowSubEmpty(slot, '📚 取得できませんでした', slot);
        }
    } catch (e) {
        if (!cliSubLoaded[slot]) {
            cliShowSubEmpty(slot, '📚 取得失敗<br><span class="cli-sub-empty-hint">' + escapeHtml(e.message || '') + '</span>', slot);
        }
        updateStatus('サブ取得失敗', false, true);
    } finally {
        cliSubLoading[slot] = false;
    }
}

/** サブの🔄（このサブだけサーバーから取り直す） */
function cliRefreshSub(slot) {
    const path = cliSubPaths[slot];
    if (!path) return;
    cliLoadSub(slot, path, { forceServer: true, allowServer: true });
}

/** サブ用のファイル取得（暗号化されていれば復号する。cliOpenFileと同じ手順） */
async function cliFetchSubContent(path) {
    const pass = await getAuthPassword();
    if (!pass) return null;

    updateStatus('📚 サブ取得中...', false);
    const url = GAS_API_URL + '?auth=' + encodeURIComponent(pass)
        + '&action=cli_download&path=' + encodeURIComponent(path);
    const res = await fetch(url, { method: 'POST' });
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.message || '取得に失敗しました');

    let content = json.content;
    let cacheable = true;
    try {
        const parsed = JSON.parse(content);
        if (parsed && parsed.encrypted) {
            const encKey = await getEncryptionKey();
            if (!encKey) {
                content = '[暗号化データ] 暗号キーを設定してください';
                cacheable = false;
            } else {
                try {
                    content = await decryptData(parsed, encKey);
                } catch (decErr) {
                    content = '[復号失敗] 暗号キーが正しいか確認してください';
                    cacheable = false;
                }
            }
        }
    } catch (_) { /* JSONでなければ平文としてそのまま使う */ }

    return { content: content, updatedAt: json.updatedAt, cacheable: cacheable };
}

/** サブの中身を整形表示に流し込む（サブは常に整形。原文表示は持たない） */
function cliRenderSub(slot, text) {
    const el = document.getElementById('cli-sub-preview-' + slot);
    const empty = document.getElementById('cli-sub-empty-' + slot);
    if (!el) return;
    if (empty) { empty.style.display = 'none'; empty.innerHTML = ''; }
    el.style.display = '';

    // 画像が入っていたらそのまま出す
    const imageObj = cliTryParseImageContent(text);
    if (imageObj) {
        el.innerHTML = '<img src="data:' + imageObj.mimeType + ';base64,' + imageObj.data
            + '" alt="" class="cli-image-preview">';
        el.scrollTop = 0;
        return;
    }

    if (typeof marked === 'undefined') {
        // CDNが読めなかった場合は原文をそのまま出す（表示が空になるのを防ぐ）
        el.innerHTML = '<p class="cli-preview-error">整形用ライブラリを読み込めませんでした。原文を表示します。</p>'
            + '<pre class="cli-preview-raw">' + escapeHtml(text) + '</pre>';
        el.scrollTop = 0;
        return;
    }

    el.innerHTML = marked.parse(text, { gfm: true, breaks: true });

    // 幅の広い表は、本文ごと横に伸びないよう個別にスクロールさせる
    el.querySelectorAll('table').forEach(table => {
        if (table.parentElement && table.parentElement.classList.contains('md-table-wrap')) return;
        const wrap = document.createElement('div');
        wrap.className = 'md-table-wrap';
        table.parentNode.insertBefore(wrap, table);
        wrap.appendChild(table);
    });

    // 文字サイズはメインの設定に追従させる（サブ側に調整UIは置かない）
    el.style.fontSize = cliFontSize + 'px';
    el.scrollTop = 0;

    // メインで採用済みのセリフを塗る（重複採用よけ）
    cliApplyUsedSerifu(slot);
}

/** サブの空表示（withRefreshSlotを渡すと🔄取得ボタンを添える） */
function cliShowSubEmpty(slot, html, withRefreshSlot) {
    const el = document.getElementById('cli-sub-preview-' + slot);
    const empty = document.getElementById('cli-sub-empty-' + slot);
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    if (!empty) return;
    empty.style.display = 'flex';
    empty.innerHTML = '<div>' + html + '</div>'
        + (withRefreshSlot
            ? '<button class="btn-control" onclick="cliRefreshSub(' + withRefreshSlot + ')">🔄 取得</button>'
            : '');
}

/** サブの空タブ用の案内 */
function cliShowSubPlaceholder(slot) {
    cliShowSubEmpty(slot,
        '📚 サブ' + slot + ' は空です<br><span class="cli-sub-empty-hint">☰ からファイルを選ぶと、ここに読み込まれます</span>');
}

/** サブ上部のパス表示（（保存分）＝このセッションではサーバー確認していない） */
function cliSetSubPathLabel(slot, path, suffix) {
    const el = document.getElementById('cli-sub-path-' + slot);
    if (el) el.textContent = (path || '') + (suffix || '');
}

/** サブを空に戻す（✕。確認は挟まない＝すぐ捨てられるように） */
function cliClearSub(slot) {
    cliSubPaths[slot] = null;
    cliSubLoaded[slot] = false;
    cliSubLoading[slot] = false;
    cliSaveSubPaths();
    cliSetSubPathLabel(slot, '', '');
    cliShowSubPlaceholder(slot);
    cliUpdatePaneTabs();
    const nameEl = document.getElementById('cli-current-filename');
    if (cliActivePane === slot && nameEl) nameEl.textContent = 'サブ' + slot + '（空）';
    if (cliFileList && cliFileList.length) cliRenderFileTree(cliFileList);
}

function cliSaveSubPaths() {
    try {
        localStorage.setItem(CLI_SUB_PATHS_KEY, JSON.stringify([cliSubPaths[1], cliSubPaths[2]]));
    } catch (_) {}
}

/** 起動時の復元。パスだけ戻し、中身はタブを開いた時にキャッシュから読む（ここでは通信しない） */
function cliRestoreSubPanes() {
    try {
        const arr = JSON.parse(localStorage.getItem(CLI_SUB_PATHS_KEY) || '[]');
        cliSubPaths[1] = arr[0] || null;
        cliSubPaths[2] = arr[1] || null;
    } catch (_) {
        cliSubPaths[1] = null;
        cliSubPaths[2] = null;
    }
    [1, 2].forEach(n => {
        cliSubLoaded[n] = false;
        cliSubLoading[n] = false;
        cliSetSubPathLabel(n, cliSubPaths[n] || '', cliSubPaths[n] ? '（未読込）' : '');
        if (!cliSubPaths[n]) cliShowSubPlaceholder(n);
    });
    cliUpdatePaneTabs();
    cliUpdateSidebarTarget();
}

// --- キーボード操作（Androidに繋いだキーボード/マウス向け） ---
// Ctrl+数字はブラウザのタブ切替に取られるので Alt+1/2/3 を使う
document.addEventListener('keydown', (e) => {
    if (!cliViewerActive) return;
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    // Androidや配列によってはAlt併用で e.key が記号/'Dead' になるので、
    // レイアウト非依存の e.code（Digit/Numpad）を必ずフォールバックに用意しておく
    const map = {
        '1': 'main', '2': 1, '3': 2,
        'Digit1': 'main', 'Digit2': 1, 'Digit3': 2,
        'Numpad1': 'main', 'Numpad2': 1, 'Numpad3': 2
    };
    let target = map[e.key];
    if (target === undefined) target = map[e.code];
    if (target === undefined) return;
    e.preventDefault();
    cliSwitchPane(target);
});

// --- Ctrl+S（Macは⌘+S）で保存 ---
// ブラウザの「ページを保存」ダイアログは常に止める（Androidの外付けキーボードで誤爆しやすいため）
// capture:true ＝ CodeMirrorやtextareaに食われる前に拾う
document.addEventListener('keydown', (e) => {
    if (e.key !== 's' && e.key !== 'S' && e.code !== 'KeyS') return;
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.altKey) return;   // Ctrl+Alt+S は別用途に空けておく
    e.preventDefault();
    e.stopPropagation();

    if (!cliViewerActive) {
        // Canvas側：全ウィンドウを手動保存
        if (typeof manualSaveAll === 'function') manualSaveAll();
        return;
    }
    cliQuickSave();
}, true);

/**
 * CLIビューアでのCtrl+S。保存できるのは「メインペインで編集中の本文」だけなので、
 * それ以外の状況では何が足りないかをトーストで返す（黙って無反応にしない）
 */
function cliQuickSave() {
    if (cliActivePane !== 'main') { updateStatus('📄 保存できるのはメインの本文だけです', true); return; }
    if (!cliCurrentFile)         { updateStatus('先にファイルを開いてください', true); return; }
    if (cliImageMode)            { updateStatus('画像ファイルは保存できません', true); return; }
    if (!cliEditMode)            { updateStatus('📝 編集モードにすると保存できます', true); return; }
    if (!cliHasUnsavedChanges)   { updateStatus('変更はありません', true); return; }
    cliSaveFile();
}

// --- Ctrl+E で編集モード切替 ---
// メインペイン専用。ブラウザ既定（Chromeのアドレスバー検索など）は潰す
document.addEventListener('keydown', (e) => {
    if (!cliViewerActive) return;
    if (e.key !== 'e' && e.key !== 'E' && e.code !== 'KeyE') return;
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.altKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();

    if (cliActivePane !== 'main') { updateStatus('📄 編集できるのはメインの本文だけです', true); return; }
    if (!cliCurrentFile) { updateStatus('先にファイルを開いてください', true); return; }
    if (cliImageMode) { updateStatus('画像ファイルは編集できません', true); return; }
    // 未保存確認・整形表示からの復帰は toggleCliEditMode() 側が面倒を見てくれる
    toggleCliEditMode();
}, true);

// =========================================
// 指示パッドのキーボード操作（Androidに繋いだキーボード/マウス向け）
//   Ctrl+I     … 指示パッドを開いて入力窓にフォーカス（もう一度押すと本文へ戻る）
//   Ctrl+P     … 今開いているファイルのパスを指示パッドへ挿入（ブラウザの印刷は封じる）
//   Ctrl+Enter … 指示パッドの内容をコピー
//                （Ctrl+C は本文のテキスト選択コピーと被るので使わない）
//   Esc        … 指示パッドから本文へ戻る
//   Ctrl+/ , F1 … ショートカット一覧
// Ctrl+Shift+◯ はブラウザ側（Ctrl+Shift+I=開発者ツール等）に譲るので拾わない
// =========================================

/** 指示パッドの入力窓 */
function cliInstructionEl() {
    return document.getElementById('cli-instruction-content');
}

/** 今フォーカスが指示パッドの入力窓にあるか */
function cliIsInstructionFocused() {
    const ta = cliInstructionEl();
    return !!ta && document.activeElement === ta;
}

/**
 * 指示パッドを「入力できる状態」にして開く。
 * タブ切替・折りたたみ解除・（スマホなら）サブからの復帰とサイドバー畳みまで面倒を見る。
 * @param {{toEnd?:boolean, after?:function}} opts
 *   toEnd … カーソルを末尾へ置く（続きを書き足す用）
 *   after … フォーカスが入った後にやること（パス挿入など）
 * @returns {boolean} 開けたか
 */
function cliOpenInstructionPad(opts = {}) {
    if (!cliViewerActive) return false;
    const ta = cliInstructionEl();
    if (!ta) return false;

    // スマホ幅ではサブ表示中に指示パッドがCSSで隠れる（.cli-sub-mode）ので、メインへ戻してから開く。
    // PCは右パネルなのでサブを見たまま書ける
    const needPaneSwitch = (cliActivePane !== 'main' && !cliIsPcLayout());
    if (needPaneSwitch) cliSwitchPane('main');
    // スマホのサイドバーは入力窓に被さるので畳む（PCは常時表示なので触らない）
    if (!cliIsPcLayout()) closeCliSidebar();

    cliSwitchTab('instruction');
    if (!cliMemoExpanded) toggleCliMemoExpand();

    const finish = () => {
        if (opts.toEnd) {
            const n = ta.value.length;
            try { ta.setSelectionRange(n, n); } catch (_) {}
        }
        ta.focus();
        if (typeof opts.after === 'function') opts.after(ta);
    };
    // cliSwitchPane('main') は30ms後にCodeMirrorへフォーカスを戻すので、その後に入力窓を取る
    if (needPaneSwitch) setTimeout(finish, 60);
    else finish();
    return true;
}

/** 指示パッドから本文へ戻る（編集中ならカーソルもエディタへ返す） */
function cliLeaveInstructionPad() {
    const ta = cliInstructionEl();
    if (ta) ta.blur();
    if (cliEditorInstance && cliActivePane === 'main' && cliEditMode) {
        cliEditorInstance.focus();
    }
}

/** Ctrl+P。指示パッドを開いてから現在パスを挿入する（未フォーカスならカーソルは先頭＝メモの頭に付く） */
function cliInsertCurrentPathFromKey() {
    if (!cliCurrentFile) { updateStatus('先にファイルを開いてください', true); return; }
    cliOpenInstructionPad({
        after: () => {
            cliInsertIntoInstruction(cliCurrentFile);
            fbShowInsertToast(cliCurrentFile);
        }
    });
}

// ショートカット一覧（⌨ボタン / Ctrl+/ / F1）
const CLI_SHORTCUT_HELP = [
    '⌨ キーボードショートカット（CLIビューア）',
    '',
    '【表示】',
    '  Alt+1 / Alt+2 / Alt+3 … メイン / サブ1 / サブ2 を切替',
    '',
    '【本文】',
    '  Ctrl+E … 編集モードの切替（メインのみ）',
    '  Ctrl+S … 保存（メインで編集中のみ）',
    '',
    '【指示パッド】',
    '  Ctrl+I … 指示パッドを開いて入力窓へ（もう一度押すと本文へ戻る）',
    '  Ctrl+P … 今開いているファイルのパスを挿入',
    '  Ctrl+Enter … 内容をクリップボードにコピー',
    '  Esc … 入力窓から本文へ戻る',
    '',
    '※ Ctrl+C は本文のテキスト選択コピーに使うため、',
    '　 指示パッドのコピーは Ctrl+Enter に割り当てています'
].join('\n');

function cliShowShortcutHelp() {
    alert(CLI_SHORTCUT_HELP);
}

document.addEventListener('keydown', (e) => {
    if (!cliViewerActive) return;

    // --- 修飾キーなし ---
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'F1' || e.code === 'F1') {
            e.preventDefault();
            cliShowShortcutHelp();
            return;
        }
        // Escは入力窓にいる時だけ拾う（モーダルのEsc等を邪魔しない）
        if (e.key === 'Escape' && cliIsInstructionFocused()) {
            e.preventDefault();
            cliLeaveInstructionPad();
        }
        return;
    }

    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.altKey) return;    // Ctrl+Alt+◯ は将来用に素通し
    if (e.shiftKey) return;  // Ctrl+Shift+◯ はブラウザ既定に譲る

    // --- Ctrl+/ : ショートカット一覧 ---
    if (e.key === '/' || e.code === 'Slash') {
        e.preventDefault(); e.stopPropagation();
        cliShowShortcutHelp();
        return;
    }

    // --- Ctrl+I : 指示パッドを開く / 本文へ戻る ---
    if (e.key === 'i' || e.key === 'I' || e.code === 'KeyI') {
        e.preventDefault(); e.stopPropagation();
        if (cliIsInstructionFocused()) cliLeaveInstructionPad();
        else cliOpenInstructionPad({ toEnd: true });
        return;
    }

    // --- Ctrl+P : 現パス挿入（ブラウザの印刷ダイアログは潰す） ---
    if (e.key === 'p' || e.key === 'P' || e.code === 'KeyP') {
        e.preventDefault(); e.stopPropagation();
        cliInsertCurrentPathFromKey();
        return;
    }

    // --- Ctrl+Enter : 指示パッドをコピー ---
    if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault(); e.stopPropagation();
        cliCopyInstruction();
        return;
    }
}, true);

// =========================================
// セリフ使用済みチェッカー（CLI版）
// メインペインの本文を「採用済み」の台本とみなし、サブペイン（セリフブレスト等）に
// 出ている「」内セリフのうち、すでに採用済みのものを塗る。
// Canvas版（serifu-check.js）と同じ正規化・レーベンシュタイン判定・一致率設定を共有し、
// 判定ロジックは二重に持たない。違いは塗る対象で、
//   Canvas版 … CodeMirrorの markText
//   CLI版    … サブは「閲覧専用・整形固定」なので marked が吐いたDOMを直接包む
// =========================================

let cliSerifuCheckOn = true;   // 既定ON（重複採用に気づけないのが元々の困りごとなので）

// 塗り分けから除外するタグ（コードブロック内の「」は台詞ではない）
const CLI_SERIFU_SKIP_TAGS = ['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA'];

/** serifu-check.js が読めているか（CDN失敗や読み込み順の事故で落とさない） */
function cliSerifuReady() {
    return typeof extractQuotes === 'function'
        && typeof normalizeSerifu === 'function'
        && typeof findUsedMatch === 'function';
}

/** メイン本文の「」セリフ一覧（正規化・重複除去済み）＝採用済みリスト */
function cliMainQuoteSet() {
    if (!cliSerifuReady() || !cliEditorInstance) return [];
    if (cliImageMode) return [];
    const quotes = extractQuotes(cliEditorInstance.getValue()).map(q => normalizeSerifu(q.raw));
    return [...new Set(quotes)].filter(q => q.length > 0);
}

/** 付けた印を外して元のテキストへ戻す（normalize()で分割されたテキストノードを繋ぎ直す） */
function cliClearUsedSerifuMarks(root) {
    if (!root) return;
    root.querySelectorAll('span.cli-used-serifu').forEach(span => {
        const parent = span.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(span.textContent), span);
        parent.normalize();
    });
}

/**
 * root配下のテキストノードを走査し、採用済みセリフを span で包む
 * @returns {number} 塗った件数
 */
function cliMarkUsedSerifu(root, mainQuotes) {
    cliClearUsedSerifuMarks(root);
    if (!root || !cliSerifuReady() || !mainQuotes || !mainQuotes.length) return 0;

    // 走査しながらDOMを差し替えるとTreeWalkerが壊れるので、対象を先に集めきる
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue || node.nodeValue.indexOf('「') === -1) return NodeFilter.FILTER_REJECT;
            for (let el = node.parentNode; el && el !== root; el = el.parentNode) {
                if (CLI_SERIFU_SKIP_TAGS.indexOf(el.nodeName) !== -1) return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const targets = [];
    let node;
    while ((node = walker.nextNode())) targets.push(node);

    let count = 0;
    for (const tn of targets) {
        const text = tn.nodeValue;
        const frag = document.createDocumentFragment();
        let cursor = 0;
        for (const q of extractQuotes(text)) {
            const sim = findUsedMatch(normalizeSerifu(q.raw), mainQuotes);
            if (sim === null) continue;
            if (q.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, q.start)));
            const span = document.createElement('span');
            span.className = 'cli-used-serifu';
            span.title = '使用済み？（一致率 ' + sim + '%）';
            span.textContent = text.slice(q.start, q.end);
            frag.appendChild(span);
            cursor = q.end;
            count++;
        }
        if (cursor === 0) continue;   // このノードでは1件も当たらなかった
        if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
        tn.parentNode.replaceChild(frag, tn);
    }
    return count;
}

/** サブ1枚に照合結果を反映（mainQuotesを渡さなければその場で作る） */
function cliApplyUsedSerifu(slot, mainQuotes) {
    const el = document.getElementById('cli-sub-preview-' + slot);
    if (!el) return 0;
    if (!cliSerifuCheckOn) { cliClearUsedSerifuMarks(el); return 0; }
    return cliMarkUsedSerifu(el, mainQuotes || cliMainQuoteSet());
}

/** サブ2枚とも塗り直す。メイン本文が変わった後・ON/OFF切替・一致率変更から呼ぶ */
function cliRefreshSerifuMarks() {
    const mainQuotes = cliSerifuCheckOn ? cliMainQuoteSet() : [];
    let total = 0;
    [1, 2].forEach(n => { total += cliApplyUsedSerifu(n, mainQuotes); });
    return total;
}
window.cliRefreshSerifuMarks = cliRefreshSerifuMarks;

/** サブ上部バーの🖍ボタン。ON/OFFは端末ごとにlocalStorageで覚える */
function cliToggleSerifuCheck() {
    cliSerifuCheckOn = !cliSerifuCheckOn;
    try { localStorage.setItem(CLI_SERIFU_KEY, cliSerifuCheckOn ? '1' : '0'); } catch (_) {}
    cliUpdateSerifuButtons();
    const n = cliRefreshSerifuMarks();
    if (!cliSerifuCheckOn) {
        updateStatus('🖍 使用済みチェック OFF', true);
    } else if (!cliCurrentFile) {
        updateStatus('🖍 メインにファイルを開くと照合します', true);
    } else {
        updateStatus('🖍 使用済み ' + n + '件（メイン: ' + cliShortName(cliCurrentFile) + '）', true);
    }
}

function cliUpdateSerifuButtons() {
    [1, 2].forEach(n => {
        const btn = document.getElementById('cli-sub-serifu-' + n);
        if (!btn) return;
        btn.classList.toggle('btn-active', cliSerifuCheckOn);
        btn.title = cliSerifuCheckOn
            ? 'メイン本文で使用済みのセリフを塗る（ON）'
            : '使用済みセリフの塗り分け（OFF）';
    });
}

/** パス末尾のファイル名だけ（トースト用） */
function cliShortName(path) {
    return (path || '').split('/').pop();
}

function cliInitSerifuCheck() {
    try {
        const saved = localStorage.getItem(CLI_SERIFU_KEY);
        if (saved !== null) cliSerifuCheckOn = (saved === '1');
    } catch (_) {}
    cliUpdateSerifuButtons();
}
