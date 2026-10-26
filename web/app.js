'use strict';

/* Meshkeep - front end.
   Talks to the local Python server; all file access happens there. */

const TOKEN = new URLSearchParams(location.search).get('t') || '';

const state = {
  config: null,
  cwd: null,
  listing: null,
  selection: new Set(),
  meta: null,        // currently open single file
  // staged cover-image change for the open file:
  // null | {action:'set', bitmap, large, small} | {action:'remove'}
  cover: null,
};

const $ = (id) => document.getElementById(id);

/* ── transport ─────────────────────────────────────────── */

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'X-Auth': TOKEN, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let payload = null;
  try { payload = await res.json(); } catch (_) { /* non-JSON body */ }
  if (!res.ok || (payload && payload.error)) {
    throw new Error((payload && payload.error) || `Request failed (${res.status})`);
  }
  return payload;
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

/* ── toast / progress ──────────────────────────────────── */

let toastTimer = null;

function toast(message, { progress = null, kind = '', sticky = false } = {}) {
  const el = $('toast');
  el.hidden = false;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  $('toastMsg').textContent = message;
  $('toastBar').style.width = progress === null ? '100%' : `${Math.round(progress * 100)}%`;
  $('toastClose').hidden = !sticky;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

$('toastClose').onclick = () => { $('toast').hidden = true; };

function failure(err) {
  toast(err.message || String(err), { kind: 'error', sticky: true, progress: 1 });
}

/* Poll a background job until it finishes. */
async function follow(job) {
  toast(job.message || job.label, { progress: 0, kind: '', sticky: true });
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    let current;
    try {
      current = await api(`/api/job?id=${encodeURIComponent(job.id)}&t=${TOKEN}`);
    } catch (err) { failure(err); return null; }
    if (current.state === 'running') {
      toast(`${current.message} · ${current.elapsed}s`, { progress: current.progress, sticky: true });
      continue;
    }
    if (current.state === 'error') { failure(new Error(current.error)); return null; }
    toast(`${job.label} · done in ${current.elapsed}s`, { progress: 1, kind: 'ok' });
    return current.result;
  }
}

/* ── file browser ──────────────────────────────────────── */

const browser = new LibraryBrowser({state, api, post, follow, failure, openFile,
  renderSelection, showStudio});
const workspace = new Workspace({state, api, post, failure, browser, toast});
async function loadList(path) { return browser.load(path); }
function renderList() { browser.render(); }

async function showStudio(meta = state.meta) {
  if (!meta) return;
  try { const studio = await import('/studio.js'); await studio.openStudio(meta); }
  catch (err) { failure(err); }
}
$('openStudio').onclick = () => showStudio();

function renderSelection() {
  const n = state.selection.size;
  $('selectionBar').hidden = n === 0;
  $('selectionCount').textContent = `${n} selected for batch edit`;
  if (n > 1) showBatch(); else if (state.meta) showSingle(); else showPlaceholder();
}

$('clearSelection').onclick = () => {
  browser.cancelSelection();
  state.selection.clear();
  document.querySelectorAll('.filerow input[type=checkbox]').forEach((c) => { c.checked = false; });
  renderSelection();
};



/* ── panes ─────────────────────────────────────────────── */

function showPlaceholder() { $('placeholder').hidden = false; $('single').hidden = true; $('batch').hidden = true; }
function showSingle() { $('placeholder').hidden = true; $('single').hidden = false; $('batch').hidden = true; }
function showBatch() { $('placeholder').hidden = true; $('single').hidden = true; $('batch').hidden = false; renderBatch(); }

/* ── field widgets ─────────────────────────────────────── */

