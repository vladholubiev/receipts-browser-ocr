import { SUMA_BASE_W, SUMA_STRIP_HEIGHT_PX, SUMA_PSM, SUMA_WHITELIST } from './config.js';
import { loadPDF, renderPageToCanvasWithBoxes } from './pdf/capture.js';
import { cropCanvas, preprocessForOCR, cropSumaStripFromReceipt } from './ocr/preprocess.js';
import { createWorkerPool, initWorkers, terminateWorkers, recognizeWithPoolParams } from './ocr/pool.js';
import { perfMeasureAsync } from './ui/perf.js';

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

async function scoreStripOCR(pool, canvas) {
  const text = await recognizeWithPoolParams(pool, canvas, { psm: SUMA_PSM, whitelist: SUMA_WHITELIST });
  const up = (text || '').toUpperCase();
  let score = 0;
  if (/(^|\b)S\s*U\s*M\s*A\b/.test(up)) score += 100;
  if (/\bPLN\b/.test(up)) score += 40;
  const m = up.match(/\d[\d\s.,]*/g); if (m && m.length) score += Math.min(60, m[m.length - 1].replace(/\D/g, '').length * 3);
  return { text: up, score };
}

export async function runCalibrate(file, ui) {
  try {
    ui.addLog('Calibrate: loading PDF…');
    const [pdf] = await perfMeasureAsync('calib:pdf-load', async () => await loadPDF(file));
    const page = await pdf.getPage(2);
    const [{ canvas: pageCanvasEl, boxes: boxesFromRender }] = await perfMeasureAsync('calib:render', async () => await renderPageToCanvasWithBoxes(page));
    let boxes = boxesFromRender;
    if (!boxes || boxes.length === 0) { ui.addLog('Calibrate: no receipts found on page 1.'); return; }
    ui.addLog(`Calibrate: using ${Math.min(4, boxes.length)} receipts on page 1`);

    const pool = createWorkerPool(1, () => {});
    await initWorkers(pool, 'eng+pol');

    const suggestions = [];
    const maxReceipts = Math.min(4, boxes.length);
    for (let i = 0; i < maxReceipts; i++) {
      const b = boxes[i];
      const receipt = cropCanvas(pageCanvasEl, b.x, b.y, b.w, b.h);
      const s = receipt.width / SUMA_BASE_W;
      const estTop = Math.round( /* current guess if available? use cropSumaStripFromReceipt */ cropSumaStripFromReceipt(receipt).rect.y );
      const searchHalf = Math.round(160 * s);
      const step = Math.max(2, Math.round(6 * s));
      let best = { score: -1e9, y: estTop, text: '' };
      const h = Math.max(8, Math.round(SUMA_STRIP_HEIGHT_PX * s));
      const x = 0, w = receipt.width;
      const start = clamp(estTop - searchHalf, 0, receipt.height - h);
      const end = clamp(estTop + searchHalf, 0, receipt.height - h);
      for (let y = start; y <= end; y += step) {
        const crop = cropCanvas(receipt, x, y, w, h);
        const pre = preprocessForOCR(crop);
        const { text, score } = await scoreStripOCR(pool, pre);
        if (score > best.score) best = { score, y, text };
      }
      const topBasePx = Math.round(best.y / s);
      suggestions.push({ idx: i + 1, y: best.y, topBasePx, score: best.score, text: best.text.slice(0, 80) });
      ui.addLog(`Calibrate: receipt #${i+1}: best y=${best.y} (base ${topBasePx}px), score=${best.score}`);
    }

    // Aggregate suggestion (median of base px)
    const bases = suggestions.map(s => s.topBasePx).sort((a, b) => a - b);
    const mid = Math.floor(bases.length / 2);
    const suggestedTop = bases.length % 2 ? bases[mid] : Math.round((bases[mid - 1] + bases[mid]) / 2);
    ui.addLog(`Calibrate: Suggested SUMA_STRIP_TOP_PX = ${suggestedTop}` , true);
    ui.addLog('Update src/config.js and reload to apply.', true);

    await terminateWorkers(pool);
  } catch (e) {
    console.error(e);
    ui.addLog('Calibrate: failed — ' + (e?.message || String(e)));
  }
}
