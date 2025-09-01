/* Minimal client-side app to load a PDF, rasterize pages, split into
   4 receipts (with per-column height detection), OCR each with Tesseract.js,
   extract SUMA amounts, and sum totals. Shows progress bars with ETA and
   previews of the current page and OCR results. */

// --- DOM helpers ---
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Single progress bar (page-by-page)
const steps = {
  progress: stepElements('#step-progress'),
};

function stepElements(sel) {
  const root = $(sel);
  return {
    root,
    fill: $('[data-fill]', root),
    meta: $('[data-meta]', root),
    eta: $('[data-eta]', root),
    startedAt: 0,
    total: 0,
    done: 0,
  };
}

function resetSteps() {
  for (const key of Object.keys(steps)) {
    const s = steps[key];
    s.startedAt = 0;
    s.total = 0;
    s.done = 0;
    setStepProgress(s, 0, 0);
    setStepMeta(s, '');
    setETA(s, '');
  }
  if (steps.progress && steps.progress.meta) steps.progress.meta.textContent = 'Waiting for file…';
}

function setStepProgress(step, done, total) {
  step.done = done;
  step.total = total;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  if (step.fill) step.fill.style.width = pct + '%';
}

function setStepMeta(step, text) {
  if (step.meta) step.meta.textContent = text;
}

function setETA(step, text) {
  if (step.eta) step.eta.textContent = text;
}

function startStep(step, total, label) {
  step.startedAt = performance.now();
  step.total = total;
  step.done = 0;
  setStepMeta(step, label || '');
  setStepProgress(step, 0, total);
  setETA(step, '');
}

function tickStep(step, inc = 1) {
  step.done += inc;
  if (step.done > step.total) step.done = step.total;
  setStepProgress(step, step.done, step.total);
  if (step.total > 0 && step.done > 0) {
    const now = performance.now();
    const elapsed = (now - step.startedAt) / 1000;
    const rate = step.done / Math.max(1e-6, elapsed);
    const remaining = step.total - step.done;
    const eta = remaining / Math.max(1e-6, rate);
    setETA(step, `ETA ${formatDuration(eta)}`);
  }
}

function formatDuration(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  if (sec < 1) return '1s';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// --- Controls ---
const fileInput = $('#fileInput');
const cancelBtn = $('#cancelBtn');
const failedOnlyCb = $('#failedOnly');
const RENDER_SCALE = 3; // higher rasterization scale for sharper OCR
const MAX_OCR_WIDTH = 2048; // allow higher-resolution OCR input
const MIN_OCR_HEIGHT = 160; // ensure very short stripes upscale more
const HORIZ_STRETCH = 1.3; // slightly stronger horizontal widening for digits
const STRIPE_RATIO = 0.25; // consider ROI a stripe if h/w < 0.25
const DEFAULT_PSM = '6';
const STRIPE_PSM = '7';
const WORKERS = 4;
// Restrict OCR to these characters only
// Includes a space, colon, and "PLN"
const OCR_WHITELIST = 'SUMADOZAPLATYPLN0123456789,. :';
// Smart ROI, trim margins, and debug logs are always enabled
const feed = $('#feed');

fileInput.addEventListener('change', async () => {
  if (fileInput.files?.length) {
    cancelFlag = false;
    cancelBtn.disabled = false;
    resetUI();
    clearFeed();
    await runPipeline();
    cancelBtn.disabled = true;
  }
});

// Right pane feed
const totalSumEl = $('#totalSum');
const countReceiptsEl = $('#countReceipts');
const countMissingEl = $('#countMissing');
const sumFill = $('#sumFill');
const logList = $('#logList');

let cancelFlag = false;

cancelBtn.addEventListener('click', () => {
  cancelFlag = true;
  cancelBtn.disabled = true;
});

// Toggle showing only failed thumbnails
if (failedOnlyCb) {
  failedOnlyCb.addEventListener('change', () => {
    document.body.classList.toggle('fail-only', !!failedOnlyCb.checked);
  });
}

// No start button; processing begins on file selection

function resetUI() {
  resetSteps();
  // right feed is managed separately
  totalSumEl.textContent = '0.00';
  countReceiptsEl.textContent = '0';
  countMissingEl.textContent = '0';
  // feed cleared on new run
}

// --- PDF rendering helpers ---
async function loadPDF(file) {
  const url = URL.createObjectURL(file);
  const loadingTask = pdfjsLib.getDocument({ url });
  const pdf = await loadingTask.promise;
  URL.revokeObjectURL(url);
  return pdf;
}

async function renderPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

// --- Splitting (with column gutter + per-column height detection) ---
function toSmallBinary(canvas, targetW = 800) {
  const scale = Math.min(1, targetW / canvas.width);
  const w = Math.max(1, Math.floor(canvas.width * scale));
  const h = Math.max(1, Math.floor(canvas.height * scale));
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(canvas, 0, 0, w, h);
  const img = tctx.getImageData(0, 0, w, h);
  const data = img.data;
  // grayscale + auto-threshold
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const g = (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114);
    sum += g;
  }
  const avg = sum / (data.length / 4);
  const thr = Math.min(250, Math.max(200, avg + 20));
  // binarize: 255 for white
  const bin = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114);
    bin[p] = g >= thr ? 255 : 0;
  }
  return { w, h, scale, bin };
}