function fieldRow({ key, label, hint, value, disabled, disabledReason, indent, extraButton }) {
  const wrap = document.createElement('div');
  wrap.className = 'field' + (disabled ? ' disabled' : '') + (indent ? ' indent' : '');

  const lab = document.createElement('label');
  lab.setAttribute('for', key);
  lab.textContent = label;
  const sub = disabled ? disabledReason : hint;
  if (sub) {
    const small = document.createElement('span');
    small.className = 'hint-inline';
    small.textContent = sub;
    lab.appendChild(small);
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.id = key;
  input.value = value || '';
  input.disabled = !!disabled;
  input.spellcheck = false;

  wrap.appendChild(lab);
  if (extraButton) {
    const holder = document.createElement('div');
    holder.className = 'with-btn';
    holder.append(input, extraButton);
    wrap.appendChild(holder);
  } else {
    wrap.appendChild(input);
  }
  return wrap;
}

function nowButton(input) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost iconbtn';
  b.textContent = 'Today';
  b.title = 'Insert today\u2019s date';
  b.onclick = () => { input.value = new Date().toISOString().slice(0, 10); input.dispatchEvent(new Event('input')); };
  return b;
}

/* ── single-file editor ────────────────────────────────── */

async function openFile(path) {
  try {
    const meta = await api(`/api/meta?t=${TOKEN}&path=${encodeURIComponent(path)}`);
    state.meta = meta;
    renderSingle();
    if (state.selection.size <= 1) showSingle();
    document.querySelectorAll('.filelist .row').forEach((r) => {
      r.classList.toggle('active', r.dataset.path === path);
    });
  } catch (err) { failure(err); }
}

function renderSingle() {
  const meta = state.meta;
  workspace.render(meta);
  $('fileName').value = meta.name;
  $('renameBtn').disabled = true;

  const thumb = $('thumb');
  if (meta.hasThumbnail) {
    thumb.hidden = false;
    thumb.src = `/api/thumb?t=${TOKEN}&path=${encodeURIComponent(meta.path)}&v=${Date.now()}`;
  } else {
    thumb.hidden = true;
    thumb.removeAttribute('src');
  }

  const badges = $('badges');
  badges.textContent = '';
  addBadge(badges, 'Format', meta.format);
  Object.entries(meta.info).forEach(([k, v]) => addBadge(badges, k, v));

  const notes = $('notes');
  notes.textContent = '';
  meta.notes.forEach((text) => {
    const p = document.createElement('div');
    p.className = 'note';
    p.textContent = text;
    notes.appendChild(p);
  });

  // model fields
  const fields = $('fields');
  fields.textContent = '';
  state.config.schema.forEach((def) => {
    const editable = meta.editable.includes(def.key);
    const input = { ...def, value: meta.fields[def.key], disabled: !editable,
                    disabledReason: `not stored by ${meta.format}` };
    const row = fieldRow(input);
    if (editable && def.key.endsWith('_date')) {
      const el = row.querySelector('input');
      const holder = document.createElement('div');
      holder.className = 'with-btn';
      el.replaceWith(holder);
      holder.append(el, nowButton(el));
    }
    fields.appendChild(row);
  });
  fields.oninput = updateBudget;
  updateBudget();

  renderCoverSection();

  // object / part names
  const objectsSection = $('objectsSection');
  const objects = $('objects');
  objects.textContent = '';
  objectsSection.hidden = !meta.objects.length;
  meta.objects.forEach((obj) => {
    objects.appendChild(fieldRow({
      key: `obj:${obj.id}`,
      label: obj.label.trim(),
      value: obj.name,
      indent: obj.id.startsWith('part:'),
    }));
  });

  // free-form metadata
  $('customSection').hidden = !meta.customSupported;
  const custom = $('custom');
  custom.textContent = '';
  meta.custom.forEach((item) => custom.appendChild(customRow(item.name, item.value)));

  // Trading size for speed only means something when the payload is recompressed.
  $('fastWrap').hidden = !meta.recompress;
  $('revertBtn').hidden = !meta.hasBackup;
  $('discardBtn').hidden = !meta.hasBackup;
}

/* ── cover image (3MF only) ────────────────────────────── */

const COVER_SIZES = { large: 512, small: 128 };
const COVER_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const COVER_MAX_BYTES = 40 << 20;

