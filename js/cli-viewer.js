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
let cliPinMode = false;            // ピンモード（タップで行をメモに転記）
let cliPinTouchMoved = false;      // ピンモード: タッチ中にmoveしたか
let cliDraftSaveTimer = null;      // 下書き自動保存タイマー
let cliPendingServerContent = null; // サーバー側の新しい内容（更新バナー表示中）
let cliImageMode = false;           // 現在開いているファイルが画像かどうか
const CLI_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

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
        // 編集モードを解除（明示的に破棄→下書きも消す）
        if (cliEditMode) cliExitEditMode(true);
        cliHideImage();
        cliDismissDraftBanner();
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

        // ピンモードのタップハンドラ設定
        setupPinMode(cliEditorInstance);
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

// サイドバーのピンモードボタン用（スマホではサイドバーを閉じる、PCでは開いたまま）
function cliPinFromSidebar() {
    toggleCliPinMode();
    if (!cliIsPcLayout()) toggleCliSidebar();
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

async function cliOpenSettings() {
    document.getElementById('cli-enc-key-input').value = '';
    document.getElementById('cliSettingsModal').classList.add('show');
    await cliUpdateSettingsStatus();
}

// モーダル内のステータス表示（暗号キー/合言葉の設定状況）を更新
async function cliUpdateSettingsStatus() {
    const encEl = document.getElementById('cli-enc-status');
    const authEl = document.getElementById('cli-auth-status');

    const key = await getEncryptionKey();
    encEl.textContent = key ? '🔒 暗号化有効' : '🔓 無効（平文）';
    encEl.style.color = key ? '#48bb78' : '#f6ad55';

    const pass = await getSetting('auth_password');
    authEl.textContent = pass ? '✅ 設定済み' : '⚠️ 未設定';
    authEl.style.color = pass ? '#48bb78' : '#f6ad55';
}

async function cliSaveEncKey() {
    const input = document.getElementById('cli-enc-key-input');
    const key = input.value.trim();
    if (!key) return alert('暗号キーを入力してください');
    if (key.length < 4) return alert('4文字以上で設定してください');
    await setEncryptionKey(key);
    input.value = '';
    await cliUpdateSettingsStatus();
    // クラウドモーダル側のステータス表示も同期しておく
    if (typeof updateEncKeyStatus === 'function') updateEncKeyStatus();
}

async function cliRemoveEncKey() {
    if (!confirm('暗号キーを解除しますか？\n（暗号化済みデータの読込には再設定が必要です）')) return;
    await clearEncryptionKey();
    await cliUpdateSettingsStatus();
    if (typeof updateEncKeyStatus === 'function') updateEncKeyStatus();
}

async function cliChangeAuthPassword() {
    const pass = prompt('新しい合言葉を入力してください');
    if (!pass) return;
    await setSetting('auth_password', pass);
    await cliUpdateSettingsStatus();
}

async function cliClearAuthPassword() {
    if (!confirm('保存済みの合言葉をクリアしますか？\n（次回のサーバーアクセス時に再入力を求められます）')) return;
    await clearAuthPassword();
    await cliUpdateSettingsStatus();
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

            // 開いているファイルも最新に更新
            if (cliCurrentFile) {
                await cliRefreshCurrentFile();
            }
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
        folderDiv.className = 'cli-folder';

        const header = document.createElement('div');
        header.className = 'cli-folder-header';

        const headerLabel = document.createElement('span');
        headerLabel.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis;';
        headerLabel.innerHTML = `📁 ${folderName} <span style="color:#a0aec0; font-weight:normal;">(${folders[folderName].length})</span>`;

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'cli-folder-delete';
        deleteBtn.textContent = '🗑';
        deleteBtn.title = 'フォルダごと削除';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            cliDeleteFolder(folderName, folders[folderName]);
        };

        header.appendChild(headerLabel);
        header.appendChild(deleteBtn);

        header.onclick = (e) => {
            if (e.target === deleteBtn) return;
            folderDiv.classList.toggle('open');
            const icon = folderDiv.classList.contains('open') ? '📂' : '📁';
            headerLabel.innerHTML = `${icon} ${folderName} <span style="color:#a0aec0; font-weight:normal;">(${folders[folderName].length})</span>`;
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
    const fileIcon = cliIsImagePath(fileInfo.path) ? '🖼️' : '📄';
    nameSpan.textContent = (isSelected ? '👉 ' : fileIcon + ' ') + fileName;
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
// ピンモード（タップで行をメモに転記）
// =========================================

function setupPinMode(editor) {
    const wrapper = editor.getWrapperElement();

    wrapper.addEventListener('touchstart', () => {
        cliPinTouchMoved = false;
    }, { passive: true });

    wrapper.addEventListener('touchmove', () => {
        cliPinTouchMoved = true;
    }, { passive: true });

    wrapper.addEventListener('touchend', (e) => {
        if (!cliPinMode || cliPinTouchMoved) return;

        // ピンモードON + タップ（スクロールしてない）のみ発火
        setTimeout(() => {
            const cursor = editor.getCursor();
            const line = cursor.line;
            const lineNum = line + 1;
            const lineText = editor.getLine(line) || '';
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
            const touch = e.changedTouches[0];
            if (touch) {
                showPinFeedback(touch.clientX, touch.clientY, `L${lineNum}: ${linePreview || '(空行)'}`);
            }

            // アクティブタブに応じて動作を分岐
            if (cliActiveTab === 'instruction') {
                expandCliMemo();
                const textarea = document.getElementById('cli-instruction-content');
                const ref = `[L${lineNum}] ${lineText.trim()}`;
                if (textarea.value && !textarea.value.endsWith('\n')) {
                    textarea.value += '\n';
                }
                textarea.value += ref + '\n';
                textarea.scrollTop = textarea.scrollHeight;
                setTimeout(() => textarea.focus(), 300);
            } else {
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
        }, 50);
    }, { passive: true });
}

function toggleCliPinMode() {
    cliPinMode = !cliPinMode;
    const btn = document.getElementById('cli-pin-btn');
    if (cliPinMode) {
        btn.classList.add('cli-pin-active');
        btn.textContent = '📌 ON';
    } else {
        btn.classList.remove('cli-pin-active');
        btn.textContent = '📌';
    }
}

function showPinFeedback(x, y, text) {
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
            }, 2000);
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
    setTimeout(() => textarea.focus(), 50);
}

// --- 今開いているファイルのパスを挿入 ---
function cliInsertCurrentPath() {
    if (!cliCurrentFile) {
        alert('開いているファイルがありません。先にファイルを選択してください。');
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

            const newData = JSON.parse(content);

            // キャッシュから表示済みでデータ同一なら再描画スキップ（展開状態を保持）
            if (fbTreeData && JSON.stringify(fbTreeData.tree) === JSON.stringify(newData.tree)) {
                fbTreeData = newData;
                fbTreeFlat = fbFlattenTree(fbTreeData.tree);
                return;
            }

            fbTreeData = newData;
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

// =========================================
// メモ全削除
// =========================================

async function cliDeleteAllMemos() {
    if (!confirm('送信済みメモを全て削除しますか？\n（この操作は取り消せません）')) return;

    const pass = await getAuthPassword();
    if (!pass) return;

    try {
        updateStatus('全メモ削除中...', false);
        const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=cli_memo_delete_all`;
        const res = await fetch(url, { method: 'POST' });
        const json = await res.json();

        if (json.status === 'success') {
            updateStatus('全メモ削除完了', true);
            alert(`${json.deletedCount}件のメモファイルを削除しました`);
        } else {
            throw new Error(json.message);
        }
    } catch (e) {
        alert('全メモ削除失敗: ' + e.message);
        updateStatus('全メモ削除失敗', false, true);
    }
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
// 🔄ボタンで開いているファイルの内容も更新
// =========================================

async function cliRefreshCurrentFile() {
    if (!cliCurrentFile || !cliEditorInstance) return;

    const pass = await getAuthPassword();
    if (!pass) return;

    try {
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
    } catch (_) {
        // ファイル一覧更新は成功しているので、内容取得失敗は無視
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

console.log("✅ CLI Viewer モジュール読み込み完了（ピンモード・下書き自動保存・メモ全削除・文字数カウント・更新通知・提案ビューア対応）");