function findGutter(bin, w, h, axis/*'x'|'y'*/) {
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
        let white = 0;
        for (let y = 0; y < h; y += 2) {
          if (bin[y * w + x] > 0) white++;
        }
        const ratio = white / (h / 2);
        if (ratio >= thr) {
          if (run === 0) runStart = x;
          run++;
        } else {
          if (run > bestRun) { bestRun = run; bestMid = runStart + Math.floor(run / 2); }
          run = 0;
        }
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
        let white = 0;
        for (let x = 0; x < w; x += 2) {
          if (bin[y * w + x] > 0) white++;
        }
        const ratio = white / (w / 2);
        if (ratio >= thr) {
          if (run === 0) runStart = y;
          run++;
        } else {
          if (run > bestRun) { bestRun = run; bestMid = runStart + Math.floor(run / 2); }
          run = 0;
        }
      }
      if (run > bestRun) { bestRun = run; bestMid = runStart + Math.floor(run / 2); }
      if (bestRun >= Math.max(5, Math.floor(h / 50))) return bestMid;
    }
    return bestMid;
  }
}

function splitIntoReceipts(pageCanvas) {
  const W = pageCanvas.width, H = pageCanvas.height;
  const { w, h, scale, bin } = toSmallBinary(pageCanvas);
  const splitXSmall = findGutter(bin, w, h, 'x');
  if (splitXSmall != null) {
    let splitX = Math.max(20, Math.min(W - 20, Math.round(splitXSmall / scale)));
    // Left column
    const left = cropCanvas(pageCanvas, 0, 0, splitX, H);
    const lbinObj = toSmallBinary(left);
    const leftSplitSmall = findGutter(lbinObj.bin, lbinObj.w, lbinObj.h, 'y');
    let leftSplit = leftSplitSmall != null ? Math.round(leftSplitSmall / lbinObj.scale) : Math.floor(H / 2);
    leftSplit = Math.max(20, Math.min(H - 20, leftSplit));
    // Right column
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
  // Fallback to equal quadrants
  const sx = Math.floor(W / 2), sy = Math.floor(H / 2);
  return [
    { x: 0, y: 0, w: sx, h: sy },
    { x: sx, y: 0, w: W - sx, h: sy },
    { x: 0, y: sy, w: sx, h: H - sy },
    { x: sx, y: sy, w: W - sx, h: H - sy },
  ];
}

// Detect content bounds to trim white margins around the printed receipt.
function trimMarginsBox(srcCanvas) {
  const { w, h, scale, bin } = toSmallBinary(srcCanvas, 600);
  const minRun = Math.max(5, Math.floor(Math.min(w, h) / 100));
  const colDensity = new Float32Array(w);
  const rowDensity = new Float32Array(h);
  // Compute densities
  for (let y = 0; y < h; y++) {
    let rowBlack = 0;
    for (let x = 0; x < w; x++) {
      if (bin[y * w + x] === 0) rowBlack++;
    }
    rowDensity[y] = rowBlack / w;
  }
  for (let x = 0; x < w; x++) {
    let colBlack = 0;
    for (let y = 0; y < h; y++) {
      if (bin[y * w + x] === 0) colBlack++;
    }
    colDensity[x] = colBlack / h;
  }
  // Find first/last rows/cols over threshold
  const thr = 0.02; // 2% black pixels counts as content
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  for (let y = 0; y < h; y++) { if (rowDensity[y] > thr) { top = y; break; } }
  for (let y = h - 1; y >= 0; y--) { if (rowDensity[y] > thr) { bottom = y; break; } }
  for (let x = 0; x < w; x++) { if (colDensity[x] > thr) { left = x; break; } }
  for (let x = w - 1; x >= 0; x--) { if (colDensity[x] > thr) { right = x; break; } }
  // Add small padding
  const pad = Math.floor(8 * (1 / scale));
  const X = Math.max(0, Math.floor(left / scale) - pad);
  const Y = Math.max(0, Math.floor(top / scale) - pad);
  const W = Math.min(srcCanvas.width - X, Math.ceil((right - left + 1) / scale) + 2 * pad);
  const H = Math.min(srcCanvas.height - Y, Math.ceil((bottom - top + 1) / scale) + 2 * pad);
  return { x: X, y: Y, w: W, h: H };
}


// Simpler strategy: just keep the whole receipt (trimmed) as OCR area.
function computeFullReceipt(srcCanvas) {
  const base = trimMarginsBox(srcCanvas);
  // Small padding to avoid clipping edges
  const pad = 2;
  const roi = {
    x: Math.max(0, base.x - pad),
    y: Math.max(0, base.y - pad),
    w: Math.min(srcCanvas.width - Math.max(0, base.x - pad), base.w + pad * 2),
    h: Math.min(srcCanvas.height - Math.max(0, base.y - pad), base.h + pad * 2),
  };
  return { base, roi };
}

function cropCanvas(src, x, y, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

// Crop a canvas vertically by removing a percentage from the top and bottom.
// Example: topPct = 0.2 and bottomPct = 0.2 keeps the middle 60%.
function cropVerticalPercent(srcCanvas, topPct = 0.2, bottomPct = 0.2) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const top = Math.max(0, Math.floor(h * topPct));
  const bottom = Math.max(0, Math.floor(h * bottomPct));
  const newH = Math.max(1, h - top - bottom);
  if (newH <= 0 || w <= 0) return srcCanvas;
  return cropCanvas(srcCanvas, 0, top, w, newH);
}

// --- OCR helpers (Tesseract.js v2) ---
function createWorkerPool(n, onLog) {
  const pool = [];
  for (let i = 0; i < n; i++) {
    const worker = Tesseract.createWorker({ logger: onLog });
    pool.push({ worker, busy: false, id: i });
  }
  return pool;
}

async function initWorkers(pool, lang = 'pol') {
  for (const slot of pool) {
    await slot.worker.load();
    await slot.worker.loadLanguage(lang);
    await slot.worker.initialize(lang);
    await slot.worker.setParameters({
      tessedit_pageseg_mode: DEFAULT_PSM,
      preserve_interword_spaces: '1',
      tessedit_char_whitelist: OCR_WHITELIST,
      // Reduce dictionary influence and set a consistent DPI hint
      load_system_dawg: '0',
      load_freq_dawg: '0',
      user_defined_dpi: '300',
      classify_bln_numeric_mode: '1',
    });
  }
}

async function terminateWorkers(pool) {
  for (const slot of pool) {
    try { await slot.worker.terminate(); } catch {}
  }
}

// SUMA extraction
// Strict amount: 1–3 digits, dot/comma, 2 decimals (e.g., 1.00, 12.34, 123.45)
const AMOUNT_NUM = /\b\d{1,3}[.,]\d{2}\b/;
// Fallback: compact digits without separators (e.g., 1651 -> 16.51)
const AMOUNT_NUM_NOSEP = /\b\d{3,8}\b/;
const AMOUNT_NUM_NOSEP_G = new RegExp(AMOUNT_NUM_NOSEP.source, 'g');
// SUMA label (tolerating OCR spacing/errors in SUMA token), capturing the strict amount on the same line
const AMOUNT_RE = new RegExp('(?:^|\\b)(?:s\\s*u\\s*m\\s*[ahą]|suma)\\b[^\\d\\r\\n]*(' + AMOUNT_NUM.source + ')', 'i');
// Fuzzy SUMA detection to tolerate OCR confusions like SUNA / SUMAL / SUMA:
const SUMA_LABEL_FUZZY_RE = /(?:^|\b)s\s*[uü]\s*(?:[mnh]\s*[aą](?:\s*[lł])?)?/i; // also accepts bare "SU"
// Treat lines with "SU" and "PLN" anywhere as SUMA lines (very tolerant)
const SU_PLN_HINT_RE = /s\s*u.*p\s*l\s*n/i;
// We rely solely on the SUMA line; no DO ZAPŁATY/RAZEM fallback.

function parseAmount(str) {
  let s = (str || '').trim().replace(/\u00A0/g, ' ');
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(/,/g, '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else {
    if (s.includes(',')) s = s.replace(/\s+/g, '').replace(/,/g, '.');
    else s = s.replace(/\s+/g, '');
  }
  const v = Number.parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

function parseAmountNoSep(str) {
  const digits = (str || '').replace(/\D/g, '');
  if (!digits) return null;
  const n = Number.parseInt(digits, 10);
  if (!Number.isFinite(n)) return null;
  return n / 100; // interpret last 2 digits as cents
}

// Force decimal placement robustly:
// 1) Prefer digits found after the last occurrence of "PLN" (or "SUMA"/"SU") on the line,
//    stripping all non-digits and inserting a dot before the last two digits.
// 2) Fallback to the previous "last numeric run" behavior if needed.
function amountFromLastTwoDigits(line) {
  const lower = (line || '').toLowerCase();
  let tailStart = -1;
  const idxPln = lower.lastIndexOf('pln');
  if (idxPln !== -1) {
    tailStart = idxPln + 3;
  } else {
    const idxSuma = lower.lastIndexOf('suma');
    const idxSu = lower.lastIndexOf('su');
    if (idxSuma !== -1) tailStart = idxSuma + 4;
    else if (idxSu !== -1) tailStart = idxSu + 2;
  }
  let tail = tailStart >= 0 ? line.slice(tailStart) : line;
  let digits = (tail || '').replace(/\D/g, '');
  if (digits.length >= 3) {
    const major = digits.slice(0, -2) || '0';
    const minor = digits.slice(-2);
    const val = Number.parseFloat(`${major}.${minor}`);
    if (Number.isFinite(val)) return val;
  }
  // Fallback: use the last contiguous numeric-looking run near EOL
  const m = line.match(/(\d[\d.,\s]*)\D*$/);
  if (!m) return null;
  digits = m[1].replace(/\D/g, '');
  if (digits.length < 2) return null;
  const major = digits.slice(0, -2) || '0';
  const minor = digits.slice(-2);
  const val = Number.parseFloat(`${major}.${minor}`);
  return Number.isFinite(val) ? val : null;
}

function extractSuma(text) {
  return extractSumaWithLine(text).amount;
}

// Returns { amount: number|null, line: string|null } using SUMA line only
function extractSumaWithLine(text) {
  const lines = (text || '').split(/\r?\n/);
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(AMOUNT_RE);
    if (m) {
      last = { amount: parseAmount(m[1]), line };
      continue;
    }
    // Fallbacks if SUMA-like token is present on the line
    if (SUMA_LABEL_FUZZY_RE.test(line)) {
      // Preferred: force decimal using last two digits near end of line
      const forced = amountFromLastTwoDigits(line);
      if (forced != null) { last = { amount: forced, line }; continue; }
      // Secondary: compact digits (in case regex above fails)
      const nums = line.match(AMOUNT_NUM_NOSEP_G) || [];
      if (nums.length) {
        const cand = parseAmountNoSep(nums[nums.length - 1]);
        if (cand != null) last = { amount: cand, line };
      }
      continue;
    }
    // Special hint: allow lines like "SU PLN 1474" to count as SUMA line
    if (SU_PLN_HINT_RE.test(line)) {
      // Require at least 3 digits on the line, then force decimal
      const digits = (line.match(/\d/g) || []).length;
      if (digits >= 3) {
        const forced = amountFromLastTwoDigits(line);
        if (forced != null) last = { amount: forced, line };
      }
    }
  }
  return last ?? { amount: null, line: null };
}

// --- Pipeline ---
async function runPipeline() {
  try {
    const file = fileInput.files[0];
    if (!file) return;
    // 1) Load PDF
    setStepMeta(steps.progress, 'Loading PDF…');
    const pdf = await loadPDF(file);
    addLog(`Loaded PDF with pages: ${pdf.numPages}`);

    // Setup single progress bar (page by page)
    const pagesTotal = pdf.numPages;
    const receiptsTotal = pagesTotal * 4;
    startStep(steps.progress, pagesTotal, 'Processing pages…');

    // OCR pool
    const workerCount = WORKERS;
    const lang = 'eng+pol';
    const pool = createWorkerPool(workerCount, (m) => {
      // Could aggregate finer-grained OCR progress here if desired
      // Could show OCR worker status in the single progress meta if desired
    });
    await initWorkers(pool, lang);
    addLog(`Workers initialized: ${workerCount} | lang: ${lang}`);

    let grandTotal = 0;
    let missingCount = 0;
    let receiptCount = 0;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      if (cancelFlag) break;
      const page = await pdf.getPage(pageNum);
      const pageCanvasEl = await renderPageToCanvas(page, RENDER_SCALE);
      setStepMeta(steps.progress, `Page ${pageNum}/${pagesTotal}`);
      await uiYield();

    // Split
    const boxes = splitIntoReceipts(pageCanvasEl);

      // Compute full receipt area per box (trim margins only; no inner ROI guessing)
      const rois = boxes.map(b => {
        const crop = cropCanvas(pageCanvasEl, b.x, b.y, b.w, b.h);
        const { base, roi } = computeFullReceipt(crop);
        return {
          base: { x: b.x + base.x, y: b.y + base.y, w: base.w, h: base.h },
          roi: { x: b.x + roi.x, y: b.y + roi.y, w: roi.w, h: roi.h },
        };
      });

      // No live preview; final page goes to feed with colored overlays
      rois.forEach((r, i) => {
        addLog(`Page ${pageNum} receipt #${i+1} area(${r.roi.x},${r.roi.y},${r.roi.w}x${r.roi.h})`);
      });

      // Crop ROI canvases for OCR
      const roiCropsRaw = rois.map(r => cropCanvas(pageCanvasEl, r.roi.x, r.roi.y, r.roi.w, r.roi.h));
      // Remove top/bottom 20% from each thumbnail before preprocessing and OCR
      const roiCrops = roiCropsRaw.map(c => cropVerticalPercent(c, 0.38, 0.38));
      const fullTrimCanvases = rois.map(r => cropCanvas(pageCanvasEl, r.base.x, r.base.y, r.base.w, r.base.h));
      const maxW = MAX_OCR_WIDTH;
      const roiPre = roiCrops.map(c => preprocessForOCR(c, maxW));
      const roiPsm = roiCrops.map(() => DEFAULT_PSM);
      await uiYield();

      // Show crop previews if unlocked
      // Thumbnails appear in the page feed post

      // OCR crops concurrently, worker pool gates throughput
      const perPageTexts = new Array(roiCrops.length).fill('');
      const amounts = new Array(roiCrops.length).fill(null);
      const sumaLines = new Array(roiCrops.length).fill('');
      const tasks = roiCrops.map((_, idx) => (async () => {
        try {
          // Guard tiny ROI
          if (roiCrops[idx].width < 8 || roiCrops[idx].height < 8) {
            addLog(`Page ${pageNum} receipt ${idx+1} ROI too small: ${roiCrops[idx].width}x${roiCrops[idx].height}`);
            // single progress bar only moves page-by-page
            missingCount++;
            receiptCount++;
            updateTotals(receiptCount, missingCount, grandTotal, receiptsTotal);
            return;
          }
          let text = await recognizeWithPoolPSM(pool, roiPre[idx], roiPsm[idx]);
          addLog(`Page ${pageNum} receipt ${idx+1}: ROI OCR length ${text?.length || 0}`);
          let { amount, line } = extractSumaWithLine(text || '');
          if (amount == null) {
            // Fallback to full trimmed area if ROI failed
            const fullTrim = fullTrimCanvases[idx];
            const pre2 = preprocessForOCR(fullTrim, maxW);
            text = await recognizeWithPoolPSM(pool, pre2, DEFAULT_PSM);
            addLog(`Page ${pageNum} receipt ${idx+1}: Fallback FULL OCR length ${text?.length || 0}`);
            ({ amount, line } = extractSumaWithLine(text || ''));
          }
          perPageTexts[idx] = text || '';
          sumaLines[idx] = line || '';
          if (amount != null) {
            grandTotal += amount;
            addSumLog(amount, line);
            amounts[idx] = amount;
          } else {
            missingCount++;
            // Removed missing textarea; log only
            addLog(`Missing SUMA text saved for page ${pageNum} receipt ${idx+1}`);
            addLog(`Page ${pageNum} receipt ${idx+1}: SUMA not found`);
          }
          receiptCount++;
          setStepMeta(steps.progress, `Page ${pageNum}/${pagesTotal}  |  Sum: ${grandTotal.toFixed(2)}`);
          updateTotals(receiptCount, missingCount, grandTotal, receiptsTotal);
          // perPageTexts retained for feed
        } catch (e) {
          console.error(`OCR task failed for page ${pageNum} receipt ${idx+1}:`, e);
          missingCount++;
          receiptCount++;
          addLog(`Error on page ${pageNum} receipt ${idx+1}: ${String(e)}`);
          updateTotals(receiptCount, missingCount, grandTotal, receiptsTotal);
        } finally {
          await uiYield();
        }
      })());

      await Promise.all(tasks);

      // Append this page to the feed with colored overlays and thumbnails
      appendFeedPost(pageNum, amounts, roiPre, perPageTexts, sumaLines);

      // Clean up big canvas to free memory
      pageCanvasEl.width = pageCanvasEl.height = 0;

      // Page-level progress tick
      tickStep(steps.progress, 1);
      setStepMeta(steps.progress, `Page ${Math.min(steps.progress.done, pagesTotal)}/${pagesTotal}  |  Sum: ${grandTotal.toFixed(2)}`);
    }

    await terminateWorkers(pool);
    updateTotals(receiptCount, missingCount, grandTotal, receiptsTotal);
  } catch (err) {
    console.error(err);
    alert('Error: ' + (err && err.message ? err.message : String(err)));
  }
}