function renderCoverSection() {
  const meta = state.meta;
  state.cover = null;
  $('coverSection').hidden = false;
  $('coverControls').hidden = !meta.thumbnailEditable;
  $('coverUnsupported').hidden = !!meta.thumbnailEditable;
  if (!meta.thumbnailEditable) return;

  const current = $('coverCurrent');
  if (meta.hasThumbnail) {
    current.hidden = false;
    current.src = `/api/thumb?t=${TOKEN}&path=${encodeURIComponent(meta.path)}&v=${Date.now()}`;
    $('coverNone').hidden = true;
  } else {
    current.hidden = true;
    current.removeAttribute('src');
    $('coverNone').hidden = false;
  }

  const bambu = meta.thumbnailKind === 'bambu';
  const remove = $('coverRemove');
  remove.hidden = !meta.thumbnailCustom;
  remove.textContent = bambu && String(meta.info['Cover image'] || '').startsWith('Auxiliaries/')
    ? 'Use slicer render instead' : 'Remove image';
  $('coverHint').textContent = bambu
    ? 'Bambu Studio / OrcaSlicer show this in Recent projects and keep it when you re-save. '
      + 'Plate previews and the printer screen still use the slicer\u2019s own render.'
    : 'Shown by file browsers. PrusaSlicer replaces it with a new render when it saves the project.';
  showCoverPreview();
}

/* Reflect state.cover in the "After saving" box and the status line. */
function showCoverPreview() {
  const cover = state.cover;
  const img = $('coverPreview');
  const none = $('coverPreviewNone');
  none.classList.remove('removing');
  if (cover && cover.action === 'set') {
    img.src = `data:image/png;base64,${cover.large}`;
    img.hidden = false;
    none.hidden = true;
    $('coverStatus').textContent = 'New image will be written when you save.';
  } else {
    img.hidden = true;
    img.removeAttribute('src');
    none.hidden = false;
    if (cover && cover.action === 'remove') {
      none.textContent = 'Will be removed on save';
      none.classList.add('removing');
      $('coverStatus').textContent = state.meta.thumbnailKind === 'bambu'
        ? 'On save the slicer\u2019s plate render becomes the cover again.'
        : 'On save the embedded image is removed.';
    } else {
      none.textContent = 'Choose an image to preview it';
      $('coverStatus').textContent = '';
    }
  }
  $('coverUndo').hidden = !cover;
}

/* Draw the bitmap into a size×size square (Fit = letterbox on transparent,
   Fill = centre crop) and return base64 PNG without the data: prefix. */
function coverPng(bitmap, size, mode) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const pick = mode === 'fill' ? Math.max : Math.min;
  const scale = pick(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toDataURL('image/png').split(',')[1];
}

function renderCover() {
  const cover = state.cover;
  if (!cover || cover.action !== 'set') return;
  const mode = $('coverFit').value;
  cover.large = coverPng(cover.bitmap, COVER_SIZES.large, mode);
  cover.small = coverPng(cover.bitmap, COVER_SIZES.small, mode);
  showCoverPreview();
}

$('coverPick').onclick = () => $('coverFile').click();

$('coverFile').onchange = async () => {
  const input = $('coverFile');
  const file = input.files && input.files[0];
  input.value = '';   // so picking the same file again still fires
  if (!file) return;
  if (!COVER_TYPES.includes(file.type)) {
    failure(new Error('Choose a PNG, JPG or WebP image.'));
    return;
  }
  if (file.size > COVER_MAX_BYTES) {
    failure(new Error('That image is over 40 MB. Choose a smaller one.'));
    return;
  }
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch (_) {
    failure(new Error('Could not read that image.'));
    return;
  }
  state.cover = { action: 'set', bitmap, large: null, small: null };
  renderCover();
};

$('coverFit').onchange = renderCover;

$('coverRemove').onclick = () => {
  state.cover = { action: 'remove' };
  showCoverPreview();
};

$('coverUndo').onclick = () => {
  state.cover = null;
  showCoverPreview();
};

