// Havaintokartta – kuntotutkimuksen kenttätyökalu
// pdf.js (ESM, lazy) + jsPDF (UMD, window.jspdf)

let pdfjsLib = null;
async function getPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('./vendor/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjsLib;
}
function getJsPDF() {
  if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('jsPDF-kirjasto ei latautunut (tarkista vendor/jspdf.umd.min.js).');
  return window.jspdf.jsPDF;
}

/* ---------------- IndexedDB ---------------- */
const DB_NAME = 'havaintokartta';
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('sites')) d.createObjectStore('sites', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('plans')) {
        const s = d.createObjectStore('plans', { keyPath: 'id' });
        s.createIndex('siteId', 'siteId', { unique: false });
      }
      if (!d.objectStoreNames.contains('markers')) {
        const m = d.createObjectStore('markers', { keyPath: 'id' });
        m.createIndex('siteId', 'siteId', { unique: false });
        m.createIndex('planId', 'planId', { unique: false });
      }
    };
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode = 'readonly') { return db.transaction(store, mode).objectStore(store); }
function reqP(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }
const dbGet = (s, k) => reqP(tx(s).get(k));
const dbAll = (s) => reqP(tx(s).getAll());
const dbPut = (s, v) => reqP(tx(s, 'readwrite').put(v));
const dbDel = (s, k) => reqP(tx(s, 'readwrite').delete(k));
function dbByIndex(store, index, val) {
  return reqP(tx(store).index(index).getAll(IDBKeyRange.only(val)));
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------------- Default categories ---------------- */
const DEFAULT_CATS = [
  { key: 'H',   prefix: 'H',   label: 'Havainto',                    color: '#E4572E' },
  { key: 'VM',  prefix: 'VM',  label: 'Viiltokosteusmittaus',         color: '#1E88E5' },
  { key: 'PR',  prefix: 'PR',  label: 'Porareikäkosteusmittaus',      color: '#8E44AD' },
  { key: 'LOG', prefix: 'LOG', label: 'Logger / olosuhdemittaus',     color: '#00897B' },
  { key: 'MN',  prefix: 'MN',  label: 'Materiaali-/mikrobinäyte',     color: '#C0392B' },
  { key: 'PK',  prefix: 'PK',  label: 'Pintakosteuskartoitus',        color: '#00ACC1' },
  { key: 'MA',  prefix: 'MA',  label: 'Merkkiainekoe / tiiveys',      color: '#F9A825' },
  { key: 'RA',  prefix: 'RA',  label: 'Rakenneavaus',                 color: '#546E7A' },
  { key: 'HA',  prefix: 'HA',  label: 'Haitta-aine-/asbestinäyte',    color: '#5E35B1' },
  { key: 'K',   prefix: 'K',   label: 'Valokuvapiste',                color: '#43A047' },
];

/* ---------------- App state ---------------- */
const S = {
  cats: [],
  siteId: null,
  site: null,
  plans: [],
  planId: null,
  markers: [],          // markers for current site
  imgUrl: null,         // object URL of current plan image
  view: { x: 0, y: 0, scale: 1 },
  editId: null,         // marker being edited
  pickCat: null,        // selected category in sheet
  pendingPos: null,     // {x,y} fraction for new marker
  moveMode: false,
};

/* ---------------- DOM refs ---------------- */
const $ = (id) => document.getElementById(id);
const stage = $('stage'), world = $('world'), planImg = $('planImg'),
  markerLayer = $('markerLayer'), crosshair = $('crosshair'),
  emptyState = $('emptyState'), planbar = $('planbar'), sheetBg = $('sheetBg');

/* ---------------- Sheets ---------------- */
const SHEETS = ['markerSheet', 'listSheet', 'sitesSheet', 'catsSheet', 'helpSheet'];
function openSheet(id) {
  closeSheets(false);
  sheetBg.classList.add('open');
  $(id).classList.add('open');
}
function closeSheets() {
  sheetBg.classList.remove('open');
  SHEETS.forEach((s) => $(s).classList.remove('open'));
  hideCrosshair();
  S.moveMode = false;
}
sheetBg.addEventListener('click', closeSheets);

function showProgress(msg) { $('progressMsg').textContent = msg || 'Käsitellään…'; $('progress').classList.add('open'); }
function hideProgress() { $('progress').classList.remove('open'); }

/* ---------------- Modal (korvaa prompt/confirm/alert) ---------------- */
const modalBg = $('modalBg');
let modalOkHandler = null, modalCancelHandler = null;
$('modalOk').onclick = () => { if (modalOkHandler) modalOkHandler(); };
$('modalCancel').onclick = () => { if (modalCancelHandler) modalCancelHandler(); };
modalBg.addEventListener('click', (e) => { if (e.target === modalBg && modalCancelHandler) modalCancelHandler(); });

function askFields(title, fields, okLabel = 'Tallenna') {
  return new Promise((res) => {
    $('modalTitle').textContent = title;
    $('modalMsg').classList.add('hidden');
    const wrap = $('modalFields'); wrap.innerHTML = '';
    const inputs = {};
    fields.forEach((f) => {
      const lab = document.createElement('label'); lab.className = 'fld'; lab.textContent = f.label; wrap.appendChild(lab);
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = f.value || ''; if (f.placeholder) inp.placeholder = f.placeholder;
      inp.autocomplete = 'off'; wrap.appendChild(inp); inputs[f.key] = inp;
    });
    $('modalCancel').classList.remove('hidden'); $('modalCancel').textContent = 'Peruuta';
    $('modalOk').textContent = okLabel; $('modalOk').className = 'btn btn-primary'; $('modalOk').style.background = ''; $('modalOk').style.color = '';
    modalBg.classList.add('open');
    setTimeout(() => { const f = wrap.querySelector('input'); if (f) f.focus(); }, 60);
    const done = (val) => { modalBg.classList.remove('open'); modalOkHandler = modalCancelHandler = null; res(val); };
    modalOkHandler = () => {
      const out = {}; let ok = true;
      fields.forEach((f) => { const v = inputs[f.key].value.trim(); if (f.required && !v) ok = false; out[f.key] = v; });
      if (!ok) { const f = wrap.querySelector('input'); if (f) f.focus(); return; }
      done(out);
    };
    modalCancelHandler = () => done(null);
  });
}

function askConfirm(message, { okLabel = 'OK', danger = false, title = 'Vahvista' } = {}) {
  return new Promise((res) => {
    $('modalTitle').textContent = title;
    $('modalFields').innerHTML = '';
    const m = $('modalMsg'); m.textContent = message; m.classList.remove('hidden');
    $('modalCancel').classList.remove('hidden'); $('modalCancel').textContent = 'Peruuta';
    $('modalOk').textContent = okLabel;
    $('modalOk').className = 'btn btn-primary';
    $('modalOk').style.background = danger ? '#c0392b' : ''; $('modalOk').style.color = danger ? '#fff' : '';
    modalBg.classList.add('open');
    const done = (val) => { modalBg.classList.remove('open'); modalOkHandler = modalCancelHandler = null; $('modalOk').style.background = ''; $('modalOk').style.color = ''; res(val); };
    modalOkHandler = () => done(true); modalCancelHandler = () => done(false);
  });
}

function notify(message, title = 'Ilmoitus') {
  return new Promise((res) => {
    $('modalTitle').textContent = title;
    $('modalFields').innerHTML = '';
    const m = $('modalMsg'); m.textContent = message; m.classList.remove('hidden');
    $('modalCancel').classList.add('hidden');
    $('modalOk').textContent = 'OK'; $('modalOk').className = 'btn btn-primary'; $('modalOk').style.background = ''; $('modalOk').style.color = '';
    modalBg.classList.add('open');
    const done = () => { modalBg.classList.remove('open'); modalOkHandler = modalCancelHandler = null; res(); };
    modalOkHandler = done; modalCancelHandler = done;
  });
}

function showError(msg) { $('errmsg').textContent = msg; $('errbar').classList.add('show'); }
$('errClose').onclick = () => $('errbar').classList.remove('show');

/* ---------------- Categories ---------------- */
async function loadCats() {
  const rec = await dbGet('meta', 'categories');
  if (rec && rec.value && rec.value.length) S.cats = rec.value;
  else { S.cats = DEFAULT_CATS.map((c) => ({ ...c })); await saveCats(); }
}
function saveCats() { return dbPut('meta', { key: 'categories', value: S.cats }); }
function catByKey(k) { return S.cats.find((c) => c.key === k) || { prefix: '?', color: '#888', label: 'Tuntematon' }; }

/* ---------------- Site / plan loading ---------------- */
async function refreshSites() { return dbAll('sites'); }

async function loadSite(siteId) {
  S.siteId = siteId;
  S.site = await dbGet('sites', siteId);
  S.plans = (await dbByIndex('plans', 'siteId', siteId)).sort((a, b) => a.order - b.order);
  S.markers = await dbByIndex('markers', 'siteId', siteId);
  if (S.site) await dbPut('meta', { key: 'lastSite', value: siteId });
  $('siteName').textContent = S.site ? S.site.name : '—';
  renderPlanbar();
  if (S.plans.length) selectPlan(S.plans[0].id);
  else { S.planId = null; setPlanImage(null); }
  updateEmptyState();
  updateListCount();
}

function updateEmptyState() {
  if (!S.site) {
    emptyState.classList.remove('hidden');
    $('emptyTitle').textContent = 'Ei kohdetta';
    $('emptyMsg').textContent = 'Aloita luomalla kohde ja tuomalla pohjakuvat (PDF).';
    $('emptyAction').textContent = '+ Uusi kohde';
    emptyState.dataset.action = 'newsite';
  } else if (!S.plans.length) {
    emptyState.classList.remove('hidden');
    $('emptyTitle').textContent = 'Ei pohjakuvia';
    $('emptyMsg').textContent = 'Tuo kohteen pohjakuvat PDF-tiedostona.';
    $('emptyAction').textContent = '+ Tuo pohjat';
    emptyState.dataset.action = 'import';
  } else {
    emptyState.classList.add('hidden');
  }
}
$('emptyAction').addEventListener('click', () => {
  if (emptyState.dataset.action === 'newsite') createSite();
  else triggerImport();
});

/* ---------------- Planbar ---------------- */
function renderPlanbar() {
  planbar.innerHTML = '';
  if (!S.site) return;
  S.plans.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'plantab' + (p.id === S.planId ? ' active' : '');
    b.textContent = p.name;
    b.onclick = () => selectPlan(p.id);
    planbar.appendChild(b);
  });
  const add = document.createElement('button');
  add.className = 'plantab add';
  add.textContent = '+ Pohja';
  add.onclick = triggerImport;
  planbar.appendChild(add);
}