async function recognizeWithPool(pool, canvas) {
  const slot = await acquireWorker(pool);
  try {
    const { data } = await slot.worker.recognize(canvas);
    return data && data.text ? data.text : '';
  } finally {
    slot.busy = false;
  }
}

async function recognizeWithPoolPSM(pool, canvas, psm) {
  const slot = await acquireWorker(pool);
  try {
    if (psm && psm !== DEFAULT_PSM) await slot.worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await slot.worker.recognize(canvas);
    if (psm && psm !== DEFAULT_PSM) await slot.worker.setParameters({ tessedit_pageseg_mode: DEFAULT_PSM });
    return data && data.text ? data.text : '';
  } finally {
    slot.busy = false;
  }
}

function acquireWorker(pool) {
  return new Promise(resolve => {
    const tryPick = () => {
      if (cancelFlag) return resolve(pool[0]);
      const idx = pool.findIndex(p => !p.busy);
      if (idx >= 0) {
        pool[idx].busy = true; // reserve immediately to avoid races
        resolve(pool[idx]);
      } else setTimeout(tryPick, 10);
    };
    tryPick();
  });
}

// --- Preview UI ---
// Build a feed post for a page, including colored overlays and receipt thumbnails.
function appendFeedPost(pageNum, amounts, roiPre, texts, sumaLines) {
  const post = document.createElement('div');
  post.className = 'post';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const okCount = amounts.filter(a => a != null).length;
  meta.textContent = `Page ${pageNum}: ${okCount}/4 receipts recognized`;
  if (okCount < (roiPre ? roiPre.length : 4)) post.classList.add('has-fail');
  post.appendChild(meta);

  // Thumbs
  const thumbs = document.createElement('div');
  thumbs.className = 'thumbs';
  roiPre.forEach((cnv, idx) => {
    const ok = amounts[idx] != null;
    const container = document.createElement('div');
    container.className = 'thumb ' + (ok ? 'ok' : 'fail');
    // label
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = ok ? `#${idx+1} ${amounts[idx].toFixed(2)}` : `#${idx+1} missing`;
    container.appendChild(label);
    // image
    const wrap = document.createElement('div');
    wrap.className = 'thumb-canvas-wrap';
    const c = document.createElement('canvas');
    c.width = cnv.width; c.height = cnv.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(cnv, 0, 0);
    wrap.appendChild(c);
    if (sumaLines && sumaLines[idx]) {
      const badge = document.createElement('div');
      badge.className = 'line-badge';
      badge.textContent = (sumaLines[idx] || '').replace(/\s+/g, ' ').trim();
      wrap.appendChild(badge);
    }
    container.appendChild(wrap);
    // full OCR text
    const pre = document.createElement('pre');
    pre.className = 'ocr-pre';
    pre.textContent = (texts && texts[idx]) ? texts[idx] : '';
    container.appendChild(pre);
    thumbs.appendChild(container);
  });
  post.appendChild(thumbs);

  if (feed.firstChild) feed.insertBefore(post, feed.firstChild);
  else feed.appendChild(post);
}

