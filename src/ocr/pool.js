import { DEFAULT_PSM, OCR_WHITELIST, SUMA_PSM, SUMA_WHITELIST } from '../config.js';

// Scheduler-backed pool with two groups: ROI (SUMA) and FULL (fallback)
export function createWorkerPool(n, onLog) {
  return {
    n,
    onLog,
    mode: n <= 1 ? 'single' : 'split',
    workersROI: [],
    workersFull: [],
    workersSingle: [],
    schedulerROI: null,
    schedulerFull: null,
    schedulerSingle: null,
  };
}

export async function initWorkers(pool, lang = 'eng') {
  const T = window.Tesseract;
  if (pool.mode === 'single') {
    pool.schedulerSingle = T.createScheduler();
    const w = await T.createWorker(lang, 1, { logger: pool.onLog }, { load_system_dawg: '0', load_freq_dawg: '0' });
    await w.setParameters({
      tessedit_pageseg_mode: DEFAULT_PSM,
      preserve_interword_spaces: '1',
      tessedit_char_whitelist: OCR_WHITELIST,
      user_defined_dpi: '300', classify_bln_numeric_mode: '1',
    });
    pool.schedulerSingle.addWorker(w);
    pool.workersSingle.push(w);
  } else {
    // Favor ROI workers heavily: ROI = N-1, FULL = 1
    const roiCount = Math.max(1, pool.n - 1);
    const fullCount = 1;

    pool.schedulerROI = T.createScheduler();
    pool.schedulerFull = T.createScheduler();

    // ROI workers (SUMA strip: tight whitelist + PSM)
    for (let i = 0; i < roiCount; i++) {
      const w = await T.createWorker(lang, 1, { logger: pool.onLog }, { load_system_dawg: '0', load_freq_dawg: '0' });
      await w.setParameters({
        tessedit_pageseg_mode: SUMA_PSM,
        preserve_interword_spaces: '1',
        tessedit_char_whitelist: SUMA_WHITELIST,
        user_defined_dpi: '300', classify_bln_numeric_mode: '1',
      });
      pool.schedulerROI.addWorker(w);
      pool.workersROI.push(w);
    }

    // FULL workers (fallback: broader whitelist + default PSM)
    for (let i = 0; i < fullCount; i++) {
      const w = await T.createWorker(lang, 1, { logger: pool.onLog }, { load_system_dawg: '0', load_freq_dawg: '0' });
      await w.setParameters({
        tessedit_pageseg_mode: DEFAULT_PSM,
        preserve_interword_spaces: '1',
        tessedit_char_whitelist: OCR_WHITELIST,
        user_defined_dpi: '300', classify_bln_numeric_mode: '1',
      });
      pool.schedulerFull.addWorker(w);
      pool.workersFull.push(w);
    }
  }
}

export async function terminateWorkers(pool) {
  try { if (pool.schedulerROI) await pool.schedulerROI.terminate(); } catch {}
  try { if (pool.schedulerFull) await pool.schedulerFull.terminate(); } catch {}
  try { if (pool.schedulerSingle) await pool.schedulerSingle.terminate(); } catch {}
  pool.workersROI = []; pool.workersFull = []; pool.workersSingle = [];
  pool.schedulerROI = null; pool.schedulerFull = null; pool.schedulerSingle = null; pool.mode = pool.n <= 1 ? 'single' : 'split';
}

export async function recognizeWithPoolParams(pool, canvas, { psm = DEFAULT_PSM, whitelist = OCR_WHITELIST } = {}) {
  // Single-worker mode: safe to change parameters per job
  if (pool.mode === 'single' && pool.schedulerSingle) {
    const params = {
      tessedit_pageseg_mode: psm || DEFAULT_PSM,
      tessedit_char_whitelist: whitelist || OCR_WHITELIST,
    };
    await pool.schedulerSingle.addJob('setParameters', params);
    const { data } = await pool.schedulerSingle.addJob('recognize', canvas);
    // reset to defaults
    await pool.schedulerSingle.addJob('setParameters', { tessedit_pageseg_mode: DEFAULT_PSM, tessedit_char_whitelist: OCR_WHITELIST });
    return data && data.text ? data.text : '';
  }

  // Split mode: route to ROI scheduler if params differ from default; otherwise use FULL
  const useROI = (psm !== DEFAULT_PSM) || (whitelist !== OCR_WHITELIST);
  const scheduler = useROI ? pool.schedulerROI : pool.schedulerFull;
  const { data } = await scheduler.addJob('recognize', canvas);
  return data && data.text ? data.text : '';
}
