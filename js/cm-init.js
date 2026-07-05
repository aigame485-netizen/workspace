/**
 * CodeMirror 5 初期化スクリプト
 * 各ウィンドウの <textarea> をマークダウンハイライト付きエディタに変換する
 */

// ========================================
// エディタインスタンス管理
// ========================================
// 各ウィンドウのIDをキーにCodeMirrorインスタンスを保持
const editorInstances = {};

/**
 * textarea を CodeMirror エディタに変換する
 * @param {HTMLTextAreaElement} textarea - 変換対象のtextarea
 * @param {string} winId - ウィンドウID（例: "win-1"）
 * @param {string} fontSize - 初期フォントサイズ（例: "14px"）
 */
function createEditor(textarea, winId, fontSize = "14px") {
    // 既にエディタが存在する場合はスキップ
    if (editorInstances[winId]) return editorInstances[winId];

    const editor = CodeMirror.fromTextArea(textarea, {
        mode: "markdown",
        theme: "workspace-dark",
        lineWrapping: true,
        // IME対策: デフォルトの"textarea"方式は隠しtextareaを基準に変換候補が表示され、
        // 候補ウィンドウが入力中の行に被る。contenteditable方式なら実際のカーソル位置の
        // 真下に候補が出る（VSCodeと同じ挙動になる）
        inputStyle: "contenteditable",
        spellcheck: false,
        viewportMargin: Infinity // スクロールバー制御用
    });

    // 初期フォントサイズ設定
    editor.getWrapperElement().style.fontSize = fontSize;
    // 書体はCSS変数で一元管理（ヘッダーの書体セレクトから変更される）
    editor.getWrapperElement().style.fontFamily = "var(--editor-font)";
    
    // --- 文字数カウンタ（帯に常時表示、範囲選択中は選択文字数も表示） ---
    const idNum = winId.split('-')[1];
    function formatCharCount(n) {
        // CLIビューアのバッジと同じ表記ルール（1万字以上はK表記）
        return (n >= 10000) ? (n / 1000).toFixed(1) + 'K' : n.toLocaleString();
    }
    function updateCharCount(cm) {
        const counter = document.getElementById('char-count-' + idNum);
        if (!counter) return;
        const total = cm.getValue().length;
        if (cm.somethingSelected()) {
            const sel = cm.getSelection().length;
            counter.textContent = `選択 ${sel.toLocaleString()} / ${formatCharCount(total)}字`;
            counter.classList.add('has-selection');
        } else {
            counter.textContent = formatCharCount(total) + '字';
            counter.classList.remove('has-selection');
        }
    }
    // cursorActivityは「編集・カーソル移動・選択変更」すべてで発火する
    editor.on("cursorActivity", updateCharCount);

    // フォント適用やDOMへの追加が完了したあとにレイアウトを再計算する
    setTimeout(() => {
        editor.refresh();
        updateCharCount(editor); // 初期表示
    }, 100);

    // テキスト変更時に notifyChange を呼ぶ
    editor.on("change", function(cm) {
        // textarea の value も同期しておく（保存ロジック互換のため）
        textarea.value = cm.getValue();
        // 既存の変更通知
        if (typeof window.notifyChange === 'function') {
            window.notifyChange(winId);
        }
    });

    // ウィンドウのリサイズを検知してレイアウトを再計算する
    // （refreshしないとカーソル座標のキャッシュがズレて、カーソル描画やIME位置が狂う）
    if (typeof ResizeObserver !== 'undefined') {
        let refreshTimer = null;
        const resizeObserver = new ResizeObserver(() => {
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => editor.refresh(), 100);
        });
        resizeObserver.observe(editor.getWrapperElement());
        editor._resizeObserver = resizeObserver; // destroy時に解除するため保持
    }

    // 連動スクロール
    editor.on("scroll", function(cm) {
        const syncToggle = document.getElementById('syncToggle');
        if (syncToggle && syncToggle.checked) {
            const scrollInfo = cm.getScrollInfo();
            // 他のCodeMirrorエディタにもスクロールを同期
            for (const [id, otherEditor] of Object.entries(editorInstances)) {
                if (id !== winId) {
                    otherEditor.scrollTo(scrollInfo.left, scrollInfo.top);
                }
            }
        }
    });

    editorInstances[winId] = editor;
    return editor;
}