function updateTotals(receiptCount, missingCount, grandTotal, receiptsTotal = null) {
  countReceiptsEl.textContent = String(receiptCount);
  countMissingEl.textContent = String(missingCount);
  totalSumEl.textContent = grandTotal.toFixed(2);
  const total = receiptsTotal || Math.max(receiptCount, 1);
  const pct = Math.min(100, Math.round((receiptCount / total) * 100));
  if (sumFill) sumFill.style.width = pct + '%';
}

function scaleCanvas(src, scale) {
  if (scale === 1) return src;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * scale));
  c.height = Math.max(1, Math.round(src.height * scale));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function normalizeOcrCanvas(src, maxWidth, minHeight) {
  let scale = 1;
  if (src.height < minHeight) {
    scale = Math.max(scale, minHeight / Math.max(1, src.height));
  }
  if (src.width * scale > maxWidth) {
    scale = Math.min(scale, maxWidth / Math.max(1, src.width));
  }
  return scaleCanvas(src, scale);
}

function stretchCanvasX(src, factor) {
  if (!isFinite(factor) || factor <= 1.01) return src;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * factor));
  c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function cropForTotal(src, bottomFrac = 0.45) {
  const h = Math.round(src.height * bottomFrac);
  return cropCanvas(src, 0, src.height - h, src.width, h);
}

