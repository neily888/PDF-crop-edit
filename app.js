(function () {
'use strict';
const {
  PT_PER_MM, sheetSizeMm, pieceSizeMm, findFreeSpot, overlapsAny, clampToSheet,
  snap, rectOf, rectFromPoints, exportPdf,
} = window.Core;

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const $ = (s) => document.querySelector(s);
const norm = (d) => ((d % 360) + 360) % 360;
let idCounter = 0;
const uid = () => 'id' + ++idCounter;

const state = {
  bytes: null, name: 'document', pdf: null, numPages: 0,
  pageNum: 1, zoom: 1, tool: 'select', sel: null, // sel: crop rect in PDF user space
  view: 'crop',
  sheets: [], currentSheet: null, pieces: [], selected: null,
  snap: true, sheetZoom: 1, pxPerMm: 1,
};

// ---------- small helpers ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1);
const curSheet = () => state.sheets.find((s) => s.id === state.currentSheet);
const sheetPieces = (id = state.currentSheet) => state.pieces.filter((p) => p.sheet === id);
const dpr = () => Math.min(window.devicePixelRatio || 1, 3);

// ---------- opening files ----------
async function loadFile(file) {
  if (!file) return;
  if (state.pieces.length && !confirm('Open a new PDF? Your current pieces and layout will be discarded.')) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    if (state.pdf) state.pdf.destroy();
    pieceBitmaps.clear();
    const first = { id: uid(), landscape: false };
    Object.assign(state, {
      bytes, pdf, numPages: pdf.numPages, name: file.name.replace(/\.pdf$/i, '') || 'document',
      pageNum: 1, zoom: 1, sel: null, pieces: [], selected: null,
      sheets: [first], currentSheet: first.id, sheetZoom: 1,
    });
    $('#empty').hidden = true;
    for (const b of ['btnPrint', 'btnDownload']) $('#' + b).disabled = false;
    document.querySelectorAll('.tab').forEach((t) => (t.disabled = false));
    $('#pageTotal').textContent = state.numPages;
    $('#pageInput').max = state.numPages;
    setView('crop');
  } catch (err) {
    console.error(err);
    const pw = err && err.name === 'PasswordException';
    toast(pw ? 'That PDF is password protected. Remove the password first.' : 'Could not open that PDF.');
  }
}

$('#btnOpen').onclick = () => $('#file').click();
$('#dropzone').onclick = () => $('#file').click();
$('#dropzone').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } };
$('#file').onchange = (e) => { loadFile(e.target.files[0]); e.target.value = ''; };
window.addEventListener('dragover', (e) => { e.preventDefault(); $('#dropzone').classList.add('over'); });
window.addEventListener('dragleave', () => $('#dropzone').classList.remove('over'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  $('#dropzone').classList.remove('over');
  const f = [...(e.dataTransfer?.files || [])].find((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
  if (f) loadFile(f); else if (e.dataTransfer?.files?.length) toast('Please drop a PDF file.');
});

// ---------- views ----------
function setView(v) {
  state.view = v;
  $('#cropView').hidden = v !== 'crop';
  $('#sheetView').hidden = v !== 'sheet';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  if (v === 'crop') renderCrop(); else renderSheet();
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => state.pdf && setView(t.dataset.view)));

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.pdf && (state.view === 'crop' ? renderCrop() : renderSheet()), 150);
});

// =====================================================================
// CROP VIEW
// =====================================================================
const cropStage = $('#cropStage');
const pageWrap = $('#pageWrap');
const pageCanvas = $('#pageCanvas');
const overlay = $('#overlay');
const selBox = $('#selBox');
const crop = { token: 0, task: null, vp: null, page: null };

