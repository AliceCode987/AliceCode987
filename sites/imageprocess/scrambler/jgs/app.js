/**
 * JGS-V5 WASM v2 — Application entry point (ES module)
 *
 * Architecture:
 *  - Web Worker owns the WASM instance; main thread only drives the UI.
 *  - Atomic state machine: every async operation is guarded by stateVersion.
 *  - WebP / AVIF: decoded by OffscreenCanvas → RGBA bytes → processRgba().
 *  - All other formats: raw file bytes → processImage().
 *  - Download: Blob built directly from WASM output bytes, no Canvas.
 *  - i18n: JSON files loaded from i18n/<lang>.json.
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const LANGS_META = [
    { code: 'zh-Hans', label: '简体中文', short: '简体' },
    { code: 'zh-Hant', label: '繁體中文', short: '繁體' },
    { code: 'en', label: 'English', short: 'EN' },
];

// Formats that must be decoded by the browser (not by the Rust image crate)
const BROWSER_DECODE_FORMATS = new Set(['image/webp', 'image/avif']);

// ── State ──────────────────────────────────────────────────────────────────────
let currentLang = 'zh-Hans';
let langData = {};       // loaded from i18n/<lang>.json
let stateVer = 0;        // bumped on each new image load or clear

// Image state
let origFileBytes = null;  // Uint8Array | null — raw file bytes of the current image
let origMimeType = '';    // MIME type of the current image
let origRgba = null;  // Uint8Array | null — for WebP/AVIF (RGBA pixels)
let origWidth = 0;     // for WebP/AVIF
let origHeight = 0;
let resultBytes = null;  // Uint8Array | null — raw output bytes of last operation
let resultBlob = null;  // Blob | null — last processed output
let resultUrl = null;  // Object URL for the result blob
let origUrl = null;  // Object URL for the original image preview
let hasResult = false;
let lastAction = null;  // 'scramble' | 'restore' | null
let lastResultParams = null; // params snapshot when result was last computed
let pendingDownloadAfterProcess = false; // triggers download after stale re-process
// ── Worker pool ────────────────────────────────────────────────────────────────
let worker = null;
let pendingRequests = new Map(); // id → { resolve, reject }
let nextId = 1;

function initWorker() {
    worker = new Worker('./worker.js', { type: 'module' });
    worker.onmessage = (ev) => {
        const { id, ok, result, error } = ev.data;
        const req = pendingRequests.get(id);
        if (!req) return;
        pendingRequests.delete(id);
        if (ok) req.resolve(result);
        else req.reject(new Error(error));
    };
    worker.onerror = (ev) => {
        // Reject all pending requests and restart the worker so future
        // calls continue to work after a transient crash.
        for (const [, req] of pendingRequests) {
            req.reject(new Error(`Worker error: ${ev.message}`));
        }
        pendingRequests.clear();
        // Reinitialise so subsequent workerCall()s get a fresh instance.
        initWorker();
    };
}

function workerCall(type, payload, transfer = []) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        pendingRequests.set(id, { resolve, reject });
        worker.postMessage({ id, type, payload }, transfer);
    });
}

// ── i18n ───────────────────────────────────────────────────────────────────────
async function loadLang(code) {
    const resp = await fetch(`./i18n/${code}.json`);
    if (!resp.ok) throw new Error(`Failed to load language: ${code}`);
    return resp.json();
}

function t(key) {
    return langData[key] ?? key;
}

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        const val = t(key);
        el.textContent = val;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    // Modal bodies use innerHTML (trusted static strings from our own JSON)
    const helpBody = document.getElementById('help-body');
    const legalBody = document.getElementById('legal-body');
    if (helpBody) helpBody.innerHTML = t('help_body');
    if (legalBody) legalBody.innerHTML = t('legal_body');
    // Info labels for compare slider
    const cmpL = document.getElementById('cmp-label-l');
    const cmpR = document.getElementById('cmp-label-r');
    if (cmpL) cmpL.textContent = t('pane_original');
    if (cmpR) cmpR.textContent = t('pane_result');
    // Status text
    updateStatus(currentStatusKey, currentStatusState);
    // Re-render format options
    renderFormatOpts();
    // Refresh key badge in the new language
    updateKeyBadge();
}

async function switchLang(code) {
    try {
        langData = await loadLang(code);
        currentLang = code;
        localStorage.setItem('lang', code);
        document.documentElement.lang = code;
        applyTranslations();
        renderLangMenu();
        const label = LANGS_META.find(m => m.code === code)?.short ?? code;
        document.getElementById('lang-label').textContent = label;
    } catch (e) {
        console.error('Language load failed:', e);
    }
}

function renderLangMenu() {
    const menu = document.getElementById('lang-menu');
    menu.innerHTML = '';
    LANGS_META.forEach(meta => {
        const el = document.createElement('div');
        el.className = 'lang-option' + (meta.code === currentLang ? ' active' : '');
        el.role = 'option';
        el.setAttribute('aria-selected', meta.code === currentLang ? 'true' : 'false');
        el.innerHTML = `<span class="lang-option-check">${meta.code === currentLang ? '✓' : ''}</span>${meta.label}`;
        el.addEventListener('click', () => {
            switchLang(meta.code);
            closeLangDropdown();
        });
        menu.appendChild(el);
    });
}

// ── Status bar ─────────────────────────────────────────────────────────────────
let currentStatusKey = 'status_ready';
let currentStatusState = 'idle';

function updateStatus(key, state = 'idle') {
    currentStatusKey = key;
    currentStatusState = state;
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!dot || !text) return;
    dot.className = 'status-dot';
    if (state === 'busy') dot.classList.add('busy');
    if (state === 'ok') dot.classList.add('ok');
    if (state === 'error') dot.classList.add('error');
    if (state === 'warn') dot.classList.add('warn');
    text.textContent = t(key);
}

// ── Theme ──────────────────────────────────────────────────────────────────────
function applyTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.getElementById('icon-light').style.display = dark ? 'none' : '';
    document.getElementById('icon-dark').style.display = dark ? '' : 'none';
    localStorage.setItem('theme', dark ? 'dark' : 'light');
}

// ── Format options rendering ───────────────────────────────────────────────────
let jpegQuality = 100;
let jpegSubsampling = 0;   // 0=4:4:4, 1=4:2:2, 2=4:2:0
let pngCompression = 6;

function renderFormatOpts() {
    const container = document.getElementById('format-opts');
    if (!container) return;
    const fmt = document.getElementById('out-format')?.value ?? '0';
    container.innerHTML = '';

    if (fmt === '0') {
        // JPEG: quality slider + chroma subsampling select
        const pct = ((jpegQuality - 1) / 99 * 100).toFixed(1);

        const qualRow = document.createElement('div');
        qualRow.className = 'quality-row';
        qualRow.innerHTML = `
      <label for="jpeg-quality">${t('quality_label')}</label>
      <input id="jpeg-quality" type="range" class="q-slider" min="1" max="100" value="${jpegQuality}"
        style="--qpct:${pct}%" aria-label="JPEG quality">
      <span class="quality-val" id="jpeg-quality-val">${jpegQuality}</span>`;
        container.appendChild(qualRow);

        const subSel = document.createElement('select');
        subSel.className = 'field-input';
        subSel.id = 'jpeg-subsampling';
        subSel.setAttribute('aria-label', t('subsampling_label'));
        [
            [0, t('sub_444')],
            [1, t('sub_422')],
            [2, t('sub_420')],
        ].forEach(([val, label]) => {
            const o = document.createElement('option');
            o.value = val;
            o.textContent = label;
            if (val === jpegSubsampling) o.selected = true;
            subSel.appendChild(o);
        });
        container.appendChild(subSel);

        const note = document.createElement('div');
        note.className = 'format-note';
        note.textContent = t('jpeg_hint');
        container.appendChild(note);

        // Warn: subsampling must match between scramble and restore
        const warnNote = document.createElement('div');
        warnNote.className = 'format-note warn';
        warnNote.textContent = t('sub_warn');
        container.appendChild(warnNote);

        // Warn: dimensions must be preserved for restoration
        const sizeNote = document.createElement('div');
        sizeNote.className = 'format-note warn';
        sizeNote.textContent = t('size_warn');
        container.appendChild(sizeNote);

        // Events
        qualRow.querySelector('#jpeg-quality').addEventListener('input', (e) => {
            jpegQuality = parseInt(e.target.value, 10);
            const p = ((jpegQuality - 1) / 99 * 100).toFixed(1);
            e.target.style.setProperty('--qpct', p + '%');
            document.getElementById('jpeg-quality-val').textContent = jpegQuality;
            updateStaleIndicator();
        });
        subSel.addEventListener('change', (e) => {
            jpegSubsampling = parseInt(e.target.value, 10);
            updateStaleIndicator();
        });

    } else {
        // PNG: compression level slider
        const pct = (pngCompression / 9 * 100).toFixed(1);

        const compRow = document.createElement('div');
        compRow.className = 'quality-row';
        compRow.innerHTML = `
      <label for="png-compression">${t('png_compression_label')}</label>
      <input id="png-compression" type="range" class="q-slider" min="0" max="9" value="${pngCompression}"
        style="--qpct:${pct}%" aria-label="PNG compression level">
      <span class="quality-val" id="png-comp-val">${pngCompression}</span>`;
        container.appendChild(compRow);

        const note = document.createElement('div');
        note.className = 'format-note ok';
        note.textContent = t('png_note');
        container.appendChild(note);

        // Warn: dimensions must be preserved for restoration
        const sizeNote = document.createElement('div');
        sizeNote.className = 'format-note warn';
        sizeNote.textContent = t('size_warn');
        container.appendChild(sizeNote);

        compRow.querySelector('#png-compression').addEventListener('input', (e) => {
            pngCompression = parseInt(e.target.value, 10);
            const p = (pngCompression / 9 * 100).toFixed(1);
            e.target.style.setProperty('--qpct', p + '%');
            document.getElementById('png-comp-val').textContent = pngCompression;
            updateStaleIndicator();
        });
    }
}

// ── Preview / Tab management ───────────────────────────────────────────────────
let activeTab = 'split';

function showTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
        b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
    });
    document.getElementById('view-split').style.display = tab === 'split' ? '' : 'none';
    document.getElementById('view-original').style.display = tab === 'original' ? '' : 'none';
    document.getElementById('view-result').style.display = tab === 'result' ? '' : 'none';
}

function setOriginalImage(url) {
    // Compare left side — always original.
    const cmpOrig = document.getElementById('cmp-orig');
    cmpOrig.src = url;
    cmpOrig.style.display = '';

    // Mirror original on right side until a real result is ready so the
    // compare slider never pops up unexpectedly on first load.
    if (!hasResult) {
        const cmpResult = document.getElementById('cmp-result');
        cmpResult.src = url;
        cmpResult.style.display = '';
    }

    // Single original view
    const svOrig = document.getElementById('sv-orig');
    svOrig.src = url;
    svOrig.style.display = '';
    document.getElementById('sv-orig-empty').style.display = 'none';

    updateCompareVisibility();
}

function setResultImage(url) {
    const cmpResult = document.getElementById('cmp-result');
    cmpResult.src = url;
    cmpResult.style.display = '';

    const svResult = document.getElementById('sv-result');
    svResult.src = url;
    svResult.style.display = '';
    document.getElementById('sv-result-empty').style.display = 'none';

    updateCompareVisibility();
}

function clearResultImage() {
    const cmpResult = document.getElementById('cmp-result');
    // Keep original visible on right side (no slider — hasResult is now false).
    if (origUrl) {
        cmpResult.src = origUrl;
        cmpResult.style.display = '';
    } else {
        cmpResult.src = '';
        cmpResult.style.display = 'none';
    }

    const svResult = document.getElementById('sv-result');
    svResult.src = '';
    svResult.style.display = 'none';
    document.getElementById('sv-result-empty').style.display = '';

    updateCompareVisibility();
}

function updateCompareVisibility() {
    const origVisible = document.getElementById('cmp-orig').style.display !== 'none';
    const rightVisible = document.getElementById('cmp-result').style.display !== 'none';
    // Slider appears only when a real processed result exists (not the mirrored original).
    const showSlider = origVisible && rightVisible && hasResult;
    document.getElementById('cmp-divider').style.display = showSlider ? '' : 'none';
    document.getElementById('cmp-handle').style.display = showSlider ? '' : 'none';
    document.getElementById('cmp-label-l').style.display = showSlider ? '' : 'none';
    document.getElementById('cmp-label-r').style.display = showSlider ? '' : 'none';
    document.getElementById('cmp-empty').style.display = origVisible ? 'none' : '';
    document.getElementById('compare-wrap').classList.toggle('compare-active', showSlider);
}

function clearAllPreviews() {
    ['cmp-orig', 'cmp-result', 'sv-orig', 'sv-result'].forEach(id => {
        const el = document.getElementById(id);
        el.src = '';
        el.style.display = 'none';
    });
    document.getElementById('sv-orig-empty').style.display = '';
    document.getElementById('sv-result-empty').style.display = '';
    // updateCompareVisibility handles divider / handle / labels / empty / cursor.
    updateCompareVisibility();
}

// ── Image info panel ───────────────────────────────────────────────────────────
function showInfo(info) {
    document.getElementById('info-section').style.display = '';
    document.getElementById('info-divider').style.display = '';
    document.getElementById('info-size').textContent = `${info.width} × ${info.height}`;
    document.getElementById('info-blocks').textContent = info.blocks ?? '—';
    document.getElementById('info-chroma').textContent = info.chroma ?? '—';
    document.getElementById('info-fmt').textContent = info.format ?? '—';
}

function hideInfo() {
    document.getElementById('info-section').style.display = 'none';
    document.getElementById('info-divider').style.display = 'none';
}

// ── WASM error translation ─────────────────────────────────────────────────────
function parseWasmError(err) {
    const msg = (err instanceof Error ? err.message : String(err)) || '';

    // err_not_jgs_image:W:H — input dimensions are not multiples of 8
    const notJgsMatch = msg.match(/^err_not_jgs_image:(\d+):(\d+)$/);
    if (notJgsMatch) {
        return t('err_dims').replace('{W}', notJgsMatch[1]).replace('{H}', notJgsMatch[2]);
    }

    // err_jpeg_dim:PW:PH — padded output dimensions exceed JPEG 65535 limit
    const jpegDimMatch = msg.match(/^err_jpeg_dim:(\d+):(\d+)$/);
    if (jpegDimMatch) {
        return t('err_jpeg_dim').replace('{W}', jpegDimMatch[1]).replace('{H}', jpegDimMatch[2]);
    }

    // err_too_large:W:H — image dimensions exceed the safe processing limit
    if (msg.startsWith('err_too_large')) return t('err_too_large');

    // err_zero_dim — image has a zero-sized dimension
    if (msg === 'err_zero_dim') return t('err_zero_dim');

    // err_password_too_long:N:MAX
    if (msg.startsWith('err_password_too_long')) return t('err_password_too_long');

    // Legacy fallback for unstructured messages
    if (msg.toLowerCase().includes('too large')) return t('err_too_large');

    return t('err_invalid_file');
}

// ── File loading ───────────────────────────────────────────────────────────────
async function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) {
        updateStatus('err_invalid_file', 'error');
        return;
    }

    // Revoke old URLs
    if (origUrl) URL.revokeObjectURL(origUrl);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    origUrl = null;
    resultUrl = null;
    resultBlob = null;
    hasResult = false;

    // Bump state version — any in-flight operations using the old version will be dropped
    const myVer = ++stateVer;

    origFileBytes = null;
    origRgba = null;
    resultBytes = null;
    lastAction = null;

    clearResultImage();
    hideInfo();
    document.getElementById('btn-reset').style.display = 'none';
    showDetectHint(false);
    updateStaleIndicator();

    updateStatus('status_busy', 'busy');

    try {
        origMimeType = file.type;
        origUrl = URL.createObjectURL(file);
        setOriginalImage(origUrl);

        const raw = await file.arrayBuffer();
        if (myVer !== stateVer) return; // superseded

        if (BROWSER_DECODE_FORMATS.has(file.type)) {
            // Decode via browser → extract RGBA
            const bitmap = await createImageBitmap(file);
            if (myVer !== stateVer) { bitmap.close(); return; }
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            bitmap.close();
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            origRgba = new Uint8Array(imgData.data.buffer);
            origWidth = canvas.width;
            origHeight = canvas.height;
            // Get info via processRgba proxy — just dimensions and block count
            const pw = Math.ceil(origWidth / 8) * 8;
            const ph = Math.ceil(origHeight / 8) * 8;
            const blocks = (pw / 8) * (ph / 8);
            const isPossiblyJgs = origWidth % 8 === 0 && origHeight % 8 === 0;
            showInfo({
                width: origWidth, height: origHeight, blocks, chroma: '—',
                format: file.type.split('/')[1].toUpperCase()
            });
            showDetectHint(isPossiblyJgs);
        } else {
            origFileBytes = new Uint8Array(raw);
            // Ask WASM for image info
            const info = await workerCall('info', { bytes: origFileBytes });
            if (myVer !== stateVer) return;
            // Detect chroma from JPEG header; auto-fill subsampling + output format.
            const chroma = detectJpegChroma(origFileBytes);
            let formatChanged = false;
            if (file.type === 'image/png') {
                const sel = document.getElementById('out-format');
                if (sel && sel.value !== '1') { sel.value = '1'; formatChanged = true; }
            } else if (file.type === 'image/jpeg') {
                const sel = document.getElementById('out-format');
                if (sel && sel.value !== '0') { sel.value = '0'; formatChanged = true; }
                // Auto-fill subsampling from the detected chroma.
                if (chroma !== null) {
                    const chromaMap = { '4:4:4': 0, '4:2:2': 1, '4:2:0': 2 };
                    if (chromaMap[chroma] !== undefined) jpegSubsampling = chromaMap[chroma];
                    formatChanged = true; // re-render so the subsampling select reflects the detected value
                }
            }
            if (formatChanged) renderFormatOpts();
            const isPossiblyJgs = info.width % 8 === 0 && info.height % 8 === 0;
            showInfo({ ...info, chroma: chroma ?? '—' });
            showDetectHint(isPossiblyJgs);
        }

        updateStatus('status_loaded', 'ok');
    } catch (err) {
        if (myVer !== stateVer) return;
        console.error('Load error:', err);
        const errText = parseWasmError(err);
        const dot = document.getElementById('status-dot');
        const text = document.getElementById('status-text');
        dot.className = 'status-dot error';
        text.textContent = errText;
        currentStatusKey = '';
        currentStatusState = 'error';
    }
}

// ── Process (scramble / restore) ───────────────────────────────────────────────
async function doProcess(decode) {
    // If restoring right after a scramble, feed the scrambled output back in.
    // This enables: upload → scramble → restore (round-trip quality check).
    const useResultAsInput = decode && lastAction === 'scramble' && resultBytes !== null;

    if (!useResultAsInput && !origFileBytes && !origRgba) {
        updateStatus('status_no_image', 'warn');
        return;
    }

    const myVer = stateVer; // read, don't bump
    const password = document.getElementById('password').value;
    const outFormat = parseInt(document.getElementById('out-format').value, 10);

    setButtonsBusy(true);
    updateStatus('status_busy', 'busy');

    // Revoke old result
    if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
    resultBlob = null;
    hasResult = false;

    try {
        let result; // Uint8Array

        if (useResultAsInput) {
            // Decode the previously-scrambled result bytes directly
            result = await workerCall('process', {
                bytes: resultBytes,
                password,
                decode: true,
                outFormat,
                jpegQuality,
                jpegSubsampling,
                pngCompression,
            });
        } else if (origRgba) {
            // WebP / AVIF path (browser-decoded RGBA)
            result = await workerCall('processRgba', {
                rgba: origRgba,
                width: origWidth,
                height: origHeight,
                password,
                decode,
                outFormat,
                jpegQuality,
                jpegSubsampling,
                pngCompression,
            });
        } else {
            // Standard path: raw compressed file bytes
            result = await workerCall('process', {
                bytes: origFileBytes,
                password,
                decode,
                outFormat,
                jpegQuality,
                jpegSubsampling,
                pngCompression,
            });
        }

        if (myVer !== stateVer) return; // superseded

        const mime = outFormat === 0 ? 'image/jpeg' : 'image/png';
        resultBytes = result;
        resultBlob = new Blob([result], { type: mime });
        resultUrl = URL.createObjectURL(resultBlob);
        hasResult = true;
        lastAction = decode ? 'restore' : 'scramble';
        lastResultParams = currentParams();

        // Update compare right-panel label dynamically
        const cmpR = document.getElementById('cmp-label-r');
        if (cmpR) cmpR.textContent = t(decode ? 'pane_restored' : 'pane_scrambled');

        setResultImage(resultUrl);
        document.getElementById('btn-reset').style.display = '';
        updateKeyBadge();
        updateStaleIndicator();
        updateStatus(decode ? 'status_done_dec' : 'status_done_enc', 'ok');

        // If triggered by download (stale re-process), auto-download after.
        if (pendingDownloadAfterProcess) {
            pendingDownloadAfterProcess = false;
            await performDownload();
        }
    } catch (err) {
        if (myVer !== stateVer) return;
        console.error('Process error:', err);
        const errText = parseWasmError(err);
        const dot = document.getElementById('status-dot');
        const text = document.getElementById('status-text');
        dot.className = 'status-dot error';
        text.textContent = errText;
        currentStatusKey = '';
        currentStatusState = 'error';
    } finally {
        if (myVer === stateVer) setButtonsBusy(false);
        pendingDownloadAfterProcess = false; // safety reset on any exit
    }
}

function setButtonsBusy(busy) {
    ['btn-scramble', 'btn-restore', 'btn-reset', 'btn-clear'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = busy;
    });
}

// ── Download ───────────────────────────────────────────────────────────────────
async function performDownload() {
    if (!resultBlob || !resultUrl) return;
    const ext = resultBlob.type === 'image/jpeg' ? 'jpg' : 'png';
    // SHA-256 of result bytes → 8-hex-char filename — no silent overwrites.
    let name = `jgs-${lastAction ?? 'output'}`;
    try {
        const hashBuf = await crypto.subtle.digest('SHA-256', resultBytes);
        const hex = Array.from(new Uint8Array(hashBuf), b => b.toString(16).padStart(2, '0')).join('');
        name = `jgs-${hex.slice(0, 8)}`;
    } catch {
        // crypto.subtle unavailable (non-HTTPS) — keep fallback name
    }
    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = `${name}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function doDownload() {
    if (!hasResult) {
        updateStatus('status_no_result', 'warn');
        return;
    }
    // Functional/atomic: if any param changed since last process, re-derive then download.
    if (!paramsMatch(lastResultParams, currentParams())) {
        pendingDownloadAfterProcess = true;
        await doProcess(lastAction === 'restore');
        return;
    }
    await performDownload();
}

// ── Reset to original ──────────────────────────────────────────────────────────
function doReset() {
    if (!origUrl) return;
    if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
    resultBlob = null;
    resultBytes = null;
    hasResult = false;
    lastAction = null;
    lastResultParams = null;

    // clearResultImage handles right side (shows original, no slider).
    clearResultImage();

    document.getElementById('btn-reset').style.display = 'none';
    updateKeyBadge();
    updateStaleIndicator();
    showDetectHint(false);
    updateStatus('status_reset', 'ok');
}

// ── Clear all ──────────────────────────────────────────────────────────────────
function doClear() {
    stateVer++;
    if (origUrl) { URL.revokeObjectURL(origUrl); origUrl = null; }
    if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
    origFileBytes = null;
    origRgba = null;
    resultBlob = null;
    resultBytes = null;
    hasResult = false;
    lastAction = null;
    clearAllPreviews();
    hideInfo();
    document.getElementById('btn-reset').style.display = 'none';
    document.getElementById('file-input').value = '';
    lastResultParams = null;
    showDetectHint(false);
    updateKeyBadge();
    updateStaleIndicator();
    updateStatus('status_cleared', 'idle');
}

// ── Compare slider ─────────────────────────────────────────────────────────────
function initCompareSlider() {
    const wrap = document.getElementById('compare-wrap');
    const handle = document.getElementById('cmp-handle');
    if (!wrap || !handle) return;

    // Keep 5 % margin so at least a sliver of each image is always visible
    // and the handle can always be grabbed.
    const MIN_PCT = 5;
    const MAX_PCT = 95;

    let dragging = false;

    function setSplit(clientX) {
        const rect = wrap.getBoundingClientRect();
        const raw = ((clientX - rect.left) / rect.width) * 100;
        const pct = Math.max(MIN_PCT, Math.min(MAX_PCT, raw));
        wrap.style.setProperty('--split', pct.toFixed(2) + '%');
    }

    // Drag starts ONLY from the handle; clicking elsewhere does nothing.
    handle.addEventListener('pointerdown', (e) => {
        if (!wrap.classList.contains('compare-active')) return;
        dragging = true;
        // Capture on wrap so we receive move events even outside the handle.
        wrap.setPointerCapture(e.pointerId);
        wrap.style.cursor = 'ew-resize';
        e.preventDefault();
    });
    wrap.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        setSplit(e.clientX);
    });
    wrap.addEventListener('pointerup', () => {
        dragging = false;
        wrap.style.cursor = '';
    });
    wrap.addEventListener('pointercancel', () => {
        dragging = false;
        wrap.style.cursor = '';
    });
}

// ── Lang dropdown ──────────────────────────────────────────────────────────────
function closeLangDropdown() {
    const dd = document.getElementById('lang-dropdown');
    dd.classList.remove('open');
    document.getElementById('lang-trigger').setAttribute('aria-expanded', 'false');
}

function initLangDropdown() {
    const trigger = document.getElementById('lang-trigger');
    const dd = document.getElementById('lang-dropdown');
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = dd.classList.toggle('open');
        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', () => closeLangDropdown());
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeLangDropdown();
    });
}

// ── Drag & drop / paste / click ───────────────────────────────────────────────
function initUpload() {
    const zone = document.getElementById('upload-zone');
    const inp = document.getElementById('file-input');

    zone.addEventListener('click', () => inp.click());
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') inp.click(); });

    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        const file = e.dataTransfer?.files?.[0];
        if (file) loadFile(file);
    });

    inp.addEventListener('change', () => {
        if (inp.files?.[0]) loadFile(inp.files[0]);
    });

    document.addEventListener('paste', (e) => {
        const item = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'));
        if (item) {
            const f = item.getAsFile();
            if (f) loadFile(f);
        }
    });
}

// ── Modal helpers ──────────────────────────────────────────────────────────────
function openModal(id) {
    document.getElementById(id).classList.add('open');
    document.body.style.overflow = 'hidden';
}
function closeModal(id) {
    document.getElementById(id).classList.remove('open');
    document.body.style.overflow = '';
}

function initModals() {
    document.getElementById('link-help').addEventListener('click', (e) => {
        e.preventDefault(); openModal('overlay-help');
    });
    document.getElementById('link-legal').addEventListener('click', (e) => {
        e.preventDefault(); openModal('overlay-legal');
    });
    document.querySelectorAll('.modal-close,[data-close]').forEach(btn => {
        btn.addEventListener('click', () => closeModal(btn.dataset.close));
    });
    document.querySelectorAll('.overlay').forEach(ov => {
        ov.addEventListener('click', (e) => {
            if (e.target === ov) closeModal(ov.id);
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.overlay.open').forEach(ov => closeModal(ov.id));
        }
    });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
async function main() {
    // 0. Check WebAssembly + Worker support before anything else
    if (!checkWasmSupport()) return;

    // 1. Detect / restore theme
    const savedTheme = localStorage.getItem('theme');
    const dark = savedTheme === 'dark';
    applyTheme(dark);
    document.getElementById('theme-toggle').addEventListener('click', () => {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        applyTheme(!isDark);
    });

    // 2. Load language
    const savedLang = localStorage.getItem('lang') ?? 'zh-Hans';
    const langCode = LANGS_META.find(m => m.code === savedLang) ? savedLang : 'zh-Hans';
    try {
        langData = await loadLang(langCode);
        currentLang = langCode;
    } catch {
        // Fallback: try English
        try { langData = await loadLang('en'); currentLang = 'en'; } catch { langData = {}; }
    }
    document.documentElement.lang = currentLang;
    const shortLabel = LANGS_META.find(m => m.code === currentLang)?.short ?? currentLang;
    document.getElementById('lang-label').textContent = shortLabel;

    applyTranslations();
    renderLangMenu();
    initLangDropdown();

    // 3. Render initial format options
    document.getElementById('out-format').addEventListener('change', () => {
        renderFormatOpts();
        updateStaleIndicator();
    });
    renderFormatOpts();

    // 4. Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => showTab(btn.dataset.tab));
    });
    showTab('split');

    // 5. Compare slider
    initCompareSlider();

    // 6. Upload
    initUpload();

    // 7. Action buttons
    document.getElementById('btn-scramble').addEventListener('click', () => doProcess(false));
    document.getElementById('btn-restore').addEventListener('click', () => doProcess(true));
    document.getElementById('btn-reset').addEventListener('click', doReset);
    document.getElementById('btn-clear').addEventListener('click', doClear);
    document.getElementById('btn-download').addEventListener('click', doDownload);

    // 7b. Password field — live key badge + stale indicator
    document.getElementById('password').addEventListener('input', () => {
        updateKeyBadge();
        updateStaleIndicator();
    });
    updateKeyBadge(); // set initial badge state

    // 7c. Password visibility toggle
    document.getElementById('pw-eye')?.addEventListener('click', () => {
        const inp = document.getElementById('password');
        const revealed = inp.classList.toggle('revealed');
        document.getElementById('eye-open').style.display = revealed ? 'none' : '';
        document.getElementById('eye-closed').style.display = revealed ? '' : 'none';
    });

    // 8. Modals
    initModals();

    // 9. Init worker
    initWorker();

    // 10. Initial status
    updateStatus('status_ready', 'idle');
}

// ── WASM / Worker support check ───────────────────────────────────────────────────────────────────────
function checkWasmSupport() {
    if (typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined') return true;
    const banner = document.getElementById('wasm-error');
    if (banner) banner.style.display = '';
    document.querySelectorAll('.btn, .field-input, #upload-zone').forEach(el => {
        el.disabled = true;
        el.style.pointerEvents = 'none';
        el.style.opacity = '0.38';
    });
    return false;
}

// ── Params snapshot for staleness tracking ────────────────────────────────────────────────────
function currentParams() {
    return {
        password: document.getElementById('password')?.value ?? '',
        outFormat: parseInt(document.getElementById('out-format')?.value ?? '0', 10),
        jpegQuality,
        jpegSubsampling,
        pngCompression,
    };
}

function paramsMatch(a, b) {
    return a && b &&
        a.password === b.password &&
        a.outFormat === b.outFormat &&
        a.jpegQuality === b.jpegQuality &&
        a.jpegSubsampling === b.jpegSubsampling &&
        a.pngCompression === b.pngCompression;
}

// ── Key badge (next to password input) ───────────────────────────────────────────────────────────────────
function updateKeyBadge() {
    const pw = document.getElementById('password')?.value ?? '';
    const badge = document.getElementById('key-badge');
    if (!badge) return;
    if (pw) {
        badge.textContent = t('key_pwd');
        badge.className = 'key-badge key-badge-user';
    } else {
        badge.textContent = t('key_sha');
        badge.className = 'key-badge';
    }
}

// ── Stale result indicator ─────────────────────────────────────────────────────────────────────────────
function updateStaleIndicator() {
    const badge = document.getElementById('stale-badge');
    if (!badge) return;
    const stale = hasResult && !paramsMatch(lastResultParams, currentParams());
    badge.style.display = stale ? '' : 'none';
}

// ── JGS detect hint ───────────────────────────────────────────────────────────────────────────────────
function showDetectHint(show) {
    const hint = document.getElementById('detect-hint');
    if (hint) hint.style.display = show ? '' : 'none';
    document.getElementById('btn-restore')?.classList.toggle('btn-detect', show);
}

// ── JPEG chroma subsampling detector (pure JS, no WASM required) ─────────────────────────────
function detectJpegChroma(bytes) {
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
    let i = 2;
    while (i + 3 < bytes.length) {
        if (bytes[i] !== 0xFF) break;
        const marker = bytes[i + 1];
        if (marker === 0xD9 || marker === 0xDA) break; // EOI / SOS
        const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
        if (segLen < 2) break;
        const isSof = (marker >= 0xC0 && marker <= 0xC3) ||
            (marker >= 0xC5 && marker <= 0xC7) ||
            (marker >= 0xC9 && marker <= 0xCB) ||
            (marker >= 0xCD && marker <= 0xCF);
        if (isSof && i + 14 < bytes.length) {
            const ncomp = bytes[i + 9];
            if (ncomp >= 3) {
                const yH = (bytes[i + 11] >> 4) & 0xF, yV = bytes[i + 11] & 0xF;
                const cbH = (bytes[i + 14] >> 4) & 0xF;
                if (yH === 1 && yV === 1 && cbH === 1) return '4:4:4';
                if (yH === 2 && yV === 1 && cbH === 1) return '4:2:2';
                if (yH === 2 && yV === 2 && cbH === 1) return '4:2:0';
            }
        }
        i += 2 + segLen;
    }
    return null;
}

main().catch(console.error);

// Revoke any outstanding Object URLs when the page is unloaded so that
// the browser can reclaim the underlying Blob memory immediately.
window.addEventListener('beforeunload', () => {
    if (origUrl) URL.revokeObjectURL(origUrl);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
});