function uiYield() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// --- Preprocessing to emphasize bold text and suppress faint text ---
function preprocessForOCR(srcCanvas, maxWidth) {
  // 1) Normalize size (upscale if too short, downscale if too wide)
  let c = normalizeOcrCanvas(srcCanvas, maxWidth, MIN_OCR_HEIGHT);
  // 1b) If it's a very short stripe, widen horizontally to improve digit separability
  if (HORIZ_STRETCH > 1) {
    const isStripe = (c.height / Math.max(1, c.width)) < STRIPE_RATIO || c.height < MIN_OCR_HEIGHT;
    if (isStripe) {
      const fx = Math.min(HORIZ_STRETCH, maxWidth / Math.max(1, c.width));
      if (fx > 1.01) c = stretchCanvasX(c, fx);
    }
  }
  const w = c.width, h = c.height;
  const ctx = c.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114) | 0;
  }
  // 2) Adaptive threshold (Bradley-Roth) with gentle bias
  const bin1 = adaptiveThreshold(gray, w, h, Math.max(15, Math.floor(Math.min(w, h) * 0.03) | 1), 2);
  // If we nuked too much (too few black pixels), retry with lower bias (more black)
  let blackCount = 0; for (let i = 0; i < bin1.length; i++) blackCount += bin1[i];
  let bin = bin1;
  if (blackCount / (w * h) < 0.01) {
    bin = adaptiveThreshold(gray, w, h, Math.max(15, Math.floor(Math.min(w, h) * 0.03) | 1), 0);
  }
  // 3) Preserve tiny punctuation (decimal points) — skip median filtering
  //    which tends to remove single-pixel dots and commas in receipts.
  const med = bin;
  // 4) Draw to a new canvas as pure black/white
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const outData = octx.createImageData(w, h);
  const od = outData.data;
  for (let p = 0, i = 0; p < med.length; p++, i += 4) {
    const v = med[p] ? 0 : 255; // black text on white
    od[i] = od[i+1] = od[i+2] = v;
    od[i+3] = 255;
  }
  octx.putImageData(outData, 0, 0);
  return out;
}