/**
 * 指定ウィンドウのCodeMirrorインスタンスを取得
 */
function getEditor(winId) {
    return editorInstances[winId] || null;
}

/**
 * 指定ウィンドウのCodeMirrorインスタンスを破棄
 */
function destroyEditor(winId) {
    const editor = editorInstances[winId];
    if (editor) {
        if (editor._resizeObserver) editor._resizeObserver.disconnect(); // リサイズ監視を解除
        editor.toTextArea(); // textareaに戻す
        delete editorInstances[winId];
    }
}

/**
 * CodeMirror のフォントサイズを変更する
 */
function setEditorFontSize(winId, newSize) {
    const editor = editorInstances[winId];
    if (!editor) return;
    editor.getWrapperElement().style.fontSize = newSize + "px";
    editor.refresh(); // レイアウト再計算
}

/**
 * CodeMirror のテキスト内容を設定する
 */
function setEditorText(winId, text) {
    const editor = editorInstances[winId];
    if (!editor) return;
    if (editor.getValue() !== text) {
        // setValueだとカーソル位置がリセットされるため、変更イベントがループしないよう注意
        editor.setValue(text);
    }
}

/**
 * CodeMirror のテキスト内容を取得する
 */
function getEditorText(winId) {
    const editor = editorInstances[winId];
    if (!editor) return "";
    return editor.getValue();
}

/**
 * 全エディタインスタンスを破棄する
 */
function destroyAllEditors() {
    for (const winId of Object.keys(editorInstances)) {
        destroyEditor(winId);
    }
}

// ========================================
// グローバルに公開（main.js から呼べるようにする）
// ========================================
window.cmCreateEditor = createEditor;
window.cmGetEditor = getEditor;
window.cmDestroyEditor = destroyEditor;
window.cmSetEditorFontSize = setEditorFontSize;
window.cmSetEditorText = setEditorText;
window.cmGetEditorText = getEditorText;
window.cmDestroyAllEditors = destroyAllEditors;
window.cmEditorInstances = editorInstances;

// ========================================
// 既存ウィンドウを変換（ページロード後に実行）
// ========================================
function convertExistingTextareas() {
    document.querySelectorAll('.window').forEach(win => {
        const winId = win.id;
        const textarea = win.querySelector('textarea');
        if (textarea && !editorInstances[winId]) {
            const fontSize = win.style.getPropertyValue('--font-size') || '14px';
            createEditor(textarea, winId, fontSize);
        }
    });
}

// DOMの変更を監視して、新しいウィンドウが追加されたら自動変換
const canvasObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (node.nodeType === 1 && node.classList && node.classList.contains('window')) {
                const textarea = node.querySelector('textarea');
                if (textarea && !editorInstances[node.id]) {
                    const fontSize = node.style.getPropertyValue('--font-size') || '14px';
                    setTimeout(() => createEditor(textarea, node.id, fontSize), 50);
                }
            }
        }
        for (const node of mutation.removedNodes) {
            if (node.nodeType === 1 && node.classList && node.classList.contains('window')) {
                destroyEditor(node.id);
            }
        }
    }
});

function startObserving() {
    const canvas = document.getElementById('canvas');
    if (canvas) {
        canvasObserver.observe(canvas, { childList: true });
        convertExistingTextareas();
    } else {
        setTimeout(startObserving, 100);
    }
}

if (document.readyState === 'complete') {
    setTimeout(startObserving, 500);
} else {
    window.addEventListener('load', () => setTimeout(startObserving, 500));
}

console.log("✅ CodeMirror 5 モジュール読み込み完了");
