(function () {
// core.js — pure logic: units, layout helpers, and the lossless PDF export.
// No DOM access here, so it can be tested in Node. The pdf-lib module is passed in.

const PT_PER_MM = 72 / 25.4;
const A4_MM = { w: 210, h: 297 };
// Exact A4 in PDF points (595.276 x 841.890)
const A4_PT = { w: 210 * PT_PER_MM, h: 297 * PT_PER_MM };

const sheetSizeMm = (sheet) =>
  sheet.landscape ? { w: A4_MM.h, h: A4_MM.w } : { w: A4_MM.w, h: A4_MM.h };

const norm = (d) => ((d % 360) + 360) % 360;

/**
 * A piece is a rectangle cut from a source page, placed on a sheet.
 * {
 *   id, page (0-based), rect: {x0,y0,x1,y1} in PDF user-space points (unrotated page space),
 *   pageRotate (the page's /Rotate), rot (extra clockwise rotation, 0/90/180/270),
 *   sheet (id), x, y (mm from the sheet's top-left)
 * }
 */
function pieceSizePt(p) {
  const w = p.rect.x1 - p.rect.x0;
  const h = p.rect.y1 - p.rect.y0;
  const t = norm(p.pageRotate + (p.rot || 0));
  return t % 180 === 0 ? { w, h } : { w: h, h: w };
}

function pieceSizeMm(p) {
  const s = pieceSizePt(p);
  return { w: s.w / PT_PER_MM, h: s.h / PT_PER_MM };
}

// ---------- layout helpers ----------

const overlaps = (a, b) =>
  a.x < b.x + b.w - 0.01 && a.x + a.w > b.x + 0.01 && a.y < b.y + b.h - 0.01 && a.y + a.h > b.y + 0.01;

function rectOf(p) {
  const s = pieceSizeMm(p);
  return { x: p.x, y: p.y, w: s.w, h: s.h };
}

/** First position (scanning left→right, top→bottom) where a w×h piece fits without overlap, or null. */
function findFreeSpot(sheetMm, others, w, h, step = 2) {
  const rects = others.map(rectOf);
  for (let y = 0; y + h <= sheetMm.h + 0.01; y += step) {
    for (let x = 0; x + w <= sheetMm.w + 0.01; x += step) {
      const cand = { x, y, w, h };
      if (!rects.some((r) => overlaps(cand, r))) return { x, y };
    }
  }
  return null;
}

function overlapsAny(p, others) {
  const r = rectOf(p);
  return others.some((o) => o !== p && overlaps(r, rectOf(o)));
}

function clampToSheet(p, sheetMm) {
  const s = pieceSizeMm(p);
  p.x = Math.max(0, Math.min(p.x, Math.max(0, sheetMm.w - s.w)));
  p.y = Math.max(0, Math.min(p.y, Math.max(0, sheetMm.h - s.h)));
}

/**
 * Snap a moving rect to sheet edges, sheet centre lines and edges of other pieces.
 * Returns the snapped position plus guide lines to draw.
 */
function snap(rect, others, sheetMm, thr) {
  const xs = [0, sheetMm.w / 2, sheetMm.w];
  const ys = [0, sheetMm.h / 2, sheetMm.h];
  for (const o of others) {
    xs.push(o.x, o.x + o.w);
    ys.push(o.y, o.y + o.h);
  }
  const best = (edges, targets) => {
    let out = null;
    for (const e of edges) {
      for (const t of targets) {
        const d = t - e.v;
        if (Math.abs(d) <= thr && (!out || Math.abs(d) < Math.abs(out.d))) out = { d, at: t };
      }
    }
    return out;
  };
  const sx = best([{ v: rect.x }, { v: rect.x + rect.w }, { v: rect.x + rect.w / 2 }], xs);
  const sy = best([{ v: rect.y }, { v: rect.y + rect.h }, { v: rect.y + rect.h / 2 }], ys);
  const guides = [];
  const out = { x: rect.x, y: rect.y, guides };
  if (sx) { out.x += sx.d; guides.push({ axis: 'x', at: sx.at }); }
  if (sy) { out.y += sy.d; guides.push({ axis: 'y', at: sy.at }); }
  return out;
}

// ---------- coordinate helpers for the crop tool ----------

/** Normalise two arbitrary PDF-space corner points into a rect. */
function rectFromPoints(a, b) {
  return {
    x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]),
    x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]),
  };
}

// ---------- lossless export ----------

function rotatePt(x, y, deg) {
  // exact for multiples of 90°
  const d = norm(deg);
  if (d === 0) return [x, y];
  if (d === 90) return [-y, x];
  if (d === 180) return [-x, -y];
  return [y, -x]; // 270
}

/**
 * Build the output PDF.
 *  - Each source page is embedded ONCE as a vector form XObject (no rasterising, no re-encoding).
 *  - Every piece is drawn at exactly 1:1 scale, clipped to its crop rectangle.
 *  - Copies of a piece reuse the same embedded page, so file size barely grows.
 */
async function exportPdf(lib, srcBytes, sheets, pieces) {
  const { PDFDocument, degrees, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } = lib;
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const embedded = new Map(); // source page index -> {emb, mb}

  async function getEmbedded(i) {
    if (!embedded.has(i)) {
      const page = src.getPage(i);
      const mb = page.getMediaBox();
      const emb = await out.embedPage(page, {
        left: mb.x, bottom: mb.y, right: mb.x + mb.width, top: mb.y + mb.height,
      });
      embedded.set(i, { emb, mb });
    }
    return embedded.get(i);
  }

  for (const sheet of sheets) {
    const mine = pieces.filter((p) => p.sheet === sheet.id);
    const wPt = (sheet.landscape ? A4_MM.h : A4_MM.w) * PT_PER_MM;
    const hPt = (sheet.landscape ? A4_MM.w : A4_MM.h) * PT_PER_MM;
    const page = out.addPage([wPt, hPt]);

    for (const p of mine) {
      const { emb, mb } = await getEmbedded(p.page);
      const size = pieceSizePt(p);
      const bx = p.x * PT_PER_MM;
      const by = hPt - (p.y * PT_PER_MM + size.h); // lower-left of the destination box
      const T = norm(p.pageRotate + (p.rot || 0)); // clockwise rotation as displayed
      const phi = norm(360 - T); // counter-clockwise rotation applied to the form

      // crop rect relative to the embedded page's origin
      const cx0 = p.rect.x0 - mb.x, cy0 = p.rect.y0 - mb.y;
      const cx1 = p.rect.x1 - mb.x, cy1 = p.rect.y1 - mb.y;
      const corners = [[cx0, cy0], [cx1, cy0], [cx1, cy1], [cx0, cy1]].map(([x, y]) => rotatePt(x, y, phi));
      const minX = Math.min(...corners.map((c) => c[0]));
      const minY = Math.min(...corners.map((c) => c[1]));

      page.pushOperators(pushGraphicsState(), rectangle(bx, by, size.w, size.h), clip(), endPath());
      page.drawPage(emb, { x: bx - minX, y: by - minY, xScale: 1, yScale: 1, rotate: degrees(phi) });
      page.pushOperators(popGraphicsState());
    }
  }
  return out.save();
}

window.Core = { PT_PER_MM, A4_MM, A4_PT, sheetSizeMm, pieceSizePt, pieceSizeMm, rectOf, findFreeSpot, overlapsAny, clampToSheet, snap, rectFromPoints, exportPdf };
})();
