import { RENDER_SCALE } from '../config.js';

export async function loadPDF(file) {
  const url = URL.createObjectURL(file);
  const loadingTask = window.pdfjsLib.getDocument({ url });
  const pdf = await loadingTask.promise;
  URL.revokeObjectURL(url);
  return pdf;
}

export async function renderPageToCanvasWithBoxes(page, scale = RENDER_SCALE) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');

  const recorded = [];
  const origDrawImage = ctx.drawImage.bind(ctx);
  const origPutImageData = ctx.putImageData.bind(ctx);
  const hasGetTransform = (typeof ctx.getTransform === 'function');
  const I = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  let cur = { ...I };
  const stack = [];
  const mul = (m, n) => ({
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  });
  const toM = (a, b, c, d, e, f) => ({ a, b, c, d, e, f });
  const getCTM = () => (hasGetTransform ? ctx.getTransform() : cur);
  if (!hasGetTransform) {
    const origSave = ctx.save.bind(ctx);
    const origRestore = ctx.restore.bind(ctx);
    const origTranslate = ctx.translate.bind(ctx);
    const origScale = ctx.scale.bind(ctx);
    const origRotate = ctx.rotate.bind(ctx);
    const origTransform = ctx.transform.bind(ctx);
    const origSetTransform = ctx.setTransform.bind(ctx);
    const origResetTransform = ctx.resetTransform ? ctx.resetTransform.bind(ctx) : null;
    ctx.save = function() { stack.push({ ...cur }); return origSave(); };
    ctx.restore = function() { cur = stack.pop() || { ...I }; return origRestore(); };
    ctx.translate = function(tx, ty) { cur = mul(cur, toM(1,0,0,1,tx,ty)); return origTranslate(tx, ty); };
    ctx.scale = function(sx, sy) { cur = mul(cur, toM(sx,0,0,sy,0,0)); return origScale(sx, sy); };
    ctx.rotate = function(theta) { const cos = Math.cos(theta), sin = Math.sin(theta); cur = mul(cur, toM(cos, sin, -sin, cos, 0, 0)); return origRotate(theta); };
    ctx.transform = function(a,b,c,d,e,f) { cur = mul(cur, toM(a,b,c,d,e,f)); return origTransform(a,b,c,d,e,f); };
    ctx.setTransform = function(a,b,c,d,e,f) { if (a && typeof a === 'object' && 'a' in a) { cur = { a: a.a, b: a.b, c: a.c, d: a.d, e: a.e, f: a.f }; return origSetTransform(a); } cur = toM(a,b,c,d,e,f); return origSetTransform(a,b,c,d,e,f); };
    if (origResetTransform) ctx.resetTransform = function() { cur = { ...I }; return origResetTransform(); };
  }

  ctx.drawImage = function(img, ...rest) {
    try {
      let dx = 0, dy = 0, dw = img && img.width || 0, dh = img && img.height || 0;
      if (rest.length === 2) { dx = rest[0]; dy = rest[1]; }
      else if (rest.length === 4) { dx = rest[0]; dy = rest[1]; dw = rest[2]; dh = rest[3]; }
      else if (rest.length === 8) { dx = rest[4]; dy = rest[5]; dw = rest[6]; dh = rest[7]; }
      const t = getCTM();
      if (t) {
        const pts = [
          { x: dx,       y: dy },
          { x: dx + dw,  y: dy },
          { x: dx,       y: dy + dh },
          { x: dx + dw,  y: dy + dh },
        ];
        const xs = [], ys = [];
        for (const p of pts) { const x = t.a * p.x + t.c * p.y + t.e; const y = t.b * p.x + t.d * p.y + t.f; xs.push(x); ys.push(y); }
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const x = Math.round(minX), y = Math.round(minY);
        const w = Math.round(maxX - minX), h = Math.round(maxY - minY);
        if (w > 4 && h > 4) recorded.push({ x, y, w, h });
      }
    } catch (_) {}
    return origDrawImage(img, ...rest);
  };

  ctx.putImageData = function(imageData, dx, dy, ...rest) {
    try {
      const w = imageData && imageData.width || 0; const h = imageData && imageData.height || 0;
      if (w > 4 && h > 4) {
        let x = dx || 0, y = dy || 0, ww = w, hh = h;
        const t = getCTM();
        const pts = [
          { x: x,       y: y },
          { x: x + ww,  y: y },
          { x: x,       y: y + hh },
          { x: x + ww,  y: y + hh },
        ];
        const xs = [], ys = [];
        for (const p of pts) { const xx = t.a * p.x + t.c * p.y + t.e; const yy = t.b * p.x + t.d * p.y + t.f; xs.push(xx); ys.push(yy); }
        const minX = Math.min(...xs), maxX = Math.max(...xs); const minY = Math.min(...ys), maxY = Math.max(...ys);
        const rx = Math.round(minX), ry = Math.round(minY); const rw = Math.round(maxX - minX), rh = Math.round(maxY - minY);
        if (rw > 4 && rh > 4) recorded.push({ x: rx, y: ry, w: rw, h: rh });
      }
    } catch (_) {}
    return origPutImageData(imageData, dx, dy, ...rest);
  };

  await page.render({ canvasContext: ctx, viewport }).promise;

  const mergeRects = (rects, gap = 4) => {
    const out = rects.slice();
    let merged = true;
    const overlaps = (r1, r2) => {
      const a = { x: r1.x - gap, y: r1.y - gap, w: r1.w + 2*gap, h: r1.h + 2*gap };
      const b = { x: r2.x - gap, y: r2.y - gap, w: r2.w + 2*gap, h: r2.h + 2*gap };
      return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
    };
    while (merged) {
      merged = false;
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const A = out[i], B = out[j];
          if (overlaps(A, B)) {
            const nx = Math.min(A.x, B.x);
            const ny = Math.min(A.y, B.y);
            const nx2 = Math.max(A.x + A.w, B.x + B.w);
            const ny2 = Math.max(A.y + A.h, B.y + B.h);
            out[i] = { x: nx, y: ny, w: nx2 - nx, h: ny2 - ny };
            out.splice(j, 1);
            merged = true;
            break;
          }
        }
        if (merged) break;
      }
    }
    return out;
  };

  const merged = mergeRects(recorded, 4);
  const minArea = canvas.width * canvas.height * 0.003; // 0.3% page area
  const boxes = merged.filter(b => (b.w * b.h) >= minArea)
                     .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  try { console.debug('render capture boxes:', { recorded: recorded.length, merged: merged.length, kept: boxes.length }); } catch {}
  return { canvas, boxes };
}
