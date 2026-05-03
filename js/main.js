const GAS_API_URL = "https://script.google.com/macros/s/AKfycbyCsdPclvOpyEyxB4fEklillB729ge_b9-q9afAZPartKazdS9-6u8xkfDercVRaLl2/exec"; 

        // --- CodeMirror 互換ヘルパー ---
        function getWindowText(winId) {
            if (window.cmGetEditorText) {
                const text = window.cmGetEditorText(winId);
                if (text !== undefined && text !== "") return text;
            }
            const idNum = parseInt(winId.split('-')[1]);
            const ta = document.getElementById('text-' + idNum);
            return ta ? ta.value : "";
        }
        function setWindowText(winId, text) {
            const idNum = parseInt(winId.split('-')[1]);
            const ta = document.getElementById('text-' + idNum);
            if (ta) ta.value = text;
            if (window.cmSetEditorText) {
                window.cmSetEditorText(winId, text);
            }
        }

        const DB_NAME = 'CreativeWorkspaceDB_v7'; 
        const DB_VERSION = 4;
        const STORE_WINDOWS = 'windows';
        const STORE_WINDOWS_2 = 'windows_2';
        const STORE_WINDOWS_3 = 'windows_3';
        const STORE_SETTINGS = 'settings';

        let db = null;
        let zIndexCounter = 100;
        let isAutoSaveEnabled = false;
        let isSaving = false;
        let saveTimers = {};
        let blobCache = {};
        
        let currentTabId = 1;
        let boardNames = { 1: "default", 2: "tab2", 3: "tab3" };
        
        let isMinimalMode = false;

        function getActiveStore() {
            if (currentTabId === 1) return STORE_WINDOWS;
            if (currentTabId === 2) return STORE_WINDOWS_2;
            if (currentTabId === 3) return STORE_WINDOWS_3;
            return STORE_WINDOWS;
        }

        window.onload = async function() {
            await initDB();
            
            const savedTabId = await getSetting('current_tab_id');
            if (savedTabId) currentTabId = savedTabId;

            for (let i = 1; i <= 3; i++) {
                const savedName = await getSetting(`board_name_${i}`);
                if (savedName) boardNames[i] = savedName;
            }
            
            const savedAuto = await getSetting('auto_save_enabled');
            if (savedAuto === true) {
                isAutoSaveEnabled = true;
                document.getElementById('autoSaveToggle').checked = true;
                document.getElementById('btn-manual-save').disabled = true;
            }
            updateTabUI();
            updateBoardDisplay();
            loadFromDB();
        };

        async function switchTab(tabId) {
            if (currentTabId === tabId) return;
            if (isSaving) { alert("保存処理中です。しばらくお待ちください。"); return; }
            
            updateStatus('切替中...', false);
            await manualSaveAll();
            
            if (window.cmDestroyAllEditors) window.cmDestroyAllEditors();
            
            currentTabId = tabId;
            await setSetting('current_tab_id', currentTabId);
            
            updateTabUI();
            updateBoardDisplay();
            
            document.getElementById('canvas').innerHTML = '';
            blobCache = {}; 
            
            loadFromDB();
        }

        function updateTabUI() {
            for (let i = 1; i <= 3; i++) {
                const btn = document.getElementById(`tab-btn-${i}`);
                if (btn) {
                    if (i === currentTabId) btn.classList.add('active');
                    else btn.classList.remove('active');
                }
                const nameEl = document.getElementById(`tab-name-${i}`);
                if (nameEl) nameEl.textContent = boardNames[i];
            }
        }

        function toggleMinimalUI() {
            isMinimalMode = !isMinimalMode;
            if(isMinimalMode) document.body.classList.add('minimal-mode');
            else document.body.classList.remove('minimal-mode');
        }

        async function getSetting(key) {
            try {
                const tx = db.transaction([STORE_SETTINGS], 'readonly');
                const req = tx.objectStore(STORE_SETTINGS).get(key);
                const res = await new Promise(r => req.onsuccess = () => r(req.result));
                return res ? res.value : null;
            } catch(e) { return null; }
        }
        async function setSetting(key, val) {
            const tx = db.transaction([STORE_SETTINGS], 'readwrite');
            tx.objectStore(STORE_SETTINGS).put({ key: key, value: val });
        }
        async function getAuthPassword() {
            let pass = await getSetting('auth_password');
            if(!pass) {
                pass = prompt("合言葉を入力してください");
                if(pass) await setSetting('auth_password', pass);
            }
            return pass;
        }
        async function clearAuthPassword() {
            const tx = db.transaction([STORE_SETTINGS], 'readwrite');
            tx.objectStore(STORE_SETTINGS).delete('auth_password');
        }

        function updateBoardDisplay() {
            const cloudNameEl = document.getElementById('cloud-current-name');
            if (cloudNameEl) cloudNameEl.textContent = boardNames[currentTabId];
            updateTabUI();
        }

        function closeModal(id) { document.getElementById(id).classList.remove('show'); }
        async function openCloudModal() {
            await manualSaveAll();
            document.getElementById('cloudModal').classList.add('show');
            updateBoardDisplay();
            document.getElementById('newBoardInput').value = "";
            refreshBoardList();
        }
        async function refreshBoardList() {
            const listEl = document.getElementById('cloudList');
            listEl.innerHTML = '<div style="text-align:center; color:#718096; padding:20px;">一覧を取得中...</div>';
            const pass = await getAuthPassword();
            if(!pass) { listEl.innerHTML='<div style="text-align:center;">認証が必要です</div>'; return; }

            try {
                const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=list`;
                const res = await fetch(url, { method: 'POST' });
                const json = await res.json();

                if(json.status === 'success') {
                    listEl.innerHTML = '';
                    if(json.boards.length === 0) listEl.innerHTML = '<div style="padding:20px; text-align:center; color:#cbd5e0;">ファイルがありません</div>';
                    else {
                        json.boards.forEach(name => {
                            const div = document.createElement('div');
                            div.className = 'file-row';
                            const isCurrent = (name === boardNames[currentTabId]);
                            if(isCurrent) div.style.cssText = 'border-left: 3px solid #48bb78; background-color:#2f855a;';
                            div.innerHTML = `
                                <div class="file-name" onclick="processDownload('${name}')">${isCurrent ? '👉 ' : '📄 '}${name}</div>
                                <div class="file-actions">
                                    <button class="btn-mini btn-load" onclick="processDownload('${name}')">読込</button>
                                    <button class="btn-mini btn-trash" onclick="deleteBoard('${name}')">削除</button>
                                </div>
                            `;
                            listEl.appendChild(div);
                        });
                    }
                } else {
                    if(json.message && json.message.includes("合言葉")) await clearAuthPassword();
                    throw new Error(json.message);
                }
            } catch(e) { listEl.innerHTML = `<div style="color:#f56565; padding:10px;">エラー: ${e.message}</div>`; }
        }

        async function processUploadNew() {
            const name = document.getElementById('newBoardInput').value.trim();
            if(!name) return alert("名前を入力してください");
            processUpload(name);
        }

        async function processUploadCurrent() {
            await processUpload(boardNames[currentTabId]);
        }

        async function processUpload(boardName) {
            const pass = await getAuthPassword(); if (!pass) return;
            if(!confirm(`ボード「${boardName}」として保存しますか？`)) return;
            updateStatus("送信中...", false);
            try {
                const activeStore = getActiveStore();
                const tx = db.transaction([activeStore], 'readonly');
                const req = tx.objectStore(activeStore).getAll();
                let records = await new Promise(r => req.onsuccess = () => r(req.result));
                records.sort((a,b) => (a.order || 0) - (b.order || 0));

                const exportData = [];
                for(let r of records) {
                    let b64 = null;
                    if(r.hasMedia && r.mediaBlob) b64 = await blobToBase64(r.mediaBlob);
                    exportData.push({
                        id: r.id, title: r.title, order: r.order,
                        layoutPC: r.layoutPC, layoutMobile: r.layoutMobile, fontSize: r.fontSize,
                        text: r.text, hasMedia: r.hasMedia, mediaType: r.mediaType, mediaBase64: b64
                    });
                }
                const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&boardName=${encodeURIComponent(boardName)}`;
                const res = await fetch(url, { method: 'POST', body: JSON.stringify(exportData) });
                const json = await res.json();
                
                if(json.status === 'success') { 
                    boardNames[currentTabId] = boardName;
                    await setSetting(`board_name_${currentTabId}`, boardName);
                    updateBoardDisplay(); document.getElementById('newBoardInput').value = "";
                    updateStatus("保存完了", true); alert(`保存完了: ${boardName}`);
                    refreshBoardList(); 
                } else throw new Error(json.message);
            } catch(e) { console.error(e); updateStatus("UP失敗", false, true); alert(e.message); }
        }

        async function deleteBoard(boardName) {
            if(!confirm(`「${boardName}」を削除しますか？`)) return;
            updateStatus("削除中...", false);
            const pass = await getAuthPassword();
            try {
                const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=delete&boardName=${encodeURIComponent(boardName)}`;
                const res = await fetch(url, { method: 'POST' });
                const json = await res.json();
                if(json.status === 'success') { updateStatus("削除完了", true); refreshBoardList(); }
                else throw new Error(json.message);
            } catch(e) { alert("削除失敗: " + e.message); updateStatus("削除失敗", false, true); }
        }

        async function processDownload(boardName) {
            if(!confirm(`ボード「${boardName}」を読み込みますか？\n(現在の作業内容は上書きされます)`)) return;
            updateStatus("受信中...", false);
            const pass = await getAuthPassword(); 
            try {
                const url = `${GAS_API_URL}?auth=${encodeURIComponent(pass)}&action=download&boardName=${encodeURIComponent(boardName)}`;
                const res = await fetch(url, { method: 'POST', body: "" });
                const text = await res.text();
                let importData;
                try { importData = JSON.parse(text); } catch(e) { throw new Error("JSON Parse Error"); }
                if (importData.status === 'error') throw new Error(importData.message);

                await clearAllData(true); 

                const savePromises = [];
                const activeStore = getActiveStore();
                for(let i=0; i<importData.length; i++) {
                    let r = importData[i];
                    let blob = null;
                    if(r.hasMedia && r.mediaBase64) blob = await base64ToBlob(r.mediaBase64);
                    if(blob) blobCache[r.id] = { blob: blob, type: r.mediaType };
                    
                    let lPC = r.layoutPC || { x: r.x||'50px', y: r.y||'50px', w: r.w||'320px', h: r.h||'400px', z: r.z||100 };
                    let lMob = r.layoutMobile || { h: '350px', w: '100%' };
                    let fSize = r.fontSize || '14px';
                    let title = r.title || `Window ${r.id}`;
                    let order = (r.order !== undefined) ? r.order : i;
                    
                    const record = {
                        id: r.id, title: title, order: order,
                        layoutPC: lPC, layoutMobile: lMob, fontSize: fSize,
                        text: r.text, hasMedia: r.hasMedia, mediaBlob: blob, mediaType: r.mediaType
                    };
                    
                    const p = new Promise((resolve, reject) => {
                        const tx = db.transaction([activeStore], 'readwrite');
                        tx.objectStore(activeStore).put(record);
                        tx.oncomplete = () => resolve();
                        tx.onerror = (e) => reject(e);
                    });
                    savePromises.push(p);
                }

                await Promise.all(savePromises);

                boardNames[currentTabId] = boardName;
                await setSetting(`board_name_${currentTabId}`, boardName);
                
                updateBoardDisplay();
                loadFromDB(); 
                
                closeModal('cloudModal'); 
                updateStatus("読込完了", true);
                alert(`読み込み完了: ${boardName}`);
            } catch(e) { console.error(e); updateStatus("DOWN失敗", false, true); alert(e.message); }
        }

        function blobToBase64(blob) { return new Promise((r,j)=>{const z=new FileReader();z.onloadend=()=>r(z.result);z.onerror=j;z.readAsDataURL(blob);}); }
        async function base64ToBlob(b64) { const r=await fetch(b64); return await r.blob(); }

        function initDB() {
            return new Promise((resolve, reject) => {
                const r = indexedDB.open(DB_NAME, DB_VERSION);
                r.onupgradeneeded = (e) => {
                    const d = e.target.result;
                    if (!d.objectStoreNames.contains(STORE_WINDOWS)) d.createObjectStore(STORE_WINDOWS, { keyPath: 'id' });
                    if (!d.objectStoreNames.contains(STORE_WINDOWS_2)) d.createObjectStore(STORE_WINDOWS_2, { keyPath: 'id' });
                    if (!d.objectStoreNames.contains(STORE_WINDOWS_3)) d.createObjectStore(STORE_WINDOWS_3, { keyPath: 'id' });
                    if (!d.objectStoreNames.contains(STORE_SETTINGS)) d.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
                };
                r.onsuccess = (e) => { db = e.target.result; resolve(db); };
                r.onerror = (e) => reject(e);
            });
        }
        
        async function saveWindowToDB(winId) {
            if (!db) return;
            const el = document.getElementById(winId); if (!el) return;
            const idNum = parseInt(winId.split('-')[1]);
            const isMobile = window.innerWidth <= 768;
            
            const titleInput = el.querySelector('.win-title-input');
            
            const hasMediaContent = !!blobCache[idNum]; 
            let blob = null, type = null;
            if (hasMediaContent) { blob = blobCache[idNum].blob; type = blobCache[idNum].type; }
            
            const allWins = Array.from(document.getElementById('canvas').children);
            const myOrder = allWins.indexOf(el);

            const activeStore = getActiveStore();
            const tx = db.transaction([activeStore], 'readonly');
            const old = await new Promise(r => { const req = tx.objectStore(activeStore).get(idNum); req.onsuccess = () => r(req.result); });
            
            let layoutPC = (old && old.layoutPC) ? old.layoutPC : { x:'50px', y:'50px', w:'320px', h:'400px', z:100, fontSize: '14px' };
            let layoutMobile = (old && old.layoutMobile) ? old.layoutMobile : { h:'350px', w:'100%', fontSize: '14px', dockedHeight: '250px' };
            
            let currentFontSize = el.style.getPropertyValue('--font-size') || '14px';
            const isDocked = el.classList.contains('docked-bottom');
            layoutMobile.isDocked = isDocked;

            if (isMobile) { 
                if(isDocked) {
                    layoutMobile.dockedHeight = el.style.height;
                } else {
                    layoutMobile.h = el.style.height; 
                    layoutMobile.w = el.style.width; 
                }
                layoutMobile.fontSize = currentFontSize;
            } else { 
                layoutPC.x = el.style.left; layoutPC.y = el.style.top; 
                layoutPC.w = el.style.width; layoutPC.h = el.style.height; 
                layoutPC.z = parseInt(el.style.zIndex || 100);
                layoutPC.fontSize = currentFontSize;
            }
            
            const textContent = getWindowText(winId);
            const data = {
                id: idNum, title: titleInput.value, order: myOrder,
                layoutPC: layoutPC, layoutMobile: layoutMobile, 
                fontSize: currentFontSize, 
                text: textContent, hasMedia: hasMediaContent, mediaBlob: blob, mediaType: type
            };

            return new Promise(res => {
                const tx2 = db.transaction([activeStore], 'readwrite');
                tx2.objectStore(activeStore).put(data);
                tx2.oncomplete = () => { updateStatus('保存済', true); res(); };
            });
        }
        async function deleteWindowFromDB(id) {
            if(!db) return;
            const activeStore = getActiveStore();
            const tx = db.transaction([activeStore], 'readwrite');
            tx.objectStore(activeStore).delete(id);
            delete blobCache[id];
        }
        async function loadFromDB() {
            if(!db) return;
            document.getElementById('canvas').innerHTML = '';
            const activeStore = getActiveStore();
            const tx = db.transaction([activeStore], 'readonly');
            const req = tx.objectStore(activeStore).getAll();
            req.onsuccess = (e) => {
                let r = e.target.result;
                r.sort((a,b) => { if (a.order !== undefined && b.order !== undefined) return a.order - b.order; return a.id - b.id; });
                if(r.length===0){ addWindow(50,50,1); addWindow(400,50,2); }
                else r.forEach(rec => restoreWindow(rec));
                updateStatus('Ready', true);
            };
        }
        async function clearAllData(skip=false) {
            if(!skip && !confirm("現在のタブのデータを全削除しますか？")) return;
            if (window.cmDestroyAllEditors) window.cmDestroyAllEditors();
            document.getElementById('canvas').innerHTML=''; blobCache={};
            const activeStore = getActiveStore();
            const tx = db.transaction([activeStore], 'readwrite');
            tx.objectStore(activeStore).clear();
            if(!skip) updateStatus('削除完了', true);
        }
        async function toggleAutoSave() { 
            isAutoSaveEnabled = document.getElementById('autoSaveToggle').checked; 
            document.getElementById('btn-manual-save').disabled = isAutoSaveEnabled;
            await setSetting('auto_save_enabled', isAutoSaveEnabled);
        }
        function notifyChange(winId) {
            if (!isAutoSaveEnabled) return;
            if (saveTimers[winId]) clearTimeout(saveTimers[winId]);
            updateStatus('変更...', false);
            saveTimers[winId] = setTimeout(async () => {
                if(isSaving) { notifyChange(winId); return; }
                isSaving=true;
                try { await saveWindowToDB(winId); } finally { isSaving=false; delete saveTimers[winId]; }
            }, 1000);
        }
        async function manualSaveAll() {
            if(isSaving) return;
            isSaving=true; document.getElementById('btn-manual-save').disabled=true;
            updateStatus('保存中...', false);
            const wins=document.querySelectorAll('.window');
            for(const w of wins) await saveWindowToDB(w.id);
            isSaving=false; updateStatus('保存完了', true);
            if(!isAutoSaveEnabled) document.getElementById('btn-manual-save').disabled=false;
        }
        function updateStatus(m,s,e=false) {
            const el=document.getElementById('status-indicator'); el.textContent=m; el.className='';
            if(s) el.classList.add('saved'); if(e) el.classList.add('error');
        }
        function createNewWindow() {
            let max=0; document.querySelectorAll('.window').forEach(w=>{ const id=parseInt(w.id.split('-')[1]); if(id>max) max=id; });
            addWindow(50,50,max+1);
        }
        function addWindow(x,y,idNum, layoutPC=null, layoutMobile=null, fontSize=null, title=null) {
            const winId='win-'+idNum;
            const isMobile = window.innerWidth <= 768;
            const initialTitle = title || `Window ${idNum}`;
            
            let styleStr = "";
            let w = '320px', h = '400px', z = null;
            let isDocked = false;
            let targetFontSize = fontSize || '14px';

            if (isMobile) {
                h = (layoutMobile && layoutMobile.h) ? layoutMobile.h : '350px';
                let dockedH = (layoutMobile && layoutMobile.dockedHeight) ? layoutMobile.dockedHeight : '250px';
                let wMob = (layoutMobile && layoutMobile.w) ? layoutMobile.w : '100%';
                if(layoutMobile && layoutMobile.isDocked) isDocked = true;
                if (!fontSize && layoutMobile && layoutMobile.fontSize) targetFontSize = layoutMobile.fontSize;
                let applyH = isDocked ? dockedH : h;
                styleStr = `height:${applyH}; width:${wMob}; --font-size:${targetFontSize};`;
            } else {
                if (layoutPC) { x = layoutPC.x; y = layoutPC.y; w = layoutPC.w; h = layoutPC.h; z = layoutPC.z; }
                if (!fontSize && layoutPC && layoutPC.fontSize) targetFontSize = layoutPC.fontSize;
                if(z===null || z===undefined){ zIndexCounter++; z=zIndexCounter; }
                else if(z>zIndexCounter) zIndexCounter=z;
                styleStr = `left:${x}; top:${y}; width:${w}; height:${h}; z-index:${z}; --font-size:${targetFontSize};`;
            }
            
            const div=document.createElement('div');
            div.className='window' + (isDocked ? ' docked-bottom' : '');
            div.id=winId; div.style.cssText = styleStr;
            
            if(isDocked) updateCanvasPadding(parseInt(div.style.height, 10));

            const widthBtnLabel = (div.style.width === '100%' || !div.style.width) ? '1/2' : 'Full';
            const dockBtnClass = isDocked ? 'btn-active' : '';

            div.innerHTML=`
                <div class="win-header" onmousedown="startDrag(event,'${winId}')">
                    <button class="btn-header-icon mobile-only" onclick="moveWindow('${winId}', -1)">↑</button>
                    <button class="btn-header-icon mobile-only" onclick="moveWindow('${winId}', 1)">↓</button>
                    <input type="text" class="win-title-input" value="${initialTitle}" onchange="notifyChange('${winId}')" onmousedown="event.stopPropagation()">
                    <div class="win-drag-area"></div>
                    <button class="btn-delete" onclick="removeWindow('${winId}')">×</button>
                </div>
                <div class="win-body" onmousedown="bringToFront('${winId}')" ondragover="handleDragOver(event,this)" ondragleave="handleDragLeave(event,this)" ondrop="handleDrop(event,'${winId}')">
                    <div class="win-tools">
                        <div class="tools-text-group">
                            <button class="btn-tool" onclick="pasteToArea(${idNum})">Paste</button>
                            <button class="btn-tool btn-format" onclick="formatContent(${idNum})">整形</button>
                            <div style="width:5px;"></div>
                            <button class="btn-tool btn-font" onclick="changeFontSize(${idNum}, -2)">A-</button>
                            <button class="btn-tool" onclick="resetFontSize(${idNum})" title="Reset">Def</button>
                            <button class="btn-tool btn-font" onclick="changeFontSize(${idNum}, 2)">A+</button>
                        </div>

                        <div style="flex-grow:1;"></div>
                        
                        <button class="btn-tool btn-danger" id="btn-media-del-${idNum}" onclick="closeMedia(${idNum})" title="メディア削除" style="display:none; padding:4px 6px;">🗑️</button>
                        <button class="btn-tool" id="btn-media-toggle-${idNum}" onclick="toggleMediaVisibility(${idNum})" title="表示切替" style="display:none;">🎬</button>

                        <button class="btn-tool mobile-only" id="btn-width-${idNum}" onclick="toggleMobileWidth(${idNum})">${widthBtnLabel}</button>
                        <button class="btn-tool mobile-only ${dockBtnClass}" id="btn-dock-${idNum}" onclick="toggleDock(${idNum})" title="画面下に固定">⚓</button>
                    </div>
                    
                    <textarea id="text-${idNum}" style="font-size:${targetFontSize};" oninput="notifyChange('${winId}')"></textarea>
                    
                    <div id="media-${idNum}" class="media-layer">
                        <div id="media-content-${idNum}" style="width:100%;height:100%;display:flex;justify-content:center;align-items:center;"></div>
                    </div>
                    
                    <div class="mobile-resize-handle" onmousedown="event.stopPropagation()" ontouchstart="startMobileResize(event, '${winId}')"></div>
                </div>`;
            
            document.getElementById('canvas').appendChild(div);

            div.addEventListener('mouseup', ()=> { if(currentDragWin!==div) notifyChange(winId); });
            // 連動スクロールはCodeMirror側（cm-init.js）で処理するため、ここでは登録しない
            
            if(!isDocked) bringToFront(winId);
            return div;
        }
        function restoreWindow(r) {
            let lPC = r.layoutPC || { x:r.x, y:r.y, w:r.w, h:r.h, z:r.z, fontSize: r.fontSize };
            let lMob = r.layoutMobile || { h: '350px', w: '100%', fontSize: r.fontSize };

            const w = addWindow(0,0,r.id, lPC, lMob, null, r.title);
            
            if(r.text) {
                const ta = w.querySelector('textarea');
                if (ta) ta.value = r.text;
                setWindowText(w.id, r.text);
            }
            if(r.hasMedia && r.mediaBlob) { 
                blobCache[r.id]={blob:r.mediaBlob, type:r.mediaType}; 
                showMedia(r.id, r.mediaBlob, r.mediaType); 
            }
        }
        function removeWindow(id) { 
            if(confirm("削除しますか？")){ 
                const el=document.getElementById(id); 
                if(el){ 
                    if(el.classList.contains('docked-bottom')) updateCanvasPadding(0);
                    el.remove(); 
                    deleteWindowFromDB(parseInt(id.split('-')[1])); 
                } 
            } 
        }
        
        let dockingWin = null;
        let dockStartY = 0;
        let dockStartH = 0;

        function startDockResize(e, winId) {
            dockingWin = document.getElementById(winId);
            if (!dockingWin) return;

            const touch = e.touches[0];
            dockStartY = touch.clientY;
            
            const style = window.getComputedStyle(dockingWin);
            dockStartH = parseInt(style.height, 10);
            
            if (isNaN(dockStartH)) dockStartH = 350; 

            document.addEventListener('touchmove', onDockResizeMove, {passive: false});
            document.addEventListener('touchend', onDockResizeEnd);
        }

        function onDockResizeMove(e) {
            if (!dockingWin) return;
            if (e.cancelable) e.preventDefault();

            const touch = e.touches[0];
            const diff = dockStartY - touch.clientY; 
            let newH = dockStartH + diff;

            if (newH < 150) newH = 150;
            if (newH > window.innerHeight - 50) newH = window.innerHeight - 50;

            dockingWin.style.height = newH + 'px';
            updateCanvasPadding(newH);
        }
        function onDockResizeEnd(e) {
            if (dockingWin) {
                notifyChange(dockingWin.id); 
                updateCanvasPadding(parseInt(dockingWin.style.height, 10));
            }
            dockingWin = null;
            document.removeEventListener('touchmove', onDockResizeMove);
            document.removeEventListener('touchend', onDockResizeEnd);
        }

        function toggleMobileWidth(idNum) { 
            const win = document.getElementById(`win-${idNum}`); 
            const btn = document.getElementById(`btn-width-${idNum}`); 
            const currentW = win.style.width; 
            if (currentW === '100%' || !currentW) { win.style.width = 'calc(50% - 5px)'; btn.textContent = 'Full'; } 
            else { win.style.width = '100%'; btn.textContent = '1/2'; } 
            notifyChange(`win-${idNum}`); 
        }

        async function toggleDock(idNum) {
            const winId = `win-${idNum}`;
            const win = document.getElementById(winId);
            const btn = document.getElementById(`btn-dock-${idNum}`);
            const wasDocked = win.classList.contains('docked-bottom');

            document.querySelectorAll('.window.docked-bottom').forEach(w => {
                w.classList.remove('docked-bottom');
                w.style.height = '350px'; 
                
                const oid = w.id.split('-')[1];
                const b = document.getElementById(`btn-dock-${oid}`);
                if(b) b.classList.remove('btn-active');
            });

            if(!wasDocked) {
                let savedDockH = '250px';
                try {
                    const activeStore = getActiveStore();
                    const tx = db.transaction([activeStore], 'readonly');
                    const r = await new Promise(resolve => {
                        const req = tx.objectStore(activeStore).get(idNum);
                        req.onsuccess = () => resolve(req.result);
                    });
                    if(r && r.layoutMobile && r.layoutMobile.dockedHeight) {
                        savedDockH = r.layoutMobile.dockedHeight;
                    }
                } catch(e) {}

                win.classList.add('docked-bottom');
                win.style.height = savedDockH; 
                
                btn.classList.add('btn-active');
                updateCanvasPadding(parseInt(savedDockH, 10));
            } else {
                win.style.height = '350px'; 
                updateCanvasPadding(0);
            }
            notifyChange(winId);
        }
        function updateCanvasPadding(px) {
            const buffer = (px > 0) ? 80 : 200;
            document.getElementById('canvas').style.paddingBottom = (px + buffer) + 'px';
        }

        function toggleMediaVisibility(idNum) {
            const layer = document.getElementById(`media-${idNum}`);
            const win = document.getElementById(`win-${idNum}`);
            
            layer.classList.toggle('hidden-media');
            
            if(layer.classList.contains('hidden-media')) {
                win.classList.remove('media-mode');
            } else {
                win.classList.add('media-mode');
            }
        }
        
        let resizingWin = null; let startTouchY = 0; let startHeight = 0;
        function startMobileResize(e, winId) { e.preventDefault(); resizingWin = document.getElementById(winId); const touch = e.touches[0]; startTouchY = touch.clientY; startHeight = parseInt(window.getComputedStyle(resizingWin).height, 10); document.addEventListener('touchmove', onMobileResizeMove, {passive: false}); document.addEventListener('touchend', onMobileResizeEnd); }
        function onMobileResizeMove(e) { if (!resizingWin) return; e.preventDefault(); const touch = e.touches[0]; const newH = startHeight + (touch.clientY - startTouchY); if (newH > 100) resizingWin.style.height = newH + 'px'; }
        function onMobileResizeEnd(e) { if (resizingWin) notifyChange(resizingWin.id); resizingWin = null; document.removeEventListener('touchmove', onMobileResizeMove); document.removeEventListener('touchend', onMobileResizeEnd); }
        
        function changeFontSize(idNum, delta) {
            const win = document.getElementById(`win-${idNum}`);
            if(!win) return;
            let current = parseInt(win.style.getPropertyValue('--font-size') || "14");
            let next = current + delta;
            if(next < 10) next = 10;
            if(next > 60) next = 60;
            const sizeStr = next + "px";
            win.style.setProperty('--font-size', sizeStr);
            const winId = `win-${idNum}`;
            if (window.cmSetEditorFontSize) {
                window.cmSetEditorFontSize(winId, next);
            }
            const ta = document.getElementById(`text-${idNum}`);
            if(ta) ta.style.fontSize = sizeStr;
            notifyChange(winId);
        }
        
        function resetFontSize(idNum) {
            const win = document.getElementById(`win-${idNum}`);
            if(!win) return;
            win.style.setProperty('--font-size', "14px");
            const winId = `win-${idNum}`;
            if (window.cmSetEditorFontSize) {
                window.cmSetEditorFontSize(winId, 14);
            }
            const ta = document.getElementById(`text-${idNum}`);
            if(ta) ta.style.fontSize = "14px";
            notifyChange(winId);
        }
        
        let currentDragWin=null, dx=0, dy=0;
        function startDrag(e,id) { 
            const w=document.getElementById(id);
            if(w.classList.contains('docked-bottom')) return; 
            if(e.target.tagName==='INPUT' || e.target.tagName==='BUTTON') return; 
            if(window.innerWidth<=768)return; 
            bringToFront(id); currentDragWin=w; dx=e.clientX-w.offsetLeft; dy=e.clientY-w.offsetTop; document.addEventListener('mousemove',onMouseMove); document.addEventListener('mouseup',onMouseUp); 
        }
        function onMouseMove(e){ if(!currentDragWin)return; let nx=e.clientX-dx, ny=e.clientY-dy; if(ny<0)ny=0; currentDragWin.style.left=nx+'px'; currentDragWin.style.top=ny+'px'; }
        function onMouseUp(){ if(currentDragWin) notifyChange(currentDragWin.id); currentDragWin=null; document.removeEventListener('mousemove',onMouseMove); document.removeEventListener('mouseup',onMouseUp); }
        
        function bringToFront(id){ const w=document.getElementById(id); zIndexCounter++; w.style.zIndex=zIndexCounter; document.querySelectorAll('.window').forEach(e=>e.classList.remove('active')); w.classList.add('active'); notifyChange(id); }
        function moveWindow(winId, dir) { const el = document.getElementById(winId); const parent = el.parentNode; if (dir === -1) { if (el.previousElementSibling) { parent.insertBefore(el, el.previousElementSibling); manualSaveAll(); } } else { if (el.nextElementSibling) { parent.insertBefore(el.nextElementSibling, el); manualSaveAll(); } } }

        async function pasteToArea(id){
            try {
                const t = await navigator.clipboard.readText();
                const winId = 'win-' + id;
                const editor = window.cmEditorInstances && window.cmEditorInstances[winId];
                if (editor) {
                    editor.replaceSelection(t);
                } else {
                    const ta = document.getElementById('text-' + id);
                    const start = ta.selectionStart;
                    const end = ta.selectionEnd;
                    const val = ta.value;
                    ta.value = val.substring(0, start) + t + val.substring(end);
                }
                notifyChange(winId);
            } catch(e) { alert('ペースト権限なし'); }
        }
        
        function formatContent(id){ 
            const winId = 'win-' + id;
            let t = getWindowText(winId);
            if(!t)return; 
            
            t = t.replace(/\r\n/g,'\n');
            t = t.replace(/\n{2,}/g, '\n');
            t = t.replace(/([^\n])(【)/g,'$1\n\n$2') 
                 .replace(/\s+(\d+\.)/g,'\n$1')
                 .replace(/([^\n])(「)/g,(m,p1,p2)=> /[\d\.\s]/.test(p1)?m:p1+'\n'+p2)
                 .replace(/(」)(\s+)(\d+\.)/g,'$1\n$3'); 
            
            setWindowText(winId, t);
            notifyChange(winId); 
        }
        
        function showMedia(id,blob,type) { 
            const c=document.getElementById(`media-content-${id}`); c.innerHTML=''; 
            const url=URL.createObjectURL(blob); let el; 
            if(type.startsWith('image/')) { el=document.createElement('img'); el.src=url; } 
            else if(type.startsWith('video/')) { el=document.createElement('video'); el.src=url; el.controls=true; el.loop=true; el.muted=true; el.playsInline=true; } 
            if(el){ 
                el.className='media-content'; c.appendChild(el); 
                const layer = document.getElementById(`media-${id}`);
                layer.classList.add('show');
                layer.classList.remove('hidden-media'); 
                
                document.getElementById(`win-${id}`).classList.add('media-mode');

                document.getElementById(`btn-media-toggle-${id}`).style.display = 'inline-block';
                document.getElementById(`btn-media-del-${id}`).style.display = 'inline-block';
            } 
        }
        function handleDragOver(e,el){ e.preventDefault(); e.stopPropagation(); el.closest('.window').classList.add('drag-over-active'); }
        function handleDragLeave(e,el){ e.preventDefault(); e.stopPropagation(); el.closest('.window').classList.remove('drag-over-active'); }
        function handleDrop(e,winId){ e.preventDefault(); e.stopPropagation(); document.getElementById(winId).classList.remove('drag-over-active'); const f=e.dataTransfer.files[0]; if(!f)return; const id=parseInt(winId.split('-')[1]); blobCache[id]={blob:f, type:f.type}; showMedia(id,f,f.type); notifyChange(winId); }
        function closeMedia(id){ 
            if(!confirm("メディアを削除しますか？")) return;
            document.getElementById(`media-${id}`).classList.remove('show');
            document.getElementById(`media-${id}`).classList.remove('hidden-media');
            
            const c=document.getElementById(`media-content-${id}`); 
            if(c.firstChild) URL.revokeObjectURL(c.firstChild.src); 
            c.innerHTML=''; 
            delete blobCache[id]; 
            
            document.getElementById(`win-${id}`).classList.remove('media-mode');

            document.getElementById(`btn-media-toggle-${id}`).style.display = 'none';
            document.getElementById(`btn-media-del-${id}`).style.display = 'none';
            
            notifyChange('win-'+id); 
        }
