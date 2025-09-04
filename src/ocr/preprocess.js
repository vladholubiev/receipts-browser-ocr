import { MAX_OCR_WIDTH, MIN_OCR_HEIGHT, HORIZ_STRETCH, STRIPE_RATIO, SUMA_BASE_W, SUMA_BASE_H, SUMA_STRIP_TOP_PX, SUMA_STRIP_HEIGHT_PX, SUMA_STRIP_LEFT_PX, SUMA_STRIP_RIGHT_PX } from '../config.js';

export function cropCanvas(src, x, y, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

export function scaleCanvas(src, scale) {
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

export function normalizeOcrCanvas(src, maxWidth = MAX_OCR_WIDTH, minHeight = MIN_OCR_HEIGHT) {
  let scale = 1;
  if (src.height < minHeight) scale = Math.max(scale, minHeight / Math.max(1, src.height));
  if (src.width * scale > maxWidth) scale = Math.min(scale, maxWidth / Math.max(1, src.width));
  return scaleCanvas(src, scale);
}

export function stretchCanvasX(src, factor) {
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

export function preprocessForOCR(srcCanvas, maxWidth = MAX_OCR_WIDTH) {
  let c = normalizeOcrCanvas(srcCanvas, maxWidth, MIN_OCR_HEIGHT);
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
  const bin1 = adaptiveThreshold(gray, w, h, Math.max(15, Math.floor(Math.min(w, h) * 0.03) | 1), 2);
  let blackCount = 0; for (let i = 0; i < bin1.length; i++) blackCount += bin1[i];
  let bin = bin1;
  if (blackCount / (w * h) < 0.01) bin = adaptiveThreshold(gray, w, h, Math.max(15, Math.floor(Math.min(w, h) * 0.03) | 1), 0);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const outData = octx.createImageData(w, h);
  const od = outData.data;
  for (let p = 0, i = 0; p < bin.length; p++, i += 4) {
    const v = bin[p] ? 0 : 255;
    od[i] = od[i+1] = od[i+2] = v; od[i+3] = 255;
  }
  octx.putImageData(outData, 0, 0);
  return out;
}

export function adaptiveThreshold(gray, w, h, win, bias) {
  const ii = new Uint32Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let row = 0; const off = y * (w + 1);
    for (let x = 1; x <= w; x++) { row += gray[(y - 1) * w + (x - 1)]; ii[off + x] = ii[off - (w + 1) + x] + row; }
  }
  const half = (win / 2) | 0; const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
      const A = ii[y0 * (w + 1) + x0], B = ii[y0 * (w + 1) + (x1 + 1)];
      const Cc = ii[(y1 + 1) * (w + 1) + x0], D = ii[(y1 + 1) * (w + 1) + (x1 + 1)];
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = (D - B - Cc + A) / area;
      bin[y * w + x] = (gray[y * w + x] <= mean - bias) ? 1 : 0;
    }
  }
  return bin;
}

export function trimMarginsBox(srcCanvas) {
  const { w, h, scale, bin } = toSmallBinary(srcCanvas, 600);
  const colDensity = new Float32Array(w);
  const rowDensity = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let rowBlack = 0; for (let x = 0; x < w; x++) { if (bin[y * w + x] === 0) rowBlack++; }
    rowDensity[y] = rowBlack / w;
  }
  for (let x = 0; x < w; x++) {
    let colBlack = 0; for (let y = 0; y < h; y++) { if (bin[y * w + x] === 0) colBlack++; }
    colDensity[x] = colBlack / h;
  }
  const thr = 0.02;
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  for (let y = 0; y < h; y++) { if (rowDensity[y] > thr) { top = y; break; } }
  for (let y = h - 1; y >= 0; y--) { if (rowDensity[y] > thr) { bottom = y; break; } }
  for (let x = 0; x < w; x++) { if (colDensity[x] > thr) { left = x; break; } }
  for (let x = w - 1; x >= 0; x--) { if (colDensity[x] > thr) { right = x; break; } }
  const pad = Math.floor(8 * (1 / scale));
  const X = Math.max(0, Math.floor(left / scale) - pad);
  const Y = Math.max(0, Math.floor(top / scale) - pad);
  const W = Math.min(srcCanvas.width - X, Math.ceil((right - left + 1) / scale) + 2 * pad);
  const H = Math.min(srcCanvas.height - Y, Math.ceil((bottom - top + 1) / scale) + 2 * pad);
  return { x: X, y: Y, w: W, h: H };
}

export function computeFullReceipt(srcCanvas) {
  const base = trimMarginsBox(srcCanvas);
  const pad = 2;
  const roi = {
    x: Math.max(0, base.x - pad), y: Math.max(0, base.y - pad),
    w: Math.min(srcCanvas.width - Math.max(0, base.x - pad), base.w + pad * 2),
    h: Math.min(srcCanvas.height - Math.max(0, base.y - pad), base.h + pad * 2),
  };
  return { base, roi };
}

export function cropSumaStripFromReceipt(receiptCanvas) {
  const W = receiptCanvas.width; const H = receiptCanvas.height;
  // Scale all pixel-based measurements using width only. Some receipts are taller
  // (extra space at bottom) but the SUMA line is the same distance from the top.
  const s = W / SUMA_BASE_W; // width-based scale
  const x = Math.max(0, Math.floor(SUMA_STRIP_LEFT_PX * s));
  const y = Math.max(0, Math.floor(SUMA_STRIP_TOP_PX * s));
  const w = Math.max(1, W - x - Math.floor(SUMA_STRIP_RIGHT_PX * s));
  const h = Math.max(1, Math.floor(SUMA_STRIP_HEIGHT_PX * s));
  const adjY = Math.min(y, H - 1); const adjH = Math.min(h, H - adjY);
  const canvas = cropCanvas(receiptCanvas, x, adjY, w, adjH);
  return { canvas, rect: { x, y: adjY, w, h: adjH } };
}

export function toSmallBinary(canvas, targetW = 800) {
  const scale = Math.min(1, targetW / canvas.width);
  const w = Math.max(1, Math.floor(canvas.width * scale));
  const h = Math.max(1, Math.floor(canvas.height * scale));
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(canvas, 0, 0, w, h);
  const img = tctx.getImageData(0, 0, w, h);
  const data = img.data;
  let sum = 0; for (let i = 0; i < data.length; i += 4) { const g = (data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114); sum += g; }
  const avg = sum / (data.length / 4);
  const thr = Math.min(250, Math.max(200, avg + 20));
  const bin = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114);
    bin[p] = g >= thr ? 255 : 0;
  }
  return { w, h, scale, bin };
}
