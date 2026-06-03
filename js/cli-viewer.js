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
let cliEditMode = false;           // 編集モードON/OFF
let cliOriginalContent = '';       // 編集前の元テキスト（変更検知用）
let cliHasUnsavedChanges = false;  // 未保存の変更があるか
let cliActiveTab = 'memo';         // 'memo' | 'instruction'

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
        // 未保存変更の確認
        if (cliHasUnsavedChanges) {
            if (!confirm('未保存の変更があります。破棄して戻りますか？')) return;
        }
        // 編集モードを解除
        if (cliEditMode) cliExitEditMode();
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

        // 長押しでメモにライン情報を送る
        setupLongPress(cliEditorInstance);
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
            cliOriginalContent = content; // 元テキストを記録
            cliHasUnsavedChanges = false;
            cliUpdateEditButtons();
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

    // CodeMirrorのサイズを再計算
    if (cliEditorInstance) setTimeout(() => cliEditorInstance.refresh(), 100);
}

function expandCliMemo() {
    if (!cliMemoExpanded) toggleCliMemoExpand();
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

    // カーソル位置から行番号・行テキストを取得
    let lineHint = null;
    let lineText = null;
    if (cliEditorInstance) {
        const cursor = cliEditorInstance.getCursor();
        if (cursor.line > 0) {
            lineHint = cursor.line + 1;
            lineText = (cliEditorInstance.getLine(cursor.line) || '').trim();
            if (lineText.length > 80) lineText = lineText.substring(0, 80) + '…';
        }
    }

    const memoData = {
        targetFile: cliCurrentFile,
        memo: {
            section: section || null,
            lineHint: lineHint,
            lineText: lineText || null,
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

            // 暗号化メモの復号処理
            const encKey = await getEncryptionKey();
            const processed = [];
            for (const m of memos) {
                if (m.encrypted && m.payload) {
                    if (encKey) {
                        try {
                            const decrypted = await decryptData(m.payload, encKey);
                            const parsed = JSON.parse(decrypted);
                            processed.push({ ...parsed.memo, id: m.id, createdAt: m.createdAt });
                        } catch (_e) {
                            processed.push({ content: '[復号失敗]', createdAt: m.createdAt });
                        }
                    } else {
                        processed.push({ content: '[暗号化データ — キー未設定]', createdAt: m.createdAt });
                    }
                } else {
                    processed.push(m);
                }
            }

            let display = processed.map((m, i) => {
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

// =========================================
// 長押しでメモにライン情報を送る
// =========================================

let cliLongPressTimer = null;
let cliLongPressFired = false;

function setupLongPress(editor) {
    const wrapper = editor.getWrapperElement();

    wrapper.addEventListener('touchstart', (e) => {
        cliLongPressFired = false;
        const touch = e.touches[0];
        const touchX = touch.clientX;
        const touchY = touch.clientY;

        cliLongPressTimer = setTimeout(() => {
            cliLongPressFired = true;
            // タッチ位置からCodeMirrorの行番号を取得
            const coords = editor.coordsChar({ left: touchX, top: touchY });
            const line = coords.line;
            const lineNum = line + 1;

            // 該当行のテキストを取得
            const lineText = editor.getLine(line) || '';
            // 表示用に30文字でトリム
            const linePreview = lineText.length > 30 ? lineText.substring(0, 30) + '…' : lineText;

            // 上方向に最も近い見出し（# で始まる行）を検索
            let sectionName = '';
            for (let i = line; i >= 0; i--) {
                const lt = editor.getLine(i);
                if (lt && /^#{1,4}\s+/.test(lt)) {
                    sectionName = lt.replace(/^#+\s*/, '').trim();
                    break;
                }
            }

            // フィードバック表示
            showLongPressFeedback(touchX, touchY, `L${lineNum}: ${linePreview || '(空行)'}`);

            // カーソル位置を記録
            editor.setCursor(coords);

            // アクティブタブに応じて動作を分岐
            if (cliActiveTab === 'instruction') {
                // 指示パッドに行テキストを追記
                expandCliMemo();
                const textarea = document.getElementById('cli-instruction-content');
                const ref = `[L${lineNum}] ${lineText.trim()}`;
                if (textarea.value && !textarea.value.endsWith('\n')) {
                    textarea.value += '\n';
                }
                textarea.value += ref + '\n';
                // 末尾にスクロール
                textarea.scrollTop = textarea.scrollHeight;
                setTimeout(() => textarea.focus(), 300);
            } else {
                // メモタブ: 従来動作（セクション名+行テキストをセット）
                const sectionWithLine = sectionName
                    ? `${sectionName} (L${lineNum}: ${lineText.trim().substring(0, 40)})`
                    : `L${lineNum}: ${lineText.trim().substring(0, 50)}`;
                document.getElementById('cli-memo-section').value = sectionWithLine;
                expandCliMemo();

                setTimeout(() => {
                    const memoContent = document.getElementById('cli-memo-content');
                    memoContent.focus();
                    memoContent.placeholder = `L${lineNum} "${linePreview}" への修正指示...`;
                }, 300);
            }
        }, 500);
    }, { passive: true });

    wrapper.addEventListener('touchmove', () => {
        if (cliLongPressTimer) {
            clearTimeout(cliLongPressTimer);
            cliLongPressTimer = null;
        }
    }, { passive: true });

    wrapper.addEventListener('touchend', () => {
        if (cliLongPressTimer) {
            clearTimeout(cliLongPressTimer);
            cliLongPressTimer = null;
        }
    }, { passive: true });
}

function showLongPressFeedback(x, y, text) {
    const existing = document.querySelector('.cli-longpress-indicator');
    if (existing) existing.remove();

    const indicator = document.createElement('div');
    indicator.className = 'cli-longpress-indicator';
    indicator.textContent = '📌 ' + text;
    indicator.style.left = Math.min(x, window.innerWidth - 200) + 'px';
    indicator.style.top = (y - 40) + 'px';
    document.body.appendChild(indicator);

    setTimeout(() => indicator.remove(), 1500);
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
    if (cliEditMode) {
        // 編集モード終了
        if (cliHasUnsavedChanges) {
            if (!confirm('未保存の変更があります。破棄しますか？')) return;
        }
        cliExitEditMode();
    } else {
        // 編集モード開始
        cliEnterEditMode();
    }
}

function cliEnterEditMode() {
    cliEditMode = true;
    cliOriginalContent = cliEditorInstance.getValue();
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

function cliExitEditMode() {
    cliEditMode = false;
    cliHasUnsavedChanges = false;

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
    // 元テキストと現在のテキストを比較して変更を検知
    const currentText = cliEditorInstance.getValue();
    cliHasUnsavedChanges = (currentText !== cliOriginalContent);
    cliUpdateEditButtons();
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
// タブ切替（メモ / 指示パッド）
// =========================================

function cliSwitchTab(tabName) {
    cliActiveTab = tabName;

    // タブボタンの状態更新
    document.querySelectorAll('.cli-memo-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // コンテンツの表示切替
    document.getElementById('cli-tab-memo').classList.toggle('active', tabName === 'memo');
    document.getElementById('cli-tab-instruction').classList.toggle('active', tabName === 'instruction');

    // CodeMirrorのサイズ再計算
    if (cliEditorInstance) setTimeout(() => cliEditorInstance.refresh(), 100);
}

// =========================================
// 指示パッド機能
// =========================================

async function cliCopyInstruction() {
    const textarea = document.getElementById('cli-instruction-content');
    const text = textarea.value.trim();

    if (!text) {
        alert('コピーする内容がありません');
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

let fbTreeData = null;      // キャッシュしたツリーデータ
let fbTreeFlat = [];        // フラット化したリスト（検索用）

async function cliOpenFolderBrowser() {
    const modal = document.getElementById('folderBrowserModal');
    modal.classList.add('show');

    const treeEl = document.getElementById('folder-browser-tree');
    const searchEl = document.getElementById('folder-browser-search');
    searchEl.value = '';

    // キャッシュがあれば即表示、なければGASから取得
    if (fbTreeData) {
        fbRenderTree(fbTreeData.tree, treeEl);
    } else {
        treeEl.innerHTML = '<div style="text-align:center; color:#718096; padding:20px;">📡 フォルダ構造を取得中...</div>';
    }

    // GASから最新を取得
    await fbFetchTree();
}

function closeFolderBrowser() {
    document.getElementById('folderBrowserModal').classList.remove('show');
}

async function fbFetchTree() {
    const pass = await getAuthPassword();
    if (!pass) return;

    const treeEl = document.getElementById('folder-browser-tree');

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

            fbTreeData = JSON.parse(content);
            fbTreeFlat = fbFlattenTree(fbTreeData.tree);
            fbRenderTree(fbTreeData.tree, treeEl);
        } else {
            treeEl.innerHTML = '<div class="fb-no-results">フォルダ構造がまだアップロードされていません<br><span style="font-size:0.75rem;">PC側で push-tree を実行してください</span></div>';
        }
    } catch (e) {
        treeEl.innerHTML = `<div class="fb-no-results">取得エラー: ${e.message}</div>`;
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

console.log("✅ CLI Viewer モジュール読み込み完了（編集モード・指示パッド・パスブラウザ対応）");
