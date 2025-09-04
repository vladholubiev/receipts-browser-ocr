import { DEFAULT_PSM, OCR_WHITELIST } from '../config.js';

export function createWorkerPool(n, onLog) {
  const pool = [];
  for (let i = 0; i < n; i++) {
    const worker = window.Tesseract.createWorker({ logger: onLog });
    pool.push({ worker, busy: false, id: i });
  }
  return pool;
}

export async function initWorkers(pool, lang = 'eng+pol') {
  for (const slot of pool) {
    await slot.worker.load();
    await slot.worker.loadLanguage(lang);
    await slot.worker.initialize(lang);
    await slot.worker.setParameters({
      tessedit_pageseg_mode: DEFAULT_PSM,
      preserve_interword_spaces: '1',
      tessedit_char_whitelist: OCR_WHITELIST,
      load_system_dawg: '0', load_freq_dawg: '0', user_defined_dpi: '300', classify_bln_numeric_mode: '1',
    });
  }
}

export async function terminateWorkers(pool) {
  for (const slot of pool) { try { await slot.worker.terminate(); } catch {} }
}

export function acquireWorker(pool) {
  return new Promise(resolve => {
    const tryPick = () => {
      const idx = pool.findIndex(p => !p.busy);
      if (idx >= 0) { pool[idx].busy = true; resolve(pool[idx]); }
      else setTimeout(tryPick, 10);
    };
    tryPick();
  });
}

export async function recognizeWithPoolParams(pool, canvas, { psm = DEFAULT_PSM, whitelist = OCR_WHITELIST } = {}) {
  const slot = await acquireWorker(pool);
  try {
    const params = {};
    if (psm) params.tessedit_pageseg_mode = psm;
    if (whitelist) params.tessedit_char_whitelist = whitelist;
    await slot.worker.setParameters(params);
    const { data } = await slot.worker.recognize(canvas);
    await slot.worker.setParameters({ tessedit_pageseg_mode: DEFAULT_PSM, tessedit_char_whitelist: OCR_WHITELIST });
    return data && data.text ? data.text : '';
  } finally { slot.busy = false; }
}