function addBadge(parent, key, value) {
  const el = document.createElement('span');
  el.className = 'badge';
  el.innerHTML = `${escapeHtml(key)} <b>${escapeHtml(String(value))}</b>`;
  parent.appendChild(el);
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function customRow(name, value) {
  const row = document.createElement('div');
  row.className = 'customrow';
  const n = document.createElement('input');
  n.type = 'text'; n.value = name || ''; n.placeholder = 'Key'; n.spellcheck = false;
  n.dataset.role = 'custom-name';
  const v = document.createElement('input');
  v.type = 'text'; v.value = value || ''; v.placeholder = 'Value'; v.spellcheck = false;
  v.dataset.role = 'custom-value';
  const del = document.createElement('button');
  del.type = 'button'; del.className = 'ghost iconbtn danger'; del.textContent = '✕';
  del.title = 'Remove this field';
  del.onclick = () => row.remove();
  row.append(n, v, del);
  return row;
}

$('addCustom').onclick = () => { $('custom').appendChild(customRow('', '')); };

/* Binary STL packs everything into 80 bytes, so show the running total. */
const STL_PACK = [['title', 'Title'], ['designer', 'Designer'], ['copyright', 'Copyright'], ['license', 'License']];

function updateBudget() {
  const meta = state.meta;
  const el = $('budget');
  if (!meta || !meta.byteBudget) { el.hidden = true; return; }
  const values = collectFields();
  const packed = STL_PACK
    .filter(([key]) => (values[key] || '').trim())
    .map(([key, label]) => `${label}=${values[key].trim()}`)
    .join(';');
  const used = new TextEncoder().encode(packed).length;
  el.hidden = false;
  el.className = 'budget' + (used > meta.byteBudget ? ' over' : '');
  el.textContent = used > meta.byteBudget
    ? `${used} of ${meta.byteBudget} bytes used — ${used - meta.byteBudget} too many. Shorten a field before saving.`
    : `${used} of ${meta.byteBudget} bytes used in the STL header.`;
}

function collectFields() {
  const out = {};
  state.config.schema.forEach((def) => {
    const el = $(def.key);
    if (el && !el.disabled) out[def.key] = el.value;
  });
  return out;
}

function collectCustom() {
  return Array.from($('custom').querySelectorAll('.customrow')).map((row) => ({
    name: row.querySelector('[data-role=custom-name]').value.trim(),
    value: row.querySelector('[data-role=custom-value]').value,
  })).filter((item) => item.name);
}

function collectObjects() {
  const out = {};
  state.meta.objects.forEach((obj) => {
    const el = $(`obj:${obj.id}`);
    if (el && el.value !== obj.name) out[obj.id] = el.value;
  });
  return out;
}

async function save() {
  const meta = state.meta;
  if (!meta) return;
  if (meta.byteBudget) {
    updateBudget();
    if ($('budget').classList.contains('over')) { failure(new Error($('budget').textContent)); return; }
  }
  const body = {
    path: meta.path,
    fields: collectFields(),
    objects: collectObjects(),
    backup: $('backup').checked,
    fast: $('fast').checked,
  };
  if (meta.customSupported) body.custom = collectCustom();
  const cover = meta.thumbnailEditable ? state.cover : null;
  if (cover && cover.action === 'set') {
    body.thumbnail = { action: 'set', png: cover.large, pngSmall: cover.small };
  } else if (cover && cover.action === 'remove') {
    body.thumbnail = { action: 'remove' };
  }

  $('saveBtn').disabled = true;
  try {
    const { job } = await post('/api/save', body);
    const result = await follow(job);
    if (result) { await openFile(meta.path); await loadList(state.cwd); }
  } catch (err) { failure(err); } finally { $('saveBtn').disabled = false; }
}

$('saveBtn').onclick = save;

$('fileName').oninput = () => {
  $('renameBtn').disabled = !state.meta || $('fileName').value.trim() === state.meta.name
    || !$('fileName').value.trim();
};

$('renameForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const res = await post('/api/rename', { path: state.meta.path, name: $('fileName').value.trim() });
    toast(`Renamed to ${res.name}`, { kind: 'ok', progress: 1 });
    await loadList(state.cwd);
    await openFile(res.path);
  } catch (err) { failure(err); }
};