function adaptiveThreshold(gray, w, h, win, bias) {
  const ii = new Uint32Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let row = 0; const off = y * (w + 1);
    for (let x = 1; x <= w; x++) {
      row += gray[(y - 1) * w + (x - 1)];
      ii[off + x] = ii[off - (w + 1) + x] + row;
    }
  }
  const half = (win / 2) | 0;
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
      const A = ii[y0 * (w + 1) + x0];
      const B = ii[y0 * (w + 1) + (x1 + 1)];
      const Cc = ii[(y1 + 1) * (w + 1) + x0];
      const D = ii[(y1 + 1) * (w + 1) + (x1 + 1)];
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = (D - B - Cc + A) / area;
      bin[y * w + x] = (gray[y * w + x] <= mean - bias) ? 1 : 0;
    }
  }
  return bin;
}

function medianFilterBin(src, w, h) {
  const dst = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let yy = y - 1; yy <= y + 1; yy++) {
        if (yy < 0 || yy >= h) continue;
        for (let xx = x - 1; xx <= x + 1; xx++) {
          if (xx < 0 || xx >= w) continue;
          sum += src[yy * w + xx];
          cnt++;
        }
      }
      dst[y * w + x] = (sum >= 5) ? 1 : 0; // median of 9 neighbors
    }
  }
  return dst;
}

