import { createUI } from './ui/ui.js';
import { runPipeline } from './pipeline.js';
import { runCalibrate } from './calibrate.js';

const ui = createUI();
ui.resetSteps();

let cancelToken = { cancelled: false };
let isRunning = false;
let isCalibrating = false;
let runPromise = null;

const { fileInput, cancelBtn, failedOnlyCb } = ui.dom;
const processBtn = document.getElementById('processBtn');
const calibrateBtn = document.getElementById('calibrateBtn');
// Show calibration button only if localStorage flag is set
const showCalibrate = (localStorage.getItem('enableCalibrate') === '1');
if (calibrateBtn && !showCalibrate) calibrateBtn.style.display = 'none';

if (failedOnlyCb) {
  failedOnlyCb.addEventListener('change', () => {
    document.body.classList.toggle('fail-only', !!failedOnlyCb.checked);
  });
}

if (cancelBtn) {
  cancelBtn.addEventListener('click', () => {
    if (isRunning && !cancelToken.cancelled) {
      cancelToken.cancelled = true;
      ui.addLog('Cancelling…');
      cancelBtn.disabled = true;
    }
  });
}

if (fileInput) {
  fileInput.addEventListener('change', async () => {
    if (!fileInput.files?.length) return;
    // Reset UI and auto-run pipeline
    ui.clearFeed(); ui.resetSteps();
    cancelToken = { cancelled: false };
    if (isCalibrating) { ui.addLog('Busy calibrating — skipping auto-run.'); return; }
    if (isRunning) { cancelToken.cancelled = true; try { await runPromise; } catch {} }
    isRunning = true; cancelBtn && (cancelBtn.disabled = false);
    processBtn && (processBtn.disabled = true); if (calibrateBtn && showCalibrate) calibrateBtn.disabled = true;
    try { runPromise = runPipeline(fileInput.files[0], ui, cancelToken); await runPromise; }
    finally {
      isRunning = false; runPromise = null; cancelBtn && (cancelBtn.disabled = true);
      processBtn && (processBtn.disabled = false); if (calibrateBtn && showCalibrate) calibrateBtn.disabled = false;
    }
  });
}

if (calibrateBtn) {
  calibrateBtn.addEventListener('click', async () => {
    if (!fileInput.files?.length) { alert('Choose a PDF first.'); return; }
    if (isRunning && runPromise) {
      cancelToken.cancelled = true;
      ui.addLog('Waiting for current processing to cancel before calibration…');
      try { await runPromise; } catch {}
    }
    if (isCalibrating) return;
    isCalibrating = true;
    processBtn && (processBtn.disabled = true);
    calibrateBtn.disabled = true;
    ui.addLog('Starting calibration…');
    try { await runCalibrate(fileInput.files[0], ui); }
    finally {
      isCalibrating = false;
      processBtn && (processBtn.disabled = false);
      calibrateBtn.disabled = false;
    }
  });
}

if (processBtn) {
  processBtn.addEventListener('click', async () => {
    if (!fileInput.files?.length) { alert('Choose a PDF first.'); return; }
    if (isRunning) return;
    isRunning = true;
    cancelToken = { cancelled: false };
    cancelBtn && (cancelBtn.disabled = false);
    processBtn.disabled = true; calibrateBtn && (calibrateBtn.disabled = true);
    try { runPromise = runPipeline(fileInput.files[0], ui, cancelToken); await runPromise; }
    finally {
      isRunning = false; runPromise = null;
      cancelBtn && (cancelBtn.disabled = true);
      processBtn.disabled = false; calibrateBtn && (calibrateBtn.disabled = false);
    }
  });
}