async function renderCrop() {
  if (!state.pdf) return;
  const token = ++crop.token;
  if (crop.task) {
    crop.task.cancel();
    try { await crop.task.promise; } catch { /* cancelled */ }
    crop.task = null;
  }
  const page = await state.pdf.getPage(state.pageNum);
  if (token !== crop.token) return;
  const base = page.getViewport({ scale: 1 });
  const avail = Math.max(220, cropStage.clientWidth - 24);
  const scale = (avail / base.width) * state.zoom;
  const vp = page.getViewport({ scale });
  let d = dpr();
  while (vp.width * vp.height * d * d > 24e6 && d > 1) d -= 0.5;
  const rvp = page.getViewport({ scale: scale * d });
  pageCanvas.width = Math.floor(rvp.width);
  pageCanvas.height = Math.floor(rvp.height);
  for (const el of [pageCanvas, pageWrap]) {
    el.style.width = vp.width + 'px';
    el.style.height = vp.height + 'px';
  }
  crop.vp = vp;
  crop.page = page;
  $('#pageInput').value = state.pageNum;
  $('#prevPage').disabled = state.pageNum <= 1;
  $('#nextPage').disabled = state.pageNum >= state.numPages;
  drawOverlay();
  const task = page.render({ canvasContext: pageCanvas.getContext('2d'), viewport: rvp });
  crop.task = task;
  try { await task.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') console.error(e); }
}

// PDF user space <-> CSS pixel conversions for the current page view
function pdfRectToCss(r) {
  const [ax, ay] = crop.vp.convertToViewportPoint(r.x0, r.y0);
  const [bx, by] = crop.vp.convertToViewportPoint(r.x1, r.y1);
  return { l: Math.min(ax, bx), t: Math.min(ay, by), r: Math.max(ax, bx), b: Math.max(ay, by) };
}
function cssToPdfRect(c) {
  const a = crop.vp.convertToPdfPoint(c.l, c.t);
  const b = crop.vp.convertToPdfPoint(c.r, c.b);
  return rectFromPoints(a, b);
}

function drawOverlay() {
  if (!crop.vp) return;
  // outlines of crops already added from this page
  const ghosts = $('#ghosts');
  ghosts.innerHTML = '';
  state.pieces.filter((p) => p.page === state.pageNum - 1).forEach((p) => {
    const c = pdfRectToCss(p.rect);
    const g = document.createElement('div');
    g.className = 'ghost';
    const n = state.sheets.findIndex((s) => s.id === p.sheet) + 1;
    g.style.cssText = `left:${c.l}px;top:${c.t}px;width:${c.r - c.l}px;height:${c.b - c.t}px`;
    g.innerHTML = `<span>Sheet ${n}</span>`;
    ghosts.appendChild(g);
  });
  updateSelUI();
}

function updateSelUI() {
  if (!state.sel || !crop.vp) {
    selBox.hidden = true;
    $('#addPiece').disabled = true;
    $('#selInfo').textContent = 'Drag on the page to choose the area you want to keep.';
    return;
  }
  const c = pdfRectToCss(state.sel);
  selBox.hidden = false;
  selBox.style.cssText = `left:${c.l}px;top:${c.t}px;width:${c.r - c.l}px;height:${c.b - c.t}px`;
  selBox.classList.toggle('top', c.t < 34);
  const wMm = (c.r - c.l) / crop.vp.scale / PT_PER_MM;
  const hMm = (c.b - c.t) / crop.vp.scale / PT_PER_MM;
  $('#selLabel').textContent = `${fmt(wMm)} × ${fmt(hMm)} mm`;
  $('#selInfo').textContent = `Keeping ${fmt(wMm)} × ${fmt(hMm)} mm`;
  $('#addPiece').disabled = false;
}

// drag logic (mouse, pen and touch via pointer events)
let drag = null;
const MIN = 6;
overlay.addEventListener('pointerdown', (e) => {
  if (state.tool !== 'select' || !crop.vp) return;
  const box = overlay.getBoundingClientRect();
  const px = e.clientX - box.left, py = e.clientY - box.top;
  const cur = state.sel ? pdfRectToCss(state.sel) : null;
  const h = e.target.dataset && e.target.dataset.h;
  if (h && cur) drag = { mode: h, px, py, orig: cur };
  else if (cur && e.target.closest('#selBox')) drag = { mode: 'move', px, py, orig: cur };
  else drag = { mode: 'new', px, py, moved: false };
  overlay.setPointerCapture(e.pointerId);
  e.preventDefault();
});
overlay.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const box = overlay.getBoundingClientRect();
  const W = box.width, H = box.height;
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const px = cl(e.clientX - box.left, 0, W), py = cl(e.clientY - box.top, 0, H);
  let c;
  if (drag.mode === 'new') {
    c = { l: Math.min(drag.px, px), t: Math.min(drag.py, py), r: Math.max(drag.px, px), b: Math.max(drag.py, py) };
    if (c.r - c.l < 3 || c.b - c.t < 3) return;
    drag.moved = true;
  } else if (drag.mode === 'move') {
    const o = drag.orig, w = o.r - o.l, h = o.b - o.t;
    const l = cl(o.l + (e.clientX - box.left - drag.px), 0, W - w);
    const t = cl(o.t + (e.clientY - box.top - drag.py), 0, H - h);
    c = { l, t, r: l + w, b: t + h };
  } else {
    c = { ...drag.orig };
    if (drag.mode.includes('w')) c.l = Math.min(px, c.r - MIN);
    if (drag.mode.includes('e')) c.r = Math.max(px, c.l + MIN);
    if (drag.mode.includes('n')) c.t = Math.min(py, c.b - MIN);
    if (drag.mode.includes('s')) c.b = Math.max(py, c.t + MIN);
  }
  state.sel = cssToPdfRect(c);
  updateSelUI();
});
const endDrag = () => {
  if (drag && drag.mode === 'new' && !drag.moved) { state.sel = null; updateSelUI(); }
  drag = null;
};
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

