import { RENDER_SCALE, MAX_OCR_WIDTH, WORKERS, SUMA_PSM, SUMA_WHITELIST, DEFAULT_PSM, OCR_WHITELIST } from './config.js';
import { loadPDF, renderPageToCanvasWithBoxes } from './pdf/capture.js';
import { cropCanvas, preprocessForOCR, computeFullReceipt, cropSumaStripFromReceipt, toSmallBinary } from './ocr/preprocess.js';
import { createWorkerPool, initWorkers, terminateWorkers, recognizeWithPoolParams } from './ocr/pool.js';
import { perfAdd, perfMeasureAsync, perfSummaryLines } from './ui/perf.js';

// SUMA amount extraction helpers
const AMOUNT_NUM = /\b\d{1,3}[.,]\d{2}\b/;
const AMOUNT_NUM_NOSEP = /\b\d{3,8}\b/;
const AMOUNT_NUM_NOSEP_G = new RegExp(AMOUNT_NUM_NOSEP.source, 'g');
const AMOUNT_RE = new RegExp('(?:^|\\b)(?:s\\s*u\\s*m\\s*[ahą]|suma)\\b[^\\d\\r\\n]*(' + AMOUNT_NUM.source + ')', 'i');
const SUMA_LABEL_FUZZY_RE = /(?:^|\b)s\s*[uü]\s*(?:[mnh]\s*[aą](?:\s*[lł])?)?/i;
const SU_PLN_HINT_RE = /s\s*u.*p\s*l\s*n/i;

function parseAmount(str) {
  let s = (str || '').trim().replace(/\u00A0/g, ' ');
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  } else {
    if (s.includes(',')) s = s.replace(/\s+/g, '').replace(/,/g, '.');
    else s = s.replace(/\s+/g, '');
  }
  const v = Number.parseFloat(s); return Number.isFinite(v) ? v : null;
}
function parseAmountNoSep(str) {
  const digits = (str || '').replace(/\D/g, ''); if (!digits) return null;
  const n = Number.parseInt(digits, 10); if (!Number.isFinite(n)) return null; return n / 100;
}
function amountFromLastTwoDigits(line) {
  const lower = (line || '').toLowerCase();
  let tailStart = -1; const idxPln = lower.lastIndexOf('pln');
  if (idxPln !== -1) tailStart = idxPln + 3; else {
    const idxSuma = lower.lastIndexOf('suma'); const idxSu = lower.lastIndexOf('su');
    if (idxSuma !== -1) tailStart = idxSuma + 4; else if (idxSu !== -1) tailStart = idxSu + 2;
  }
  const tail = tailStart >= 0 ? (line || '').slice(tailStart) : line;
  let digits = (tail || '').replace(/\D/g, '');
  if (digits.length >= 3) { const major = digits.slice(0, -2) || '0'; const minor = digits.slice(-2); const val = Number.parseFloat(`${major}.${minor}`); if (Number.isFinite(val)) return val; }
  const m = (line || '').match(/(\d[\d.,\s]*)\D*$/); if (!m) return null;
  digits = m[1].replace(/\D/g, ''); if (digits.length < 2) return null;
  const major = digits.slice(0, -2) || '0'; const minor = digits.slice(-2);
  const val = Number.parseFloat(`${major}.${minor}`); return Number.isFinite(val) ? val : null;
}
function extractSumaWithLine(text) {
  const lines = (text || '').split(/\r?\n/); let last = null;
  for (const line of lines) {
    const m = line.match(AMOUNT_RE); if (m) { last = { amount: parseAmount(m[1]), line }; continue; }
    if (SUMA_LABEL_FUZZY_RE.test(line)) {
      const forced = amountFromLastTwoDigits(line); if (forced != null) { last = { amount: forced, line }; continue; }
      const nums = line.match(AMOUNT_NUM_NOSEP_G) || []; if (nums.length) { const cand = parseAmountNoSep(nums[nums.length - 1]); if (cand != null) last = { amount: cand, line }; }
      continue;
    }
    if (SU_PLN_HINT_RE.test(line)) {
      const digits = (line.match(/\d/g) || []).length; if (digits >= 3) { const forced = amountFromLastTwoDigits(line); if (forced != null) last = { amount: forced, line }; }
    }
  }
  return last ?? { amount: null, line: null };
}

