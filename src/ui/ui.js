// Minimal DOM/ UI helper module

const $ = (sel, root = document) => root.querySelector(sel);

function stepElements(sel) {
  const root = $(sel);
  return {
    root,
    fill: root ? root.querySelector('[data-fill]') : null,
    counter: root ? root.querySelector('[data-counter]') : null,
    meta: root ? root.querySelector('[data-meta]') : null,
    eta: root ? root.querySelector('[data-eta]') : null,
    startedAt: 0,
    total: 0,
    done: 0,
  };
}

function setStepProgress(step, done, total) {
  step.done = done;
  step.total = total;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  if (step.fill) step.fill.style.width = pct + '%';
}
function setStepMeta(step, text) { if (step.meta) step.meta.textContent = text; }
function setStepCounter(step, text) { if (step.counter) step.counter.textContent = text; }
function setETA(step, text) { if (step.eta) step.eta.textContent = text; }

function startStep(step, total, label) {
  step.startedAt = performance.now();
  step.total = total;
  step.done = 0;
  setStepMeta(step, label || '');
  setStepProgress(step, 0, total);
  setETA(step, 'Time 0s | Remaining —');
  setStepCounter(step, '');
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
    setETA(step, `Time ${formatDuration(elapsed)} | Remaining ${formatDuration(eta)}`);
  }
}

function formatDuration(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  if (sec < 1) return '0s';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function createUI() {
  const fileInput = $('#fileInput');
  const cancelBtn = $('#cancelBtn');
  const failedOnlyCb = $('#failedOnly');
  const totalSumEl = $('#totalSum');
  const countReceiptsEl = $('#countReceipts');
  const countMissingEl = $('#countMissing');
  const sumFill = $('#sumFill');
  const logList = $('#logList');
  const feed = $('#feed');
  const steps = { progress: stepElements('#step-progress') };

  function resetSteps() {
    for (const key of Object.keys(steps)) {
      const s = steps[key];
      s.startedAt = 0; s.total = 0; s.done = 0;
      setStepProgress(s, 0, 0); setStepMeta(s, ''); setETA(s, ''); setStepCounter(s, '');
    }
    if (steps.progress && steps.progress.meta) steps.progress.meta.textContent = 'Waiting for file…';
  }

  function addLog(message, highlight = false) {
    if (!logList) return;
    const prev = logList.value || '';
    // Prepend newest messages to match previous behavior
    logList.value = prev ? `${message}\n${prev}` : message;
  }

  function addSumLog(amount, line) {
    const l = line ? line.replace(/\s+/g, ' ').trim() : '';
    const a = (amount != null && isFinite(amount)) ? amount.toFixed(2) : '';
    addLog(`${a}\t${l}`, true);
  }

  function updateTotals(receiptCount, missingCount, grandTotal, receiptsTotal = null) {
    countReceiptsEl.textContent = String(receiptCount);
    countMissingEl.textContent = String(missingCount);
    totalSumEl.textContent = grandTotal.toFixed(2);
    const total = receiptsTotal || Math.max(receiptCount, 1);
    const pct = Math.min(100, Math.round((receiptCount / total) * 100));
    if (sumFill) sumFill.style.width = pct + '%';
  }

  function clearFeed() { if (feed) feed.innerHTML = ''; }

  function appendFeedPost(pageNum, amounts, roiPre, texts, sumaLines) {
    const post = document.createElement('div');
    post.className = 'post';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const total = roiPre ? roiPre.length : amounts.length;
    const okCount = amounts.filter(a => a != null).length;
    meta.textContent = `Page ${pageNum}: ${okCount}/${total} receipts recognized`;
    if (okCount < total) post.classList.add('has-fail');
    post.appendChild(meta);

    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    roiPre.forEach((cnv, idx) => {
      const ok = amounts[idx] != null;
      const container = document.createElement('div');
      container.className = 'thumb ' + (ok ? 'ok' : 'fail');
      const label = document.createElement('div');
      label.className = 'label';
      const left = document.createElement('span');
      left.className = 'left';
      left.textContent = `#${idx+1}`;
      const right = document.createElement('span');
      right.className = 'right';
      right.textContent = ok ? amounts[idx].toFixed(2) : 'missing';
      label.appendChild(left);
      label.appendChild(right);
      container.appendChild(label);
      const wrap = document.createElement('div');
      wrap.className = 'thumb-canvas-wrap';
      const c = document.createElement('canvas');
      c.width = cnv.width; c.height = cnv.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(cnv, 0, 0);
      wrap.appendChild(c);
      // Removed inline SUMA badge overlay to avoid duplication
      container.appendChild(wrap);
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

  return {
    dom: { fileInput, cancelBtn, failedOnlyCb },
    steps,
    progress: {
      start: (total, label) => startStep(steps.progress, total, label),
      tick: (inc = 1) => tickStep(steps.progress, inc),
      setMeta: (text) => setStepMeta(steps.progress, text),
      setCounter: (text) => setStepCounter(steps.progress, text),
    },
    addLog,
    addSumLog,
    updateTotals,
    clearFeed,
    resetSteps,
    appendFeedPost,
  };
}