// toolbar
$('#prevPage').onclick = () => goPage(state.pageNum - 1);
$('#nextPage').onclick = () => goPage(state.pageNum + 1);
$('#pageInput').onchange = (e) => goPage(parseInt(e.target.value, 10) || state.pageNum);
function goPage(n) {
  n = Math.max(1, Math.min(state.numPages, n));
  if (n !== state.pageNum || $('#pageInput').value != n) { state.pageNum = n; renderCrop(); }
}
function setTool(t) {
  state.tool = t;
  $('#toolSelect').classList.toggle('on', t === 'select');
  $('#toolPan').classList.toggle('on', t === 'pan');
  cropStage.classList.toggle('pan', t === 'pan');
}
$('#toolSelect').onclick = () => setTool('select');
$('#toolPan').onclick = () => setTool('pan');
const zoomCrop = (f) => { state.zoom = f ? Math.max(0.5, Math.min(6, state.zoom * f)) : 1; renderCrop(); };
$('#zoomIn').onclick = () => zoomCrop(1.25);
$('#zoomOut').onclick = () => zoomCrop(0.8);
$('#zoomFit').onclick = () => zoomCrop(0);

$('#addPiece').onclick = addPiece;
function addPiece() {
  if (!state.sel || !crop.page) return;
  const piece = {
    id: uid(), page: state.pageNum - 1, rect: { ...state.sel },
    pageRotate: norm(crop.page.rotate), rot: 0, sheet: state.currentSheet, x: 0, y: 0,
  };
  placeNew(piece);
  state.pieces.push(piece);
  state.selected = piece.id;
  const n = state.sheets.findIndex((s) => s.id === piece.sheet) + 1;
  const count = sheetPieces(piece.sheet).length;
  toast(`Added to Sheet ${n} (${count} piece${count === 1 ? '' : 's'}). Switch to “Sheet” to arrange.`);
  drawOverlay();
}

function placeNew(piece) {
  const sh = sheetSizeMm(state.sheets.find((s) => s.id === piece.sheet));
  const size = pieceSizeMm(piece);
  const others = sheetPieces(piece.sheet);
  const spot = findFreeSpot(sh, others, size.w, size.h);
  if (spot) { piece.x = spot.x; piece.y = spot.y; }
  else { piece.x = (others.length * 6) % 40; piece.y = (others.length * 6) % 40; }
  clampToSheet(piece, sh);
}

// =====================================================================
// SHEET VIEW
// =====================================================================
const sheetStage = $('#sheetStage');
const sheetEl = $('#sheet');