export async function runPipeline(file, ui, cancelToken = { cancelled: false }) {
  try {
    ui.progress.setMeta('Loading PDF…');
    const tStartAll = performance.now();
    const [pdf] = await perfMeasureAsync('pdf:load', async () => await loadPDF(file));
    ui.addLog(`Loaded PDF with pages: ${pdf.numPages}`);

    const pagesTotal = pdf.numPages; let receiptsTotal = 0;
    ui.progress.start(pagesTotal, 'Processing pages…');

    const workerCount = WORKERS; const lang = 'eng+pol';
    const pool = createWorkerPool(workerCount, () => {});
    await perfMeasureAsync('workers:init', async () => await initWorkers(pool, lang));
    ui.addLog(`Workers initialized: ${workerCount} | lang: ${lang}`);

    let grandTotal = 0, missingCount = 0, receiptCount = 0;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      if (cancelToken.cancelled) break;
      const page = await pdf.getPage(pageNum);
      const [{ canvas: pageCanvasEl, boxes: boxesFromRender }, tRender] = await perfMeasureAsync('page:render+capture', async () => await renderPageToCanvasWithBoxes(page, RENDER_SCALE));
      ui.progress.setMeta(`Page ${pageNum}/${pagesTotal}`);

      let boxes = boxesFromRender;
      if (!boxes || boxes.length === 0) {
        ui.addLog(`Page ${pageNum}: found 0 image boxes — using fallback splitter`);
      }

      // Fallback to heuristic 2x2 split with gutters if we have no image boxes
      if (!boxes || boxes.length === 0) {
        boxes = splitIntoReceiptsCanvas(pageCanvasEl);
      } else {
        ui.addLog(`Page ${pageNum}: found ${boxes.length} image boxes`);
      }
      receiptsTotal += (boxes?.length || 0);

      const tCropPre0 = performance.now();
      const receiptCanvases = (boxes || []).map(b => cropCanvas(pageCanvasEl, b.x, b.y, b.w, b.h));
      const sumaStrips = receiptCanvases.map(c => cropSumaStripFromReceipt(c));
      const roiCrops = sumaStrips.map(s => s.canvas);
      const roiPre = roiCrops.map(c => preprocessForOCR(c, MAX_OCR_WIDTH));
      perfAdd('page:crop+pre', performance.now() - tCropPre0);

      const tFullPre0 = performance.now();
      const fullTrimCanvases = receiptCanvases.map(c => { const { base } = computeFullReceipt(c); return cropCanvas(c, base.x, base.y, base.w, base.h); });
      perfAdd('page:full-trim-crops', performance.now() - tFullPre0);

      const perPageTexts = new Array(roiPre.length).fill('');
      const amounts = new Array(roiPre.length).fill(null);
      const sumaLines = new Array(roiPre.length).fill('');
      const tOcrStart = performance.now();
      await Promise.all(roiPre.map(async (canvas, idx) => {
        if (canvas.width < 8 || canvas.height < 8) {
          ui.addLog(`Page ${pageNum} receipt ${idx+1} ROI too small: ${canvas.width}x${canvas.height}`);
          missingCount++; receiptCount++; ui.updateTotals(receiptCount, missingCount, grandTotal, receiptsTotal); return;
        }
        const o0 = performance.now();
        let text = await recognizeWithPoolParams(pool, canvas, { psm: SUMA_PSM, whitelist: SUMA_WHITELIST });
        perfAdd('roi:ocr-strip', performance.now() - o0);
        ui.addLog(`Page ${pageNum} receipt ${idx+1}: ROI OCR length ${text?.length || 0}`);
        let { amount, line } = extractSumaWithLine(text || '');
        if (amount == null) {
          const pre2 = preprocessForOCR(fullTrimCanvases[idx], MAX_OCR_WIDTH);
          const f0 = performance.now();
          text = await recognizeWithPoolParams(pool, pre2, { psm: DEFAULT_PSM, whitelist: OCR_WHITELIST });
          perfAdd('roi:ocr-fallback', performance.now() - f0);
          ui.addLog(`Page ${pageNum} receipt ${idx+1}: Fallback FULL OCR length ${text?.length || 0}`);
          ({ amount, line } = extractSumaWithLine(text || ''));
        }
        perPageTexts[idx] = text || ''; sumaLines[idx] = line || '';
        if (amount != null) { grandTotal += amount; ui.addSumLog(amount, line); amounts[idx] = amount; }
        else { missingCount++; ui.addLog(`Page ${pageNum} receipt ${idx+1}: SUMA not found`); }
        receiptCount++; ui.progress.setMeta(`Page ${pageNum}/${pagesTotal}  |  Sum: ${grandTotal.toFixed(2)}`);
        ui.updateTotals(receiptCount, missingCount, grandTotal, receiptsTotal);
      }));
      perfAdd('page:ocr-wall', performance.now() - tOcrStart);

      await perfMeasureAsync('ui:append-feed', async () => ui.appendFeedPost(pageNum, amounts, roiPre, perPageTexts, sumaLines));

      pageCanvasEl.width = pageCanvasEl.height = 0;
      ui.progress.tick(1);
      ui.progress.setMeta(`Page ${Math.min(ui.steps.progress.done, pagesTotal)}/${pagesTotal}  |  Sum: ${grandTotal.toFixed(2)}`);

      const renderMs = Math.round(tRender);
      ui.addLog(`Perf p${pageNum}: render ${renderMs}ms`);
    }

    await perfMeasureAsync('workers:terminate', async () => await terminateWorkers(pool));
    ui.updateTotals(receiptCount, missingCount, grandTotal, receiptsTotal);
    const totalMs = performance.now() - tStartAll;
    ui.addLog(`Perf summary (total ${Math.round(totalMs)}ms):`);
    for (const line of perfSummaryLines()) ui.addLog('  ' + line);
  } catch (err) {
    console.error(err);
    alert('Error: ' + (err && err.message ? err.message : String(err)));
  }
}

