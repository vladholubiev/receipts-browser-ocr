// Shared configuration constants
export const RENDER_SCALE = 3;
export const MAX_OCR_WIDTH = 2048;
export const MIN_OCR_HEIGHT = 160;
export const HORIZ_STRETCH = 1.3;
export const STRIPE_RATIO = 0.25;
export const DEFAULT_PSM = '6';
export const STRIPE_PSM = '7';
export const WORKERS = (() => {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 4;
  const n = cores - 1; // leave 1 core for UI/threadpool
  // Keep a sensible range to avoid oversubscription on high-core machines
  return Math.max(2, Math.min(n, 8));
})();
export const OCR_WHITELIST = 'SUMADOZAPLATYPLN0123456789,. :';

// SUMA strip (base 576x902 receipts)
export const SUMA_BASE_W = 576;
export const SUMA_BASE_H = 902;
export const SUMA_STRIP_TOP_PX = 408;
export const SUMA_STRIP_HEIGHT_PX = 54;
export const SUMA_STRIP_LEFT_PX = 0;
export const SUMA_STRIP_RIGHT_PX = 0;
export const SUMA_PSM = '7';
export const SUMA_WHITELIST = 'PLN0123456789,. :SUMA';
