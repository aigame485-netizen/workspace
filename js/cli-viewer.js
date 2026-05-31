// =========================================
// CLI Viewer モジュール
// PC上のClaude CLIがアップロードしたファイルを
// スマホから閲覧し、メモ/フィードバックを送信する
// =========================================

// --- 状態管理 ---
let cliViewerActive = false;
let cliEditorInstance = null;
let cliCurrentFile = null;
let cliFileList = [];
let cliFontSize = 14;
let cliMemoExpanded = true;

// =========================================
// モード切替
// =========================================

function toggleCliViewer() {
    cliViewerActive = !cliViewerActive;
    const canvas = document.getElementById('canvas');
    const header = document.querySelector('header');
    const viewer = document.getElementById('cli-viewer');
    const cliBtn = document.querySelector('.btn-cli');

    if (cliViewerActive) {
        canvas.style.display = 'none';
        // ヘッダー内のCLI以外の要素を非表示（CLIモード専用表示）
        Array.from(header.children).forEach(el => {
            if (!el.classList.contains('btn-cli') && el.tagName !== 'H1') {
                el.dataset.cliHidden = el.style.display || '';
                el.style.display = 'none';
            }
        });
        viewer.style.display = 'flex';
        cliBtn.classList.add('active');
        initCliViewer();
    } else {
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
            viewportMargin: Infinity
        });
        cliEditorInstance.getWrapperElement().style.fontSize = cliFontSize + "px";
        cliEditorInstance.getWrapperElement().style.fontFamily =
            "'Helvetica Neue', Arial, 'Hiragino Sans', 'Meiryo', sans-serif";
        setTimeout(() => cliEditorInstance.refresh(), 100);
    }

    // キャッシュから即表示 → 裏でサーバーから更新
    await cliLoadCachedFileList();
    cliRefreshFiles();
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