// Cache of rendered piece bitmaps, shared by copies of the same crop
const pieceBitmaps = new Map();
let bitmapScaleKey = '';
let renderChain = Promise.resolve();

function pieceKey(p, ppp) {
  const r = p.rect;
  return [p.page, r.x0, r.y0, r.x1, r.y1, norm(p.pageRotate + p.rot), ppp.toFixed(3)].join('|');
}

function getPieceBitmap(p, pxPerMm) {
  const ppp = (pxPerMm * dpr()) / PT_PER_MM; // device px per PDF point
  const scaleKey = ppp.toFixed(3);
  if (scaleKey !== bitmapScaleKey) { pieceBitmaps.clear(); bitmapScaleKey = scaleKey; }
  const key = pieceKey(p, ppp);
  if (!pieceBitmaps.has(key)) {
    const job = renderChain.then(async () => {
      const page = await state.pdf.getPage(p.page + 1);
      const vp = page.getViewport({ scale: ppp, rotation: norm(p.pageRotate + p.rot) });
      const [ax, ay, bx, by] = vp.convertToViewportRectangle([p.rect.x0, p.rect.y0, p.rect.x1, p.rect.y1]);
      const minX = Math.min(ax, bx), minY = Math.min(ay, by);
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.ceil(Math.abs(bx - ax)));
      cv.height = Math.max(1, Math.ceil(Math.abs(by - ay)));
      await page.render({
        canvasContext: cv.getContext('2d'), viewport: vp, transform: [1, 0, 0, 1, -minX, -minY],
        background: 'rgb(255,255,255)',
      }).promise;
      return cv;
    });
    renderChain = job.catch(() => {});
    pieceBitmaps.set(key, job);
  }
  return pieceBitmaps.get(key);
}

function renderSheetTabs() {
  const tabs = $('#sheetTabs');
  tabs.innerHTML = '';
  state.sheets.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'btn sheettab' + (s.id === state.currentSheet ? ' on' : '');
    b.textContent = `Sheet ${i + 1}`;
    b.onclick = () => { state.currentSheet = s.id; state.selected = null; renderSheet(); };
    tabs.appendChild(b);
  });
  const add = document.createElement('button');
  add.className = 'btn icon'; add.textContent = '+'; add.title = 'Add another A4 sheet'; add.setAttribute('aria-label', 'Add sheet');
  add.onclick = () => {
    const s = { id: uid(), landscape: false };
    state.sheets.push(s); state.currentSheet = s.id; state.selected = null; renderSheet();
  };
  tabs.appendChild(add);
  if (state.sheets.length > 1) {
    const del = document.createElement('button');
    del.className = 'btn danger'; del.textContent = 'Remove sheet';
    del.onclick = removeSheet;
    tabs.appendChild(del);
  }
}

function removeSheet() {
  const n = sheetPieces().length;
  if (n && !confirm(`Remove this sheet and its ${n} piece${n === 1 ? '' : 's'}?`)) return;
  const i = state.sheets.findIndex((s) => s.id === state.currentSheet);
  state.pieces = state.pieces.filter((p) => p.sheet !== state.currentSheet);
  state.sheets.splice(i, 1);
  state.currentSheet = state.sheets[Math.max(0, i - 1)].id;
  state.selected = null;
  renderSheet();
}

function renderSheet() {
  if (!state.pdf) return;
  renderSheetTabs();
  const sh = curSheet();
  const mm = sheetSizeMm(sh);
  $('#orient').textContent = sh.landscape ? 'Landscape' : 'Portrait';
  const fit = Math.min((sheetStage.clientWidth - 28) / mm.w, (sheetStage.clientHeight - 28) / mm.h);
  state.pxPerMm = Math.max(0.4, fit) * state.sheetZoom;
  sheetEl.style.width = mm.w * state.pxPerMm + 'px';
  sheetEl.style.height = mm.h * state.pxPerMm + 'px';
  sheetEl.querySelectorAll('.piece').forEach((el) => el.remove());
  const mine = sheetPieces();
  $('#sheetEmpty').hidden = mine.length > 0;
  mine.forEach(buildPieceEl);
  refreshFlags();
  updatePieceInfo();
}

