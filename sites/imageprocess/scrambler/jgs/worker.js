/**
 * JGS-V5 WASM Web Worker
 *
 * Runs in a dedicated worker thread, owns a single WASM instance.
 * Receives messages from the main thread, calls the WASM core, and
 * posts the result (or error) back.
 *
 * Message protocol (main → worker):
 *   { id, type: 'process', payload: { bytes, password, decode, outFormat,
 *       jpegQuality, jpegSubsampling, pngCompression } }
 *   { id, type: 'processRgba', payload: { rgba, width, height, password, decode,
 *       outFormat, jpegQuality, jpegSubsampling, pngCompression } }
 *   { id, type: 'info', payload: { bytes } }
 *
 * Message protocol (worker → main):
 *   { id, ok: true,  result: Uint8Array }   — processImage / processRgba
 *   { id, ok: true,  result: object }        — info
 *   { id, ok: false, error: string }
 *
 * Transfer: result Uint8Array is transferred (zero-copy) where possible.
 */

'use strict';

// Path to the wasm-pack generated ES module (relative to this worker file)
const WASM_MODULE_PATH = './pkg/jgs_core.js';

let wasm = null; // resolved WASM module exports

async function ensureWasm() {
    if (wasm) return;
    // Dynamic import works in module workers.  Fallback handled below.
    const mod = await import(WASM_MODULE_PATH);
    await mod.default(); // initialise WASM (calls the wasm-pack init function)
    wasm = mod;
}

self.addEventListener('message', async (ev) => {
    const { id, type, payload } = ev.data;
    try {
        await ensureWasm();

        if (type === 'info') {
            const result = wasm.imageInfo(payload.bytes);
            self.postMessage({ id, ok: true, result });
            return;
        }

        if (type === 'process') {
            const { bytes, password, decode, outFormat,
                jpegQuality, jpegSubsampling, pngCompression } = payload;
            const result = wasm.processImage(
                bytes, password, decode, outFormat,
                jpegQuality, jpegSubsampling, pngCompression,
            );
            // Transfer the underlying ArrayBuffer so the copy is zero-cost
            self.postMessage({ id, ok: true, result }, [result.buffer]);
            return;
        }

        if (type === 'processRgba') {
            const { rgba, width, height, password, decode, outFormat,
                jpegQuality, jpegSubsampling, pngCompression } = payload;
            const result = wasm.processRgba(
                rgba, width, height, password, decode, outFormat,
                jpegQuality, jpegSubsampling, pngCompression,
            );
            self.postMessage({ id, ok: true, result }, [result.buffer]);
            return;
        }

        self.postMessage({ id, ok: false, error: `Unknown message type: ${type}` });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        self.postMessage({ id, ok: false, error: msg });
    }
});