$('revertBtn').onclick = async () => {
  if (!confirm('Replace this file with the backup of the original?')) return;
  try {
    const { job } = await post('/api/revert', { path: state.meta.path });
    if (await follow(job)) { await openFile(state.meta.path); await loadList(state.cwd); }
  } catch (err) { failure(err); }
};

$('discardBtn').onclick = async () => {
  if (!confirm('Delete the .bak backup? The current file is kept.')) return;
  try {
    await post('/api/discardBackup', { path: state.meta.path });
    toast('Backup deleted', { kind: 'ok', progress: 1 });
    await openFile(state.meta.path);
    await loadList(state.cwd);
  } catch (err) { failure(err); }
};

/* ── batch editor ──────────────────────────────────────── */

function renderBatch() {
  const paths = Array.from(state.selection);
  $('batchTitle').textContent = `Edit ${paths.length} files`;
  const list = $('batchFiles');
  list.textContent = '';
  paths.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.split(/[\\/]/).pop();
    list.appendChild(li);
  });
  if ($('batchFields').childElementCount) return;   // keep typed values
  state.config.schema.forEach((def) => {
    $('batchFields').appendChild(fieldRow({
      key: `b-${def.key}`, label: def.label, hint: def.hint || 'leave blank to keep as-is', value: '',
    }));
  });
}

$('batchBtn').onclick = async () => {
  const fields = {};
  state.config.schema.forEach((def) => {
    const el = $(`b-${def.key}`);
    if (el && el.value.trim()) fields[def.key] = el.value.trim();
  });
  if (!Object.keys(fields).length) { failure(new Error('Fill in at least one field to apply.')); return; }
  const paths = Array.from(state.selection);
  if (!confirm(`Write those values into ${paths.length} file(s)?`)) return;

  $('batchBtn').disabled = true;
  try {
    const { job } = await post('/api/batch', { paths, fields, backup: $('batchBackup').checked, fast: $('batchFast').checked });
    const result = await follow(job);
    if (result) {
      await loadList(state.cwd);
      if (result.failed.length) {
        const lines = result.failed.map((f) => `${f.name}: ${f.error}`).join('\n');
        toast(`${result.applied.length} updated, ${result.failed.length} skipped`, { kind: 'error', sticky: true, progress: 1 });
        alert(`Skipped files:\n\n${lines}`);
      } else {
        toast(`Updated ${result.applied.length} file(s)`, { kind: 'ok', progress: 1 });
      }
    }
  } catch (err) { failure(err); } finally { $('batchBtn').disabled = false; }
};

/* ── boot ──────────────────────────────────────────────── */

function selectAllModelsShortcut() {
  const focused = document.activeElement;
  const editing = focused?.matches('textarea,select,input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])') || focused?.isContentEditable;
  if (editing || document.querySelector('dialog[open]')) return false;
  browser.selectAll();
  return true;
}
window.meshkeepDesktop?.onSelectAll?.(() => {
  if (!selectAllModelsShortcut()) document.execCommand('selectAll');
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a' && selectAllModelsShortcut()) {
    e.preventDefault();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (!$('single').hidden) save();
  }
});

(async function boot() {
  if (!TOKEN) {
    toast('Missing access token. Open the link printed in the terminal.', { kind: 'error', sticky: true, progress: 1 });
    return;
  }
  try {
    state.config = await api(`/api/config?t=${TOKEN}`);
    await workspace.refresh();
    // ?open=/path/to/model.3mf jumps straight to a file.
    const initial = new URLSearchParams(location.search).get('open');
    const remembered = localStorage.getItem('mme.folder');
    await loadList(initial || remembered || state.config.start);
    if (initial) await openFile(initial);
  } catch (err) { failure(err); }
})();