function buildPieceEl(p) {
  const z = state.pxPerMm;
  const size = pieceSizeMm(p);
  const el = document.createElement('div');
  el.className = 'piece';
  el.dataset.id = p.id;
  el.style.width = size.w * z + 'px';
  el.style.height = size.h * z + 'px';
  el.style.left = p.x * z + 'px';
  el.style.top = p.y * z + 'px';
  const cv = document.createElement('canvas');
  el.appendChild(cv);
  sheetEl.appendChild(el);
  getPieceBitmap(p, z).then((bmp) => {
    if (!el.isConnected) return;
    cv.width = bmp.width; cv.height = bmp.height;
    cv.getContext('2d').drawImage(bmp, 0, 0);
  }).catch((e) => console.error(e));
}

function refreshFlags() {
  const mine = sheetPieces();
  const mm = sheetSizeMm(curSheet());
  sheetEl.querySelectorAll('.piece').forEach((el) => {
    const p = state.pieces.find((x) => x.id === el.dataset.id);
    if (!p) return;
    el.classList.toggle('sel', p.id === state.selected);
    el.classList.toggle('overlap', overlapsAny(p, mine));
  });
  $('#dupPiece').disabled = $('#delPiece').disabled = !state.selected;
}

function updatePieceInfo() {
  const p = state.pieces.find((x) => x.id === state.selected);
  const info = $('#pieceInfo');
  if (!p) { info.textContent = 'Drag pieces to position them. Tap a piece to select it.'; return; }
  const s = pieceSizeMm(p);
  const mm = sheetSizeMm(curSheet());
  let t = `${fmt(s.w)} × ${fmt(s.h)} mm at (${fmt(p.x)}, ${fmt(p.y)})`;
  if (s.w > mm.w + 0.1 || s.h > mm.h + 0.1) t += ' — larger than the sheet, edges will be clipped';
  else if (overlapsAny(p, sheetPieces())) t += ' — overlaps another piece';
  info.textContent = t;
}

function select(id) {
  state.selected = id;
  refreshFlags();
  updatePieceInfo();
}

// dragging pieces
let pd = null;
sheetEl.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.piece');
  if (!el) { select(null); return; }
  const p = state.pieces.find((x) => x.id === el.dataset.id);
  select(p.id);
  pd = {
    p, el, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, size: pieceSizeMm(p),
    others: sheetPieces().filter((o) => o !== p).map(rectOf),
  };
  el.classList.add('dragging');
  el.setPointerCapture(e.pointerId);
  e.preventDefault();
});
sheetEl.addEventListener('pointermove', (e) => {
  if (!pd) return;
  const z = state.pxPerMm, mm = sheetSizeMm(curSheet());
  let x = pd.ox + (e.clientX - pd.sx) / z;
  let y = pd.oy + (e.clientY - pd.sy) / z;
  const gx = $('#guideX'), gy = $('#guideY');
  gx.hidden = gy.hidden = true;
  if (state.snap && !e.altKey) {
    const s = snap({ x, y, w: pd.size.w, h: pd.size.h }, pd.others, mm, 8 / z);
    x = s.x; y = s.y;
    for (const g of s.guides) {
      const el = g.axis === 'x' ? gx : gy;
      el.style[g.axis === 'x' ? 'left' : 'top'] = g.at * z + 'px';
      el.hidden = false;
    }
  }
  x = Math.max(0, Math.min(x, Math.max(0, mm.w - pd.size.w)));
  y = Math.max(0, Math.min(y, Math.max(0, mm.h - pd.size.h)));
  pd.p.x = x; pd.p.y = y;
  pd.el.style.left = x * z + 'px';
  pd.el.style.top = y * z + 'px';
  updatePieceInfo();
});
const endPieceDrag = () => {
  if (!pd) return;
  pd.el.classList.remove('dragging');
  $('#guideX').hidden = $('#guideY').hidden = true;
  pd = null;
  refreshFlags();
  updatePieceInfo();
};
sheetEl.addEventListener('pointerup', endPieceDrag);
sheetEl.addEventListener('pointercancel', endPieceDrag);