async function selectPlan(planId) {
  S.planId = planId;
  const p = S.plans.find((x) => x.id === planId);
  renderPlanbar();
  if (!p) { setPlanImage(null); return; }
  setPlanImage(p.image); // Blob
}

function setPlanImage(blob) {
  if (S.imgUrl) { URL.revokeObjectURL(S.imgUrl); S.imgUrl = null; }
  if (!blob) { planImg.removeAttribute('src'); markerLayer.innerHTML = ''; return; }
  S.imgUrl = URL.createObjectURL(blob);
  planImg.onload = () => { resetView(); renderMarkers(); };
  planImg.src = S.imgUrl;
}

/* ---------------- View transform (pan/zoom) ---------------- */
function applyView() {
  const v = S.view;
  world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.scale})`;
}
function resetView() {
  // fit width
  const vpW = stage.clientWidth;
  const natW = planImg.naturalWidth || 1;
  // base CSS width is 100% of stage; scale 1 fits width. Center vertically if shorter.
  S.view = { x: 0, y: 0, scale: 1 };
  // if image taller than viewport at scale 1, keep top; else center
  applyView();
}
function clampScale(s) { return Math.max(0.4, Math.min(10, s)); }

$('zoomIn').onclick = () => zoomAround(stage.clientWidth / 2, stage.clientHeight / 2, 1.3);
$('zoomOut').onclick = () => zoomAround(stage.clientWidth / 2, stage.clientHeight / 2, 1 / 1.3);
$('zoomFit').onclick = resetView;

function zoomAround(cx, cy, factor) {
  const v = S.view;
  const ns = clampScale(v.scale * factor);
  const k = ns / v.scale;
  v.x = cx - (cx - v.x) * k;
  v.y = cy - (cy - v.y) * k;
  v.scale = ns;
  applyView();
}

/* Pointer handling: pan, pinch, tap */
const pointers = new Map();
let startDist = 0, startScale = 1, startMid = null, panStart = null, downInfo = null;

function stageXY(e) {
  const r = stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

stage.addEventListener('pointerdown', (e) => {
  if (S.moveMode) return; // crosshair drag handled separately
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, stageXY(e));
  if (pointers.size === 1) {
    const p = stageXY(e);
    panStart = { x: S.view.x, y: S.view.y, px: p.x, py: p.y };
    downInfo = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
  } else if (pointers.size === 2) {
    const pts = [...pointers.values()];
    startDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    startScale = S.view.scale;
    startMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    downInfo = null;
  }
});

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, stageXY(e));
  if (pointers.size === 2 && startDist) {
    const pts = [...pointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const ns = clampScale(startScale * (dist / startDist));
    const k = ns / S.view.scale;
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    S.view.x = mid.x - (mid.x - S.view.x) * k;
    S.view.y = mid.y - (mid.y - S.view.y) * k;
    S.view.scale = ns;
    applyView();
  } else if (pointers.size === 1 && panStart) {
    const p = stageXY(e);
    const dx = p.x - panStart.px, dy = p.y - panStart.py;
    if (downInfo && (Math.abs(e.clientX - downInfo.x) > 6 || Math.abs(e.clientY - downInfo.y) > 6)) downInfo.moved = true;
    S.view.x = panStart.x + dx;
    S.view.y = panStart.y + dy;
    applyView();
  }
});

function endPointer(e) {
  if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);
  if (pointers.size < 2) { startDist = 0; }
  if (pointers.size === 0) {
    if (downInfo && !downInfo.moved && (Date.now() - downInfo.t) < 400) {
      handleTap(e.clientX, e.clientY);
    }
    panStart = null; downInfo = null;
  }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

function handleTap(clientX, clientY) {
  if (!S.planId) return;
  // ignore taps on existing markers (they have own handlers) and controls
  const rect = planImg.getBoundingClientRect();
  const fx = (clientX - rect.left) / rect.width;
  const fy = (clientY - rect.top) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
  S.pendingPos = { x: fx, y: fy };
  S.editId = null;
  openMarkerSheet();
  showCrosshairAt(fx, fy);
}

/* ---------------- Crosshair (place / move) ---------------- */
function showCrosshairAt(fx, fy) {
  positionCrosshair(fx, fy);
  crosshair.style.display = 'block';
}
function hideCrosshair() { crosshair.style.display = 'none'; }
function positionCrosshair(fx, fy) {
  const rect = planImg.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  crosshair.style.left = (rect.left - sr.left + fx * rect.width) + 'px';
  crosshair.style.top = (rect.top - sr.top + fy * rect.height) + 'px';
}
// drag crosshair when in move mode
stage.addEventListener('pointermove', (e) => {
  if (!S.moveMode) return;
  const rect = planImg.getBoundingClientRect();
  let fx = (e.clientX - rect.left) / rect.width;
  let fy = (e.clientY - rect.top) / rect.height;
  fx = Math.max(0, Math.min(1, fx)); fy = Math.max(0, Math.min(1, fy));
  S.pendingPos = { x: fx, y: fy };
  positionCrosshair(fx, fy);
});

$('markerMove').addEventListener('click', () => {
  S.moveMode = !S.moveMode;
  $('markerMove').classList.toggle('btn-dark', S.moveMode);
  $('markerMove').textContent = S.moveMode ? '✓ Aseta sormella' : '⊹ Siirrä';
  // collapse sheet a bit by lowering opacity of bg so user can see map
  sheetBg.style.background = S.moveMode ? 'transparent' : 'rgba(20,28,38,.45)';
  $('markerSheet').style.transform = S.moveMode ? 'translateY(62%)' : 'translateY(0)';
});

/* ---------------- Marker sheet ---------------- */
function openMarkerSheet() {
  const editing = !!S.editId;
  $('markerSheetTitle').textContent = editing ? 'Muokkaa merkintää' : 'Uusi merkintä';
  $('markerDeleteWrap').classList.toggle('hidden', !editing);
  sheetBg.style.background = 'rgba(20,28,38,.45)';
  $('markerSheet').style.transform = '';
  $('markerMove').classList.remove('btn-dark');
  $('markerMove').textContent = '⊹ Siirrä';

  let m = null;
  if (editing) m = S.markers.find((x) => x.id === S.editId);
  S.pickCat = m ? m.categoryKey : (S.pickCat || S.cats[0].key);
  if (m) S.pendingPos = { x: m.x, y: m.y };
  $('markerText').value = m ? m.text : '';
  renderCatGrid();
  $('markerMeta').textContent = m ? `${catByKey(m.categoryKey).prefix}${m.number} · luotu ${fmtDate(m.created)}` : '';
  openSheet('markerSheet');
  if (S.pendingPos) showCrosshairAt(S.pendingPos.x, S.pendingPos.y);
}

function renderCatGrid() {
  const g = $('catGrid'); g.innerHTML = '';
  S.cats.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'catpick' + (c.key === S.pickCat ? ' sel' : '');
    b.innerHTML = `<span class="dot" style="background:${c.color}">${c.prefix}</span>${c.label}`;
    b.onclick = () => { S.pickCat = c.key; renderCatGrid(); };
    g.appendChild(b);
  });
}

function nextNumber(catKey) {
  let max = 0;
  S.markers.forEach((m) => { if (m.categoryKey === catKey && m.number > max) max = m.number; });
  return max + 1;
}

$('markerSave').addEventListener('click', async () => {
  if (!S.pendingPos) return;
  const text = $('markerText').value.trim();
  if (S.editId) {
    const m = S.markers.find((x) => x.id === S.editId);
    m.text = text; m.x = S.pendingPos.x; m.y = S.pendingPos.y;
    if (m.categoryKey !== S.pickCat) { m.categoryKey = S.pickCat; m.number = nextNumber(S.pickCat); }
    await dbPut('markers', m);
  } else {
    const m = {
      id: uid(), siteId: S.siteId, planId: S.planId,
      categoryKey: S.pickCat, number: nextNumber(S.pickCat),
      x: S.pendingPos.x, y: S.pendingPos.y, text, created: Date.now(),
    };
    S.markers.push(m);
    await dbPut('markers', m);
  }
  closeSheets();
  renderMarkers(); updateListCount();
});
$('markerCancel').addEventListener('click', closeSheets);
$('markerDelete').addEventListener('click', async () => {
  if (!S.editId) return;
  if (!(await askConfirm('Poistetaanko merkintä? Numerointia ei muuteta automaattisesti.', { okLabel: 'Poista', danger: true, title: 'Poista merkintä' }))) return;
  await dbDel('markers', S.editId);
  S.markers = S.markers.filter((m) => m.id !== S.editId);
  closeSheets(); renderMarkers(); updateListCount();
});

/* ---------------- Render markers on map ---------------- */
function renderMarkers() {
  markerLayer.innerHTML = '';
  if (!S.planId) return;
  S.markers.filter((m) => m.planId === S.planId).forEach((m) => {
    const c = catByKey(m.categoryKey);
    const el = document.createElement('div');
    el.className = 'marker' + (m.id === S.editId ? ' sel' : '');
    el.style.background = c.color;
    el.style.left = (m.x * 100) + '%';
    el.style.top = (m.y * 100) + '%';
    el.textContent = c.prefix + m.number;
    el.onpointerdown = (e) => e.stopPropagation();
    el.onclick = (e) => { e.stopPropagation(); S.editId = m.id; renderMarkers(); openMarkerSheet(); };
    markerLayer.appendChild(el);
  });
}

/* ---------------- Marker list ---------------- */
function updateListCount() { $('listCount').textContent = S.markers.length; }

function groupedMarkers() {
  const groups = [];
  S.cats.forEach((c) => {
    const items = S.markers.filter((m) => m.categoryKey === c.key)
      .sort((a, b) => a.number - b.number);
    if (items.length) groups.push({ cat: c, items });
  });
  return groups;
}

$('fabList').addEventListener('click', () => {
  const cont = $('listContent'); cont.innerHTML = '';
  const groups = groupedMarkers();
  if (!groups.length) { cont.innerHTML = '<p class="muted">Ei merkintöjä vielä.</p>'; }
  groups.forEach((g) => {
    const wrap = document.createElement('div'); wrap.className = 'listgroup';
    wrap.innerHTML = `<div class="ghead"><span class="swatch" style="background:${g.cat.color}"></span>${g.cat.label} (${g.items.length})</div>`;
    g.items.forEach((m) => {
      const plan = S.plans.find((p) => p.id === m.planId);
      const it = document.createElement('div'); it.className = 'item';
      it.innerHTML = `<span class="code" style="background:${g.cat.color}">${g.cat.prefix}${m.number}</span>
        <div class="txt">${escapeHtml(m.text) || '<span class="muted">(ei selitettä)</span>'}
        <span class="date">${plan ? escapeHtml(plan.name) + ' · ' : ''}${fmtDate(m.created)}</span></div>
        <span class="go">›</span>`;
      it.onclick = () => { closeSheets(); jumpToMarker(m); };
      wrap.appendChild(it);
    });
    cont.appendChild(wrap);
  });
  openSheet('listSheet');
});

function jumpToMarker(m) {
  if (m.planId !== S.planId) selectPlan(m.planId);
  // wait a frame for image
  setTimeout(() => {
    S.editId = m.id; renderMarkers();
    // center marker
    const rect = planImg.getBoundingClientRect();
    // bring scale to ~2 and center
    const targetScale = Math.max(S.view.scale, 2);
    S.view.scale = clampScale(targetScale);
    applyView();
    // recompute after scale
    requestAnimationFrame(() => {
      const r2 = planImg.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      const mx = (r2.left - sr.left) + m.x * r2.width;
      const my = (r2.top - sr.top) + m.y * r2.height;
      S.view.x += (stage.clientWidth / 2 - mx);
      S.view.y += (stage.clientHeight / 2 - my);
      applyView();
      openMarkerSheet();
    });
  }, m.planId !== S.planId ? 250 : 0);
}

/* ---------------- Sites ---------------- */
$('btnSites').addEventListener('click', openSites);
async function openSites() {
  const sites = await refreshSites();
  const list = $('sitesList'); list.innerHTML = '';
  if (!sites.length) list.innerHTML = '<p class="muted">Ei kohteita. Luo ensimmäinen.</p>';
  sites.sort((a, b) => b.created - a.created).forEach((s) => {
    const row = document.createElement('div'); row.className = 'catrow';
    row.innerHTML = `<div class="meta"><b>${escapeHtml(s.name)}</b><span>luotu ${fmtDate(s.created)}</span></div>
      <button class="iconbtn" data-act="rename">✎</button>
      <button class="iconbtn" data-act="del">🗑</button>`;
    row.querySelector('.meta').onclick = () => { closeSheets(); loadSite(s.id); };
    row.querySelector('[data-act=rename]').onclick = async (e) => {
      e.stopPropagation();
      const r = await askFields('Nimeä kohde', [{ key: 'name', label: 'Kohteen nimi', value: s.name, required: true }]);
      if (r && r.name) { s.name = r.name; await dbPut('sites', s); openSites(); if (s.id === S.siteId) $('siteName').textContent = s.name; }
    };
    row.querySelector('[data-act=del]').onclick = async (e) => {
      e.stopPropagation();
      if (!(await askConfirm(`Poistetaanko kohde "${s.name}" ja kaikki sen pohjat ja merkinnät? Tätä ei voi perua.`, { okLabel: 'Poista', danger: true, title: 'Poista kohde' }))) return;
      await deleteSite(s.id); openSites();
    };
    list.appendChild(row);
  });
  openSheet('sitesSheet');
}
$('newSiteBtn').addEventListener('click', createSite);
async function createSite() {
  const r = await askFields('Uusi kohde', [{ key: 'name', label: 'Kohteen nimi', placeholder: 'esim. Kämpin päiväkoti, Et. Rautatiekatu 14', required: true }], 'Luo kohde');
  if (!r || !r.name) return;
  const site = { id: uid(), name: r.name, created: Date.now() };
  await dbPut('sites', site);
  closeSheets();
  await loadSite(site.id);
}
async function deleteSite(siteId) {
  const plans = await dbByIndex('plans', 'siteId', siteId);
  for (const p of plans) await dbDel('plans', p.id);
  const ms = await dbByIndex('markers', 'siteId', siteId);
  for (const m of ms) await dbDel('markers', m.id);
  await dbDel('sites', siteId);
  if (S.siteId === siteId) { S.siteId = null; S.site = null; S.plans = []; S.markers = []; S.planId = null; setPlanImage(null); $('siteName').textContent = '—'; renderPlanbar(); updateEmptyState(); updateListCount(); }
}

/* ---------------- Import PDF / images ---------------- */
function triggerImport() {
  if (!S.siteId) { createSite(); return; }
  $('fileInput').value = '';
  $('fileInput').click();
}
$('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files]; if (!files.length) return;
  showProgress('Tuodaan pohjia…');
  try {
    for (const f of files) {
      if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) await importPdf(f);
      else if (f.type.startsWith('image/')) await importImage(f);
    }
    S.plans = (await dbByIndex('plans', 'siteId', S.siteId)).sort((a, b) => a.order - b.order);
    renderPlanbar(); updateEmptyState();
    if (S.plans.length && !S.planId) selectPlan(S.plans[0].id);
  } catch (err) {
    showError('Pohjan tuonti epäonnistui: ' + err.message);
    console.error(err);
  } finally { hideProgress(); }
});

async function planCount() { return (await dbByIndex('plans', 'siteId', S.siteId)).length; }

async function importPdf(file) {
  const pdfjsLib = await getPdfjs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const base = file.name.replace(/\.pdf$/i, '');
  for (let i = 1; i <= pdf.numPages; i++) {
    $('progressMsg').textContent = `Renderöidään ${base} – sivu ${i}/${pdf.numPages}…`;
    const page = await pdf.getPage(i);
    const blob = await renderPageToBlob(page);
    const order = await planCount();
    const name = pdf.numPages > 1 ? `${base} · s.${i}` : base;
    await dbPut('plans', { id: uid(), siteId: S.siteId, name, image: blob, order });
  }
}

async function renderPageToBlob(page) {
  const vp1 = page.getViewport({ scale: 1 });
  const longest = Math.max(vp1.width, vp1.height);
  const target = 2200; // px on longest side – luettava + kohtuukokoinen
  const scale = Math.min(4, target / longest);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
}

async function importImage(file) {
  // re-encode to bounded jpeg
  const url = URL.createObjectURL(file);
  const img = await loadImg(url);
  URL.revokeObjectURL(url);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = Math.min(1, 2200 / longest);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  const order = await planCount();
  await dbPut('plans', { id: uid(), siteId: S.siteId, name: file.name.replace(/\.[^.]+$/, ''), image: blob, order });
}
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }

/* ---------------- Categories management ---------------- */
$('btnCats').addEventListener('click', openCats);
function openCats() {
  const list = $('catsList'); list.innerHTML = '';
  S.cats.forEach((c, idx) => {
    const used = S.markers.some((m) => m.categoryKey === c.key);
    const row = document.createElement('div'); row.className = 'catrow';
    row.innerHTML = `
      <span class="dot" style="background:${c.color}">${c.prefix}</span>
      <div class="meta"><b>${escapeHtml(c.label)}</b><span>etuliite ${escapeHtml(c.prefix)}${used ? ' · käytössä' : ''}</span></div>
      <input type="color" value="${c.color}" />
      <button class="iconbtn" data-act="edit">✎</button>
      <button class="iconbtn" data-act="del">🗑</button>`;
    row.querySelector('input[type=color]').onchange = async (e) => { c.color = e.target.value; await saveCats(); renderMarkers(); };
    row.querySelector('[data-act=edit]').onclick = async () => {
      const r = await askFields('Muokkaa kategoriaa', [
        { key: 'label', label: 'Nimi', value: c.label, required: true },
        { key: 'prefix', label: 'Etuliite (esim. H, VM)', value: c.prefix, required: true },
      ]);
      if (!r) return;
      c.label = r.label || c.label; c.prefix = (r.prefix || c.prefix).toUpperCase();
      await saveCats(); openCats(); renderMarkers();
    };
    row.querySelector('[data-act=del]').onclick = async () => {
      if (used) { await notify('Kategoria on käytössä – poista ensin sen merkinnät.'); return; }
      if (!(await askConfirm(`Poistetaanko kategoria "${c.label}"?`, { okLabel: 'Poista', danger: true, title: 'Poista kategoria' }))) return;
      S.cats.splice(idx, 1); await saveCats(); openCats();
    };
    list.appendChild(row);
  });
  openSheet('catsSheet');
}
$('addCatBtn').addEventListener('click', async () => {
  const r = await askFields('Uusi kategoria', [
    { key: 'label', label: 'Nimi', required: true },
    { key: 'prefix', label: 'Etuliite (esim. IV, MA)', required: true },
  ], 'Lisää');
  if (!r || !r.label || !r.prefix) return;
  const prefix = r.prefix.toUpperCase();
  const key = prefix + '_' + uid().slice(0, 3);
  const palette = ['#D81B60', '#3949AB', '#00838F', '#6D4C41', '#558B2F', '#EF6C00'];
  const color = palette[S.cats.length % palette.length];
  S.cats.push({ key, prefix, label: r.label, color });
  await saveCats(); openCats();
});

/* ---------------- Export PDF ---------------- */
$('btnExport').addEventListener('click', exportPdf);

function blobToDataURL(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); }); }
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

async function exportPdf() {
  if (!S.site) { await notify('Valitse kohde ensin.'); return; }
  if (!S.plans.length) { await notify('Ei pohjakuvia.'); return; }
  showProgress('Luodaan PDF…');
  try {
    const PW = 210, PH = 297, M = 12;
    const today = fmtDate(Date.now());

    // preload plan images + aspect
    const rendered = [];
    for (const plan of S.plans) {
      const dataUrl = await blobToDataURL(plan.image);
      const img = await loadImg(dataUrl);
      rendered.push({ plan, dataUrl, aspect: img.naturalWidth / img.naturalHeight });
    }

    const firstLandscape = rendered[0].aspect > 1;
    const jsPDF = getJsPDF();
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: firstLandscape ? 'landscape' : 'portrait' });

    let first = true;
    for (const { plan, dataUrl, aspect } of rendered) {
      const landscape = aspect > 1;
      if (!first) doc.addPage('a4', landscape ? 'landscape' : 'portrait');
      first = false;
      const pw = landscape ? PH : PW, ph = landscape ? PW : PH;

      // header
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(20, 28, 38);
      doc.text(S.site.name, M, M + 2);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90, 102, 117);
      doc.text(`${plan.name}  ·  Havaintokartta  ·  ${today}`, M, M + 7);

      // image area
      const top = M + 11, availW = pw - 2 * M, availH = ph - top - M;
      let dw = availW, dh = dw / aspect;
      if (dh > availH) { dh = availH; dw = dh * aspect; }
      const ox = M + (availW - dw) / 2, oy = top;
      doc.addImage(dataUrl, 'JPEG', ox, oy, dw, dh);
      doc.setDrawColor(214, 219, 226); doc.rect(ox, oy, dw, dh);

      // markers
      const ms = S.markers.filter((m) => m.planId === plan.id);
      doc.setFont('helvetica', 'bold');
      ms.forEach((m) => {
        const c = catByKey(m.categoryKey);
        const [r, g, b] = hexToRgb(c.color);
        const cxp = ox + m.x * dw, cyp = oy + m.y * dh;
        const label = c.prefix + m.number;
        const rad = 2.6 + Math.min(1.4, label.length * 0.25);
        doc.setFillColor(r, g, b); doc.setDrawColor(255, 255, 255); doc.setLineWidth(0.4);
        doc.circle(cxp, cyp, rad, 'FD');
        doc.setTextColor(255, 255, 255); doc.setFontSize(label.length > 3 ? 5.5 : 7);
        doc.text(label, cxp, cyp + 0.9, { align: 'center' });
      });
      doc.setLineWidth(0.2);
    }

    // ---- Legend pages ----
    doc.addPage('a4', 'portrait');
    let y = M;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(20, 28, 38);
    doc.text(`${S.site.name} – selitteet`, M, y + 2); y += 9;
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(90, 102, 117);
    doc.text(`Havaintokartan merkintöjen selitteet  ·  ${today}`, M, y); y += 8;

    const groups = groupedMarkers();
    const lineH = 5;
    const ensureSpace = (need) => { if (y + need > PH - M) { doc.addPage('a4', 'portrait'); y = M; } };

    if (!groups.length) { doc.setTextColor(90, 102, 117); doc.text('Ei merkintöjä.', M, y); }

    groups.forEach((g) => {
      ensureSpace(12);
      const [r, gg, b] = hexToRgb(g.cat.color);
      // group heading
      doc.setFillColor(r, gg, b); doc.roundedRect(M, y, 4.5, 4.5, 1, 1, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(20, 28, 38);
      doc.text(`${g.cat.label} (${g.items.length})`, M + 7, y + 3.7);
      y += 8;
      doc.setFontSize(9.5);
      g.items.forEach((m) => {
        const plan = S.plans.find((p) => p.id === m.planId);
        const codeW = 16;
        const textW = PW - 2 * M - codeW - 2;
        const txt = (m.text || '(ei selitettä)');
        const meta = (plan ? plan.name + ' · ' : '') + fmtDate(m.created);
        const wrapped = doc.splitTextToSize(txt, textW);
        const blockH = wrapped.length * lineH + 4;
        ensureSpace(blockH);
        // code badge
        doc.setFillColor(r, gg, b); doc.roundedRect(M, y, codeW - 2, 5.2, 1.2, 1.2, 'F');
        doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255); doc.setFontSize(8.5);
        doc.text(g.cat.prefix + m.number, M + (codeW - 2) / 2, y + 3.6, { align: 'center' });
        // text
        doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 38, 48); doc.setFontSize(9.5);
        doc.text(wrapped, M + codeW, y + 3.6);
        // meta line
        const afterText = y + 3.6 + (wrapped.length - 1) * lineH + 4;
        doc.setFontSize(7.2); doc.setTextColor(120, 130, 140);
        doc.text(meta, M + codeW, afterText - 0.5);
        y = afterText + 2.5;
        doc.setDrawColor(225, 229, 234); doc.line(M, y - 1, PW - M, y - 1);
      });
      y += 3;
    });

    // page numbers
    const total = doc.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(150, 158, 168);
      const w = doc.internal.pageSize.getWidth(), h = doc.internal.pageSize.getHeight();
      doc.text(`${i} / ${total}`, w - M, h - 5, { align: 'right' });
      doc.text('Havaintokartta', M, h - 5);
    }

    const fname = `${S.site.name.replace(/[^\wäöåÄÖÅ -]/g, '').trim() || 'kohde'}_havaintokartta_${isoDate()}.pdf`;
    doc.save(fname);
  } catch (err) {
    showError('PDF:n luonti epäonnistui: ' + err.message); console.error(err);
  } finally { hideProgress(); }
}

/* ---------------- Help / storage ---------------- */
$('btnHelp').addEventListener('click', async () => {
  let txt = '';
  try {
    if (navigator.storage && navigator.storage.persisted) {
      const persisted = await navigator.storage.persisted();
      txt = persisted ? 'Tallennustila: pysyvä ✓' : 'Tallennustila: ei vielä merkitty pysyväksi – asenna kotinäkymään.';
      if (navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        if (est.usage != null) txt += `  (käytössä ~${(est.usage / 1048576).toFixed(1)} MB)`;
      }
    }
  } catch (e) {}
  $('storageStatus').textContent = txt;
  openSheet('helpSheet');
});

/* ---------------- Helpers ---------------- */
function fmtDate(ts) { const d = new Date(ts); return d.toLocaleDateString('fi-FI') + ' ' + d.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' }); }
function isoDate() { const d = new Date(); return d.toISOString().slice(0, 10); }
function escapeHtml(s) { return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------------- Boot ---------------- */
async function boot() {
  window.addEventListener('error', (e) => showError('Virhe: ' + (e.message || (e.error && e.error.message) || 'tuntematon')));
  window.addEventListener('unhandledrejection', (e) => showError('Virhe: ' + ((e.reason && e.reason.message) || e.reason || 'tuntematon')));
  await openDB();
  await loadCats();
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (e) {}
  }
  const last = await dbGet('meta', 'lastSite');
  const sites = await refreshSites();
  if (last && sites.find((s) => s.id === last.value)) await loadSite(last.value);
  else if (sites.length) await loadSite(sites.sort((a, b) => b.created - a.created)[0].id);
  else updateEmptyState();
  window.addEventListener('resize', () => { if (S.planId) applyView(); });
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW reg failed', e); }
  }
}
boot().catch((e) => { console.error(e); showError('Käynnistys epäonnistui: ' + e.message); });