function morphErode(mask, w, h, iterations = 1) {
  let src = mask, dst = new Uint8Array(w * h);
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let keep = 1;
        for (let yy = y - 1; yy <= y + 1 && keep; yy++) {
          if (yy < 0 || yy >= h) { keep = 0; break; }
          for (let xx = x - 1; xx <= x + 1; xx++) {
            if (xx < 0 || xx >= w || !src[yy * w + xx]) { keep = 0; break; }
          }
        }
        dst[y * w + x] = keep ? 1 : 0;
      }
    }
    if (it + 1 < iterations) { const tmp = src; src = dst; dst = tmp; }
  }
  return dst;
}

function morphDilate(mask, w, h, iterations = 1) {
  let src = mask, dst = new Uint8Array(w * h);
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let on = 0;
        for (let yy = y - 1; yy <= y + 1 && !on; yy++) {
          if (yy < 0 || yy >= h) continue;
          for (let xx = x - 1; xx <= x + 1; xx++) {
            if (xx < 0 || xx >= w) continue;
            if (src[yy * w + xx]) { on = 1; break; }
          }
        }
        dst[y * w + x] = on ? 1 : 0;
      }
    }
    if (it + 1 < iterations) { const tmp = src; src = dst; dst = tmp; }
  }
  return dst;
}

// Initialize
resetSteps();

// --- Logs and sidepanes ---
function addLog(message, highlight = false) {
  const div = document.createElement('div');
  div.className = 'log-line' + (highlight ? ' hl' : '');
  div.textContent = message;
  logList.appendChild(div);
  logList.scrollTop = logList.scrollHeight;
}

function formatSumLog(page, receipt, line) {
  return `Page ${page} receipt ${receipt}: ${line ?? ''}`;
}

function clearLogs() { logList.innerHTML = ''; }

function addSumLog(amount, line) {
  const l = line ? line.replace(/\s+/g, ' ').trim() : '';
  const a = (amount != null && isFinite(amount)) ? amount.toFixed(2) : '';
  addLog(`${a}\t${l}`, true);
}

function clearFeed() {
  if (feed) feed.innerHTML = '';
}