// actions
function duplicateSelected() {
  const src = state.pieces.find((x) => x.id === state.selected);
  if (!src) return;
  const copy = { ...src, rect: { ...src.rect }, id: uid() };
  const size = pieceSizeMm(src);
  const sh = sheetSizeMm(curSheet());
  const spot = findFreeSpot(sh, sheetPieces(), size.w, size.h);
  if (spot) { copy.x = spot.x; copy.y = spot.y; }
  else { copy.x = src.x + 5; copy.y = src.y + 5; clampToSheet(copy, sh); toast('No free space left on this sheet, so the copy overlaps another piece.'); }
  state.pieces.push(copy);
  state.selected = copy.id;
  renderSheet();
}
function deleteSelected() {
  if (!state.selected) return;
  state.pieces = state.pieces.filter((p) => p.id !== state.selected);
  state.selected = null;
  renderSheet();
}
$('#dupPiece').onclick = duplicateSelected;
$('#delPiece').onclick = deleteSelected;
$('#orient').onclick = () => {
  const sh = curSheet();
  sh.landscape = !sh.landscape;
  const mm = sheetSizeMm(sh);
  sheetPieces().forEach((p) => clampToSheet(p, mm));
  renderSheet();
};
$('#snapToggle').onclick = () => {
  state.snap = !state.snap;
  $('#snapToggle').classList.toggle('on', state.snap);
};
const zoomSheet = (f) => { state.sheetZoom = f ? Math.max(0.5, Math.min(5, state.sheetZoom * f)) : 1; renderSheet(); };
$('#sZoomIn').onclick = () => zoomSheet(1.25);
$('#sZoomOut').onclick = () => zoomSheet(0.8);
$('#sZoomFit').onclick = () => zoomSheet(0);

// keyboard (desktop)
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (state.view === 'sheet' && state.selected) {
    const p = state.pieces.find((x) => x.id === state.selected);
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
    const step = e.shiftKey ? 5 : 0.5;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv && p) {
      e.preventDefault();
      p.x += mv[0]; p.y += mv[1];
      clampToSheet(p, sheetSizeMm(curSheet()));
      const el = sheetEl.querySelector(`[data-id="${p.id}"]`);
      el.style.left = p.x * state.pxPerMm + 'px'; el.style.top = p.y * state.pxPerMm + 'px';
      refreshFlags(); updatePieceInfo();
    }
  } else if (state.view === 'crop') {
    if (e.key === 'Escape') { state.sel = null; updateSelUI(); }
    if (e.key === 'Enter' && state.sel) addPiece();
    if (e.key === 'ArrowRight') goPage(state.pageNum + 1);
    if (e.key === 'ArrowLeft') goPage(state.pageNum - 1);
  }
});

// =====================================================================
// EXPORT
// =====================================================================
async function buildPdf() {
  const used = state.sheets.filter((s) => state.pieces.some((p) => p.sheet === s.id));
  if (!used.length) { toast('Add at least one piece to a sheet first.'); return null; }
  const bytes = await exportPdf(window.PDFLib, state.bytes.slice(), used, state.pieces);
  return new Blob([bytes], { type: 'application/pdf' });
}

async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  try { await fn(); } catch (e) { console.error(e); toast('Export failed: ' + (e.message || e)); }
  btn.disabled = false; btn.textContent = old;
}

$('#btnDownload').onclick = () => withBusy($('#btnDownload'), 'Building…', async () => {
  const blob = await buildPdf();
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${state.name}-cropped.pdf`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});

$('#btnPrint').onclick = () => withBusy($('#btnPrint'), 'Building…', async () => {
  // open the tab synchronously so pop-up blockers allow it, then point it at the PDF
  const w = window.open('', '_blank');
  const blob = await buildPdf();
  if (!blob) { w && w.close(); return; }
  const url = URL.createObjectURL(blob);
  if (w) w.location.href = url; else location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60000);
});

// =====================================================================
// PWA
// =====================================================================
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}

})();