function toggleCliSidebar() {
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
// ファイル一覧の取得と表示
// =========================================

async function cliRefreshFiles() {
    const pass = await getAuthPassword();
    if (!pass) return;

    const treeEl = document.getElementById('cli-file-tree');

    try {
        updateStatus('CLI一覧取得中...', false);
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_list`;
        const res = await fetch(url, { method: 'POST' });
        const json = await res.json();

        if (json.status === 'success') {
            cliFileList = json.files;
            await cliSaveFileListToCache(cliFileList);
            cliRenderFileTree(cliFileList);
            updateStatus('CLI一覧取得完了', true);
        } else {
            if (json.message && json.message.includes("合言葉")) await clearAuthPassword();
            throw new Error(json.message);
        }
    } catch (e) {
        treeEl.innerHTML = `<div style="color:#f56565; padding:10px;">エラー: ${e.message}</div>`;
        updateStatus('CLI取得失敗', false, true);
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

    // フォルダでグルーピング
    const folders = {};
    const rootFiles = [];

    files.forEach(f => {
        const parts = f.path.split('/');
        if (parts.length > 1) {
            const folder = parts.slice(0, -1).join('/');
            if (!folders[folder]) folders[folder] = [];
            folders[folder].push(f);
        } else {
            rootFiles.push(f);
        }
    });

    // フォルダ表示
    Object.keys(folders).sort().forEach(folderName => {
        const folderDiv = document.createElement('div');
        folderDiv.className = 'cli-folder open';

        const header = document.createElement('div');
        header.className = 'cli-folder-header';
        header.innerHTML = `📂 ${folderName} <span style="color:#a0aec0; font-weight:normal;">(${folders[folderName].length})</span>`;
        header.onclick = () => {
            folderDiv.classList.toggle('open');
            // アイコン切替
            const icon = folderDiv.classList.contains('open') ? '📂' : '📁';
            header.innerHTML = `${icon} ${folderName} <span style="color:#a0aec0; font-weight:normal;">(${folders[folderName].length})</span>`;
        };

        const filesDiv = document.createElement('div');
        filesDiv.className = 'cli-folder-files';

        folders[folderName].forEach(f => {
            filesDiv.appendChild(cliCreateFileItem(f));
        });

        folderDiv.appendChild(header);
        folderDiv.appendChild(filesDiv);
        treeEl.appendChild(folderDiv);
    });

    // ルート直下のファイル
    rootFiles.forEach(f => {
        treeEl.appendChild(cliCreateFileItem(f));
    });
}

function cliCreateFileItem(fileInfo) {
    const fileName = fileInfo.path.split('/').pop();
    const isSelected = (cliCurrentFile === fileInfo.path);
    const item = document.createElement('div');
    item.className = 'cli-file-item' + (isSelected ? ' selected' : '');

    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'flex-grow:1; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    nameSpan.textContent = (isSelected ? '👉 ' : '📄 ') + fileName;
    nameSpan.onclick = () => cliOpenFile(fileInfo.path);

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
    cliCurrentFile = path;
    document.getElementById('cli-current-filename').textContent = path;

    // キャッシュから即表示
    const cached = await cliGetCachedFile(path);
    if (cached) {
        cliEditorInstance.setValue(cached.content);
    } else {
        cliEditorInstance.setValue('読み込み中...');
    }

    closeCliSidebar();
    setTimeout(() => cliEditorInstance.refresh(), 50);

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

            cliEditorInstance.setValue(content);
            await cliSaveFileToCache(path, content, json.updatedAt);
            updateStatus('取得完了', true);
        } else {
            throw new Error(json.message);
        }
    } catch (e) {
        if (!cached) {
            cliEditorInstance.setValue('エラー: ' + e.message);
        }
        updateStatus('取得失敗', false, true);
    }

    // ファイルツリーの選択状態を更新
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
            cliRenderFileTree(cliFileList);
        } else {
            throw new Error(json.message);
        }
    } catch (e) {
        alert('削除失敗: ' + e.message);
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
}

// =========================================
// メモ / フィードバック
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
}

async function cliSendMemo() {
    if (!cliCurrentFile) {
        alert('先にファイルを開いてください');
        return;
    }

    const section = document.getElementById('cli-memo-section').value.trim();
    const content = document.getElementById('cli-memo-content').value.trim();

    if (!content) {
        alert('メモ内容を入力してください');
        return;
    }

    const pass = await getAuthPassword();
    if (!pass) return;

    // カーソル位置から行番号ヒントを取得
    let lineHint = null;
    if (cliEditorInstance) {
        const cursor = cliEditorInstance.getCursor();
        if (cursor.line > 0) lineHint = cursor.line + 1;
    }

    const memoData = {
        targetFile: cliCurrentFile,
        memo: {
            section: section || null,
            lineHint: lineHint,
            content: content
        }
    };

    // 暗号化対応
    let sendBody = JSON.stringify(memoData);
    const encKey = await getEncryptionKey();
    if (encKey) {
        const encObj = await encryptData(sendBody, encKey);
        sendBody = JSON.stringify({ encrypted: true, payload: encObj, targetFile: cliCurrentFile });
    }

    try {
        updateStatus('メモ送信中...', false);
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_memo_save`;
        const res = await fetch(url, { method: 'POST', body: sendBody });
        const json = await res.json();

        if (json.status === 'success') {
            updateStatus('メモ送信完了', true);
            document.getElementById('cli-memo-section').value = '';
            document.getElementById('cli-memo-content').value = '';
            alert('メモを送信しました ✓');
        } else {
            throw new Error(json.message);
        }
    } catch (e) {
        alert('メモ送信失敗: ' + e.message);
        updateStatus('メモ送信失敗', false, true);
    }
}

async function cliShowMemoHistory() {
    if (!cliCurrentFile) {
        alert('先にファイルを開いてください');
        return;
    }

    const pass = await getAuthPassword();
    if (!pass) return;

    try {
        updateStatus('メモ取得中...', false);
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_memo_list&path=${encodeURIComponent(cliCurrentFile)}`;
        const res = await fetch(url, { method: 'POST' });
        const json = await res.json();

        if (json.status === 'success') {
            const memos = json.memos || [];

            if (memos.length === 0) {
                alert('このファイルへのメモはありません');
                updateStatus('Ready', true);
                return;
            }

            let display = memos.map((m, i) => {
                const sec = m.section ? `[${m.section}]` : '';
                const line = m.lineHint ? `L${m.lineHint}` : '';
                const date = m.createdAt ? new Date(m.createdAt).toLocaleString('ja-JP') : '';
                return `${i + 1}. ${sec}${line} ${m.content}\n   (${date})`;
            }).join('\n\n');

            alert(`📋 送信済みメモ (${memos.length}件)\n\n${display}`);
            updateStatus('Ready', true);
        } else {
            throw new Error(json.message);
        }
    } catch (e) {
        alert('メモ取得失敗: ' + e.message);
        updateStatus('メモ取得失敗', false, true);
    }
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

async function cliLoadCachedFileList() {
    if (!db) return;
    try {
        // settingsストアから前回のファイルリストを取得
        const cached = await getSetting('cli_file_list_cache');
        if (cached) {
            const files = JSON.parse(cached);
            if (files && files.length > 0) {
                cliFileList = files;
                cliRenderFileTree(cliFileList);
            }
        }
    } catch (e) { /* キャッシュ読み込み失敗は無視 */ }
}

async function cliSaveFileListToCache(files) {
    try {
        await setSetting('cli_file_list_cache', JSON.stringify(files));
    } catch (e) { /* 無視 */ }
}

console.log("✅ CLI Viewer モジュール読み込み完了");