function findGutter(bin, w, h, axis /* 'x'|'y' */) {
  if (axis === 'x') {
    const center = Math.floor(w / 2);
    const window = Math.max(10, Math.floor(w / 3));
    const xStart = Math.max(0, center - Math.floor(window / 2));
    const xEnd = Math.min(w, xStart + window);
    let bestRun = -1, bestMid = null;
    for (const thr of [0.98, 0.92, 0.85]) {
      bestRun = -1; bestMid = null;
      let run = 0, runStart = xStart;
      for (let x = xStart; x < xEnd; x++) {
        let white = 0; for (let y = 0; y < h; y += 2) { if (bin[y * w + x] > 0) white++; }
        const ratio = white / (h / 2);
        if (ratio >= thr) { if (run === 0) runStart = x; run++; }
        else { if (run > bestRun) { bestRun = run; bestMid = runStart + Math.floor(run / 2); } run = 0; }
      }
      if (run > bestRun) { bestRun = run; bestMid = runStart + Math.floor(run / 2); }
      if (bestRun >= Math.max(5, Math.floor(w / 50))) return bestMid;
    }
    return bestMid;
  } else {
    const center = Math.floor(h / 2);
    const window = Math.max(10, Math.floor(h / 3));
    const yStart = Math.max(0, center - Math.floor(window / 2));
    const yEnd = Math.min(h, yStart + window);
    let bestRun = -1, bestMid = null;
    for (const thr of [0.98, 0.92, 0.85]) {
      bestRun = -1; bestMid = null;
      let run = 0, runStart = yStart;
      for (let y = yStart; y < yEnd; y++) {
        let white = 0; for (let x = 0; x < w; x += 2) { if (bin[y * w + x] > 0) white++; }
        const ratio = white / (w / 2);
        if (ratio >= thr) { if (run === 0) runStart = y; run++; }
        else { if (run > bestRun) { bestRun = run; bestMid = runStart + Math.floor(run / 2); } run = 0; }
      }
      if (run > bestRun) { bestRun = run; bestMid = runStart + Math.floor(run / 2); }
      if (bestRun >= Math.max(5, Math.floor(h / 50))) return bestMid;
    }
    return bestMid;
  }
}

function splitIntoReceiptsCanvas(pageCanvas) {
  const W = pageCanvas.width, H = pageCanvas.height;
  const { w, h, scale, bin } = toSmallBinary(pageCanvas);
  const splitXSmall = findGutter(bin, w, h, 'x');
  if (splitXSmall != null) {
    let splitX = Math.max(20, Math.min(W - 20, Math.round(splitXSmall / scale)));
    const left = cropCanvas(pageCanvas, 0, 0, splitX, H);
    const lbinObj = toSmallBinary(left);
    const leftSplitSmall = findGutter(lbinObj.bin, lbinObj.w, lbinObj.h, 'y');
    let leftSplit = leftSplitSmall != null ? Math.round(leftSplitSmall / lbinObj.scale) : Math.floor(H / 2);
    leftSplit = Math.max(20, Math.min(H - 20, leftSplit));
    const right = cropCanvas(pageCanvas, splitX, 0, W - splitX, H);
    const rbinObj = toSmallBinary(right);
    const rightSplitSmall = findGutter(rbinObj.bin, rbinObj.w, rbinObj.h, 'y');
    let rightSplit = rightSplitSmall != null ? Math.round(rightSplitSmall / rbinObj.scale) : Math.floor(H / 2);
    rightSplit = Math.max(20, Math.min(H - 20, rightSplit));
    return [
      { x: 0, y: 0, w: splitX, h: leftSplit },
      { x: splitX, y: 0, w: W - splitX, h: rightSplit },
      { x: 0, y: leftSplit, w: splitX, h: H - leftSplit },
      { x: splitX, y: rightSplit, w: W - splitX, h: H - rightSplit },
    ];
  }
  const sx = Math.floor(W / 2), sy = Math.floor(H / 2);
  return [
    { x: 0, y: 0, w: sx, h: sy },
    { x: sx, y: 0, w: W - sx, h: sy },
    { x: 0, y: sy, w: sx, h: H - sy },
    { x: sx, y: sy, w: W - sx, h: H - sy },
  ];
}
