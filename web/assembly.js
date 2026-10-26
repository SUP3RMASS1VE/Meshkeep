import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {TransformControls} from 'three/addons/controls/TransformControls.js';
import {loadModel, dispose} from './studio.js';
import {compactPlacements} from './assembly-layout.js';

const MAX_COPIES = 200;
const MAX_TRIANGLES = 5000000;
const axes = ['X', 'Y', 'Z'];
const $ = id => document.getElementById(id);
const materials = mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material];
const key = (part, copy) => `${part.id}:${copy}`;
const rounded = value => Number(value.toFixed(6));
let dialog, active, generation = 0;

function ensureDialog() {
  if (dialog) return;
  dialog = document.createElement('dialog');
  dialog.id = 'assemblyDialog';
  dialog.className = 'assembly-dialog';
  dialog.setAttribute('aria-labelledby', 'assemblyTitle');
  dialog.innerHTML = `
    <header class="assembly-header">
      <div class="assembly-heading"><span class="assembly-eyebrow">BUILD IT TOGETHER</span><h2 id="assemblyTitle">Assembly Studio</h2><p id="assemblyProjectName"></p></div>
      <div class="assembly-header-actions"><div id="assemblySaveState" role="status"></div><button id="assemblySave" class="primary" type="button" disabled>Save layout</button><button id="assemblyClose" type="button" aria-label="Close assembly studio">Close</button></div>
    </header>
    <div class="assembly-progress-strip"><span id="assemblySummary"></span><progress id="assemblyProgress" aria-label="Project copies printed" max="1" value="0"></progress><span class="assembly-legend"><i class="assembly-dot printed"></i>Printed <i class="assembly-dot pending"></i>To print</span></div>
    <div class="assembly-body">
      <section class="assembly-stage" aria-label="Interactive project assembly">
        <div id="assemblyCanvas"></div>
        <div class="assembly-stage-toolbar"><button id="assemblyFit" type="button" title="Show all pieces and fit the complete layout">Fit assembly</button><button id="assemblyFocus" type="button" title="Show just the selected piece close up; Fit assembly restores all pieces">Focus piece</button><button id="assemblyCompact" type="button">Compact layout</button><span id="assemblySceneCount"></span></div>
        <div class="assembly-stage-bottom"><div class="assembly-explode"><label for="assemblyExplode">Exploded view <output id="assemblyExplodeValue" for="assemblyExplode">0%</output></label><input id="assemblyExplode" type="range" min="0" max="100" step="1" value="0" disabled><div><span>Your layout</span><span>Exploded</span></div></div><p class="assembly-canvas-help">Drag to orbit · Scroll to zoom · Click a piece to select</p></div>
      </section>
      <aside class="assembly-sidebar" aria-label="Assembly controls">
        <div class="assembly-section-title"><h3>Project pieces</h3><span id="assemblyPartCount"></span></div>
        <select id="assemblyParts" size="5" aria-label="Assembly pieces"></select>
        <label class="assembly-progress-toggle"><input id="assemblyGhosts" type="checkbox" checked>Ghost unfinished pieces</label>
        <div class="assembly-selected"><span class="assembly-eyebrow">SELECTED PIECE</span><h3 id="assemblySelectionName">No piece selected</h3><p id="assemblySelectionPath"></p><p id="assemblySelectionProgress"></p></div>
        <div class="assembly-section-title"><h3>Arrange</h3><span class="assembly-unit-note">Z is up</span></div>
        <div class="assembly-mode"><button id="assemblyTranslate" type="button" aria-pressed="true" disabled>Move</button><button id="assemblyRotate" type="button" aria-pressed="false" disabled>Rotate</button></div>
        <p id="assemblyArrangeHint" class="assembly-hint">Drag the handles along the piece’s axes, or enter exact project coordinates below.</p>
        <form id="assemblyPlacementForm">
          <fieldset id="assemblyPlacement" disabled><legend>Position <span>mm · model centre</span></legend><div class="assembly-vector">${axes.map(axis => `<label>${axis}<input id="assemblyPosition${axis}" aria-label="Position ${axis}" type="number" min="-1000000" max="1000000" step="any" required value="0"></label>`).join('')}</div>
          <div class="assembly-field-label">Rotation <span>degrees</span></div><div class="assembly-vector">${axes.map(axis => `<label>${axis}<input id="assemblyRotation${axis}" aria-label="Rotation ${axis}" type="number" min="-360" max="360" step="any" required value="0"></label>`).join('')}</div><button id="assemblyApply" type="submit" disabled>Apply placement</button></fieldset>
        </form>
        <p id="assemblyStatus" role="status" aria-live="polite"></p>
        <details id="assemblyWarningDetails" class="assembly-warnings" hidden><summary id="assemblyWarningSummary">Some pieces could not be shown</summary><ul id="assemblyWarnings"></ul></details>
        <p class="assembly-footnote">Arrange the pieces to build your model. Layouts stay in this project; original files are unchanged.</p>
      </aside>
    </div>`;
  document.body.append(dialog);
  $('assemblyClose').onclick = requestClose;
  $('assemblySave').onclick = save;
  $('assemblyFit').onclick = () => { if (active) frame(active); };
  $('assemblyFocus').onclick = () => { if (active?.selected) frame(active, active.selected.group); };
  $('assemblyCompact').onclick = () => {
    const state=active;
    if (!state || !editable(state) || !state.copies.length || !commitDraft(state)) return;
    if (!confirm('Arrange all loaded pieces in a compact layout? This replaces their current positions. Save layout to keep the new positions.')) return;
    arrangeCopies(state, state.copies);
    state.dirty=true;updateFields(state);updateControls(state);frame(state);
    status('Pieces arranged compactly. Move and rotate them into their assembled positions, then save.');
  };
  $('assemblyGhosts').onchange = () => { if (active) { updateAppearance(active);render(active); } };
  $('assemblyExplode').oninput = changeExplode;
  $('assemblyParts').onchange = () => {
    const state = active;
    if (!state) return;
    if (!commitDraft(state)) { $('assemblyParts').value = state.selected?.key || ''; return; }
    select(state, state.copies.find(copy => copy.key === $('assemblyParts').value));
  };
  $('assemblyTranslate').onclick = () => setMode('translate');
  $('assemblyRotate').onclick = () => setMode('rotate');
  $('assemblyPlacementForm').onsubmit = event => { event.preventDefault(); if (active) applyFields(active); };
  $('assemblyPlacementForm').oninput = () => {
    if (!active || !editable(active)) return;
    active.draft = true;
    updateControls(active);
  };
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('close', () => {
    // Native close events are queued. A previous session's event must never
    // tear down a new session that has already reopened the same dialog.
    if (!dialog.open) finishSession();
  });
  dialog.addEventListener('keydown', event => {
    if (!active || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(event.target.tagName) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.toLowerCase() === 'f') frame(active);
    if (event.key.toLowerCase() === 'm') setMode('translate');
    if (event.key.toLowerCase() === 'r') setMode('rotate');
  });
  window.addEventListener('beforeunload', event => {
    if (active && (active.dirty || active.draft || active.saving)) { event.preventDefault(); event.returnValue = ''; }
  });
}

function requestClose() {
  if (!active) { dialog?.close(); return true; }
  if (active.saving) return false;
  if ((active.dirty || active.draft) && !confirm('Discard the unsaved assembly layout? Your last saved layout will be kept.')) return false;
  dialog.close();
  finishSession();
  return true;
}

function finishSession() {
  const state = active;
  active = null;
  ++generation;
  if (state) { cleanup(state); state.onClose?.(state.project); }
}

function editable(state) { return !state.loading && !state.saving && state.explode === 0; }
function alive(state) { return active === state && state.serial === generation && dialog.open; }
function render(state) { if (alive(state) && state.renderer) state.renderer.render(state.scene, state.camera); }
function status(message, error = false) {
  $('assemblyStatus').textContent = message;
  $('assemblyStatus').classList.toggle('assembly-error', error);
}

function updateControls(state) {
  const canEdit = editable(state) && !!state.selected;
  $('assemblyPlacement').disabled = !canEdit;
  $('assemblyApply').disabled = !canEdit;
  $('assemblyTranslate').disabled = $('assemblyRotate').disabled = !canEdit;
  $('assemblyParts').disabled = state.loading || state.saving;
  $('assemblyExplode').disabled = state.loading || state.saving || !state.copies.length;
  $('assemblyFit').disabled = !state.copies.length;
  $('assemblyFocus').disabled = !state.selected || state.loading;
  $('assemblyCompact').disabled = !editable(state) || !state.copies.length;
  $('assemblySave').disabled = state.loading || state.saving || !state.copies.length;
  $('assemblyClose').disabled = state.saving;
  $('assemblySaveState').textContent = state.saving ? 'Saving…' : state.loading ? 'Loading project…' : state.dirty || state.draft ? 'Unsaved layout' : state.copies.length ? state.persisted ? 'Layout saved' : 'Ready to save' : '';
  $('assemblySaveState').classList.toggle('unsaved', state.dirty || state.draft);
  $('assemblyArrangeHint').textContent = state.explode ? 'Return the slider to Your layout to move or rotate pieces.' : 'Drag the handles along the piece’s axes, or enter exact project coordinates below.';
  if (state.transform) {
    if (canEdit) state.transform.attach(state.selected.group);
    else state.transform.detach();
  }
}

function setupRenderer(state) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({antialias: true}); }
  catch (_) { throw new Error('Assembly Studio needs WebGL 2. Enable hardware acceleration to view your project.'); }
  state.renderer = renderer;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor('#151420');
  renderer.domElement.setAttribute('aria-label', '3D assembly; choose a piece in the list to edit its position with the keyboard');
  $('assemblyCanvas').replaceChildren(renderer.domElement);
  const scene = state.scene = new THREE.Scene();
  state.camera = new THREE.PerspectiveCamera(38, 1, .01, 100000);
  state.camera.position.set(150, 100, 180);
  state.controls = new OrbitControls(state.camera, renderer.domElement);
  state.controls.addEventListener('change', () => render(state));
  const hemisphere = new THREE.HemisphereLight(0xe8ddff, 0x302d43, 2.4);
  const main = new THREE.DirectionalLight(0xffeedf, 3.2); main.position.set(4, 7, 5);
  const fill = new THREE.DirectionalLight(0xa4baff, 1.8); fill.position.set(-4, 3, -5);
  scene.add(hemisphere, main, fill);
  state.root = new THREE.Group();
  state.root.rotation.x = -Math.PI / 2;
  scene.add(state.root);
  state.transform = new TransformControls(state.camera, renderer.domElement);
  state.transform.setSpace('local');
  state.transform.setSize(.85);
  scene.add(state.transform.getHelper());
  state.transform.addEventListener('change', () => render(state));
  state.transform.addEventListener('dragging-changed', event => {
    state.controls.enabled = !event.value;
    state.dragging = event.value;
    if (event.value) {
      state.wasTransformDrag = true;
    } else if (state.selected) {
      readTransform(state);
      updateGrid(state);
      updateControls(state);
      render(state);
    }
  });
  state.transform.addEventListener('objectChange', () => {
    if (!state.selected || !editable(state)) return;
    readTransform(state);
    state.dirty = true;
    updateFields(state);
    $('assemblySaveState').textContent = 'Unsaved layout';
    $('assemblySaveState').classList.add('unsaved');
    $('assemblySave').disabled = false;
    render(state);
  });
  state.resize = new ResizeObserver(() => {
    if (!alive(state)) return;
    const width = $('assemblyCanvas').clientWidth, height = $('assemblyCanvas').clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height);
    state.camera.aspect = width / height;
    state.camera.updateProjectionMatrix();
    render(state);
  });
  state.resize.observe($('assemblyCanvas'));
  // TransformControls snapshots the starting transform on pointerdown. Commit
  // the form before that snapshot, so a draft cannot jump back or be discarded.
  renderer.domElement.addEventListener('pointerdown', event => {
    if (state.draft && !commitDraft(state)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  let down;
  renderer.domElement.addEventListener('pointerdown', event => {
    down = [event.clientX, event.clientY];
    state.wasTransformDrag = !!state.transform.axis;
  });
  renderer.domElement.addEventListener('pointerup', event => {
    if (event.button !== 0 || state.loading || state.saving || !down || state.wasTransformDrag || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(pointer, state.camera);
    const hit = raycaster.intersectObject(state.focused && state.selected ? state.selected.group : state.root, true).find(result => result.object.isMesh);
    let object = hit?.object;
    while (object && !object.userData.assemblyKey) object = object.parent;
    if (object && commitDraft(state)) select(state, state.copies.find(copy => copy.key === object.userData.assemblyKey));
  });
}

function readTransform(state) {
  const copy = state.selected;
  if (!copy) return;
  copy.position.copy(copy.group.position).clampScalar(-1000000, 1000000);
  copy.group.position.copy(copy.position);
  copy.rotation.set(copy.group.rotation.x, copy.group.rotation.y, copy.group.rotation.z);
  // Euler angles from the gizmo can accumulate full turns. Store an equivalent bounded angle.
  copy.rotation.toArray().slice(0, 3).forEach((angle, index) => {
    const value = THREE.MathUtils.euclideanModulo(angle + Math.PI, Math.PI * 2) - Math.PI;
    copy.rotation.setComponent(index, value);
  });
  copy.group.rotation.set(copy.rotation.x, copy.rotation.y, copy.rotation.z, 'XYZ');
}

function updateFields(state) {
  axes.forEach((axis, index) => {
    $('assemblyPosition' + axis).value = state.selected ? String(Number(state.selected.position.getComponent(index).toFixed(4))) : '0';
    $('assemblyRotation' + axis).value = state.selected ? String(Number(THREE.MathUtils.radToDeg(state.selected.rotation.getComponent(index)).toFixed(4))) : '0';
  });
  state.draft = false;
}

function applyFields(state) {
  if (!editable(state) || !state.selected) return false;
  const position = axes.map(axis => $('assemblyPosition' + axis).valueAsNumber);
  const rotation = axes.map(axis => $('assemblyRotation' + axis).valueAsNumber);
  if (!position.every(value => Number.isFinite(value) && Math.abs(value) <= 1000000) || !rotation.every(value => Number.isFinite(value) && Math.abs(value) <= 360)) {
    status('Use finite positions between −1,000,000 and 1,000,000 mm and rotations between −360° and 360°.', true);
    $('assemblyPlacementForm').reportValidity();
    return false;
  }
  const copy = state.selected;
  copy.position.fromArray(position);
  copy.rotation.fromArray(rotation.map(THREE.MathUtils.degToRad));
  copy.group.position.copy(copy.position);
  copy.group.rotation.set(copy.rotation.x, copy.rotation.y, copy.rotation.z, 'XYZ');
  state.dirty = true;
  state.draft = false;
  updateGrid(state);
  updateControls(state);
  status('Placement updated.');
  render(state);
  return true;
}

function commitDraft(state) { return !state.draft || applyFields(state); }

function setMode(mode) {
  const state = active;
  if (!state || !editable(state) || !commitDraft(state)) return;
  state.transform.setMode(mode);
  // Both handle modes use the piece's local Z-up axes. The exact-value fields
  // below always describe its position in the project's fixed Z-up axes.
  state.transform.setSpace('local');
  $('assemblyTranslate').setAttribute('aria-pressed', String(mode === 'translate'));
  $('assemblyRotate').setAttribute('aria-pressed', String(mode === 'rotate'));
  render(state);
}

function select(state, copy) {
  state.selected = copy || null;
  $('assemblyParts').value = copy?.key || '';
  updateAppearance(state);
  $('assemblySelectionName').textContent = copy ? copy.part.name + (copy.part.required > 1 ? ` · copy ${copy.index + 1}` : '') : 'No piece selected';
  $('assemblySelectionPath').textContent = copy ? copy.part.path.split(/[\\/]/).pop() : '';
  $('assemblySelectionPath').title = copy?.part.path || '';
  $('assemblySelectionProgress').textContent = copy ? `${copy.part.completed} of ${copy.part.required} required copies printed · ${copy.printed ? 'This copy is printed' : 'This copy is still to print'}${copy.meshCount>1 ? ` · ${copy.meshCount} component meshes move together in this file.` : ''}` : '';
  $('assemblySelectionProgress').classList.toggle('is-printed', !!copy?.printed);
  updateFields(state);
  updateControls(state);
  if (state.focused && copy) frame(state,copy.group); else render(state);
}

function updateAppearance(state) {
  for (const copy of state.copies) copy.group.traverse(mesh => {
    if (!mesh.isMesh) return;
    const ghost=$('assemblyGhosts').checked && !copy.printed;
    for (const material of materials(mesh)) {
      material.transparent=ghost;
      material.opacity=ghost ? (copy===state.selected ? .8 : .45) : 1;
      material.depthWrite=!ghost;
      material.emissive?.set(copy===state.selected ? '#302141' : '#000000');
    }
  });
}

function frame(state, object = state.root) {
  if (!state.copies.length || !state.camera) return;
  state.focused=object!==state.root;
  state.copies.forEach(copy => {copy.group.visible=!state.focused || copy.group===object;});
  $('assemblySceneCount').textContent=state.focused ? 'Focused piece · Fit assembly to show all' : `${state.copies.length} of ${state.project.required} copies shown`;
  state.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, .01);
  const vertical = THREE.MathUtils.degToRad(state.camera.fov) / 2;
  const horizontal = Math.atan(Math.tan(vertical) * state.camera.aspect);
  const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.12;
  state.camera.near = Math.max(distance / 10000, .000001);
  state.camera.far = distance * 100;
  state.camera.position.copy(new THREE.Vector3(.75, .6, .9).normalize().multiplyScalar(distance).add(center));
  state.camera.updateProjectionMatrix();
  state.controls.target.copy(center);
  state.controls.minDistance = radius * .02;
  state.controls.maxDistance = distance * 30;
  state.controls.update();
  render(state);
}

function updateGrid(state) {
  if (!state.copies.length || !state.scene) return;
  if (state.grid) { state.scene.remove(state.grid); dispose(state.grid); }
  const box = new THREE.Box3().setFromObject(state.root);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const extent = Math.max(size.x, size.z, 10) * 1.8;
  const grid = state.grid = new THREE.GridHelper(extent, 20, 0x645472, 0x342e43);
  grid.position.set(center.x, box.min.y - Math.max(size.y * .008, .05), center.z);
  materials(grid).forEach(material => { material.transparent = true; material.opacity = .5; material.depthWrite = false; });
  state.scene.add(grid);
}

function prepareExplosion(state) {
  const box = new THREE.Box3();
  state.copies.forEach(copy => box.expandByPoint(copy.position));
  const center = box.getCenter(new THREE.Vector3());
  const sizes = state.copies.map(copy => new THREE.Box3().setFromObject(copy.group).getSize(new THREE.Vector3()).length()).sort((a,b) => a-b);
  // A print-plate overview or widely placed parts must not send every piece
  // thousands of millimetres away when the slider moves.
  const distance = Math.max(sizes[Math.floor(sizes.length/2)] * .9, 10);
  const coincident = new Map();
  for (const copy of state.copies) {
    const positionKey = copy.position.toArray().map(value => value.toFixed(5)).join(',');
    if (!coincident.has(positionKey)) coincident.set(positionKey, []);
    coincident.get(positionKey).push(copy);
    copy.coincidentGroup = coincident.get(positionKey);
  }
  state.copies.forEach((copy, index) => {
    const direction = copy.position.clone().sub(center);
    if (copy.coincidentGroup.length > 1) {
      // Even coincident parts away from the assembly centre need distinct rays.
      // Spread each group around its shared outward direction deterministically.
      if (direction.lengthSq() < .00001) direction.set(0, 0, 1);
      direction.normalize();
      const normal = Math.abs(direction.z) < .9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
      const tangent = new THREE.Vector3().crossVectors(direction, normal).normalize();
      const bitangent = new THREE.Vector3().crossVectors(direction, tangent).normalize();
      const angle = copy.coincidentGroup.indexOf(copy) * Math.PI * 2 / copy.coincidentGroup.length;
      direction.multiplyScalar(.75).addScaledVector(tangent, Math.cos(angle) * .65).addScaledVector(bitangent, Math.sin(angle) * .65);
    } else if (direction.lengthSq() < .00001) {
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      direction.set(Math.cos(angle), Math.sin(angle), .35 + (index % 3) * .3);
    }
    copy.explodeOffset = direction.normalize().multiplyScalar(distance);
  });
}

function changeExplode() {
  const state = active;
  if (!state || state.loading || state.saving) return;
  if (!commitDraft(state)) { $('assemblyExplode').value = String(state.explode * 100); return; }
  const amount = Number($('assemblyExplode').value) / 100;
  if (state.explode === 0 && amount > 0) prepareExplosion(state);
  state.explode = amount;
  state.copies.forEach(copy => copy.group.position.copy(copy.position).addScaledVector(copy.explodeOffset || new THREE.Vector3(), amount));
  $('assemblyExplodeValue').textContent = `${Math.round(amount * 100)}%`;
  updateControls(state);
  // Keep the changing assembly in view throughout the reveal.
  frame(state);
}

function addWarning(state, text) {
  state.warnings.push(text);
  const li = document.createElement('li'); li.textContent = text;
  $('assemblyWarnings').append(li);
  $('assemblyWarningDetails').hidden = false;
  $('assemblyWarningSummary').textContent = `${state.warnings.length} notice${state.warnings.length === 1 ? '' : 's'}`;
}

function addCopy(state, part, index, template, saved) {
  const group = new THREE.Group();
  group.userData.assemblyKey = key(part, index);
  // loadModel presents a centred Y-up preview. Undo that basis change so all
  // editable transforms belong to the project's millimetre, Z-up coordinate system.
  const basis = new THREE.Group(); basis.rotation.x = Math.PI / 2;
  const object = template.clone(true);
  const printed = index < part.completed;
  let meshCount=0;
  object.traverse(mesh => {
    if (!mesh.isMesh) return;
    ++meshCount;
    const clones = materials(mesh).map(source => {
      const material = source.clone();
      material.transparent = !printed;
      material.opacity = printed ? 1 : .45;
      material.depthWrite = printed;
      return material;
    });
    mesh.material = Array.isArray(mesh.material) ? clones : clones[0];
  });
  basis.add(object); group.add(basis); state.root.add(group);
  const copy = {key: key(part, index), part, index, group, printed, meshCount, position: new THREE.Vector3(), rotation: new THREE.Vector3(), saved};
  if (saved) { copy.position.fromArray(saved.position); copy.rotation.fromArray(saved.rotation.map(THREE.MathUtils.degToRad)); }
  state.copies.push(copy);
  const option = new Option(`${printed ? '●' : '○'} ${part.name}${part.required > 1 ? ` · ${index + 1}/${part.required}` : ''} — ${printed ? 'Printed' : 'To print'}`, copy.key);
  option.dataset.printed = String(printed);
  $('assemblyParts').append(option);
}

function arrangeCopies(state, copies) {
  if (!copies.length) return;
  // Measure in fixed project axes, with each piece's rotation retained.
  copies.forEach(copy => copy.group.position.set(0,0,0));
  state.root.updateMatrixWorld(true);
  const inverse = state.root.matrixWorld.clone().invert();
  const bounds = copies.map(copy => new THREE.Box3().setFromObject(copy.group).applyMatrix4(inverse));
  const placements = compactPlacements(bounds.map(box => ({min:box.min.toArray(),max:box.max.toArray()})));
  const fixed = state.copies.filter(copy => !copies.includes(copy));
  let offset=0;
  if (fixed.length) {
    const occupied=new THREE.Box3();
    fixed.forEach(copy => occupied.union(new THREE.Box3().setFromObject(copy.group).applyMatrix4(inverse)));
    const left=Math.min(...placements.map((p,i) => p[0]+bounds[i].min.x));
    offset=occupied.max.x-left+Math.max(occupied.getSize(new THREE.Vector3()).x*.05,1);
  }
  copies.forEach((copy,index) => {
    copy.position.fromArray(placements[index]);copy.position.x+=offset;
    copy.group.position.copy(copy.position);
  });
  state.root.updateMatrixWorld(true);updateGrid(state);
}

function initialLayout(state) {
  state.copies.forEach(copy => {
    copy.group.position.copy(copy.position);
    copy.group.rotation.set(copy.rotation.x, copy.rotation.y, copy.rotation.z, 'XYZ');
  });
  const fresh=state.copies.filter(copy => !copy.saved);
  if (fresh.length) { arrangeCopies(state,fresh);state.persisted=false; }
  state.root.updateMatrixWorld(true);
  updateGrid(state);
}

async function save() {
  const state = active;
  if (!state || state.loading || state.saving || !state.copies.length || !commitDraft(state)) return;
  const layout = state.copies.map(copy => ({part_id: copy.part.id, copy_index: copy.index,
    position: copy.position.toArray().map(rounded), rotation: copy.rotation.toArray().map(value => rounded(THREE.MathUtils.radToDeg(value)))}));
  state.saving = true;
  updateControls(state);
  status('Saving layout…');
  try {
    const project = await state.saveLayout(layout);
    if (!alive(state)) return;
    state.project = project;
    state.dirty = state.draft = false;
    state.persisted = true;
    status('Layout saved locally.');
  } catch (error) {
    if (alive(state)) status(`Could not save layout: ${error.message}. Your changes are still here; try Save layout again.`, true);
  } finally {
    if (alive(state)) { state.saving = false; updateControls(state); render(state); }
  }
}

function cleanup(state) {
  state.abort.abort();
  state.resize?.disconnect();
  state.transform?.detach();
  state.transform?.dispose();
  state.controls?.dispose();
  if (state.root) dispose(state.root);
  if (state.grid) dispose(state.grid);
  state.renderer?.dispose();
  state.renderer?.forceContextLoss();
  state.renderer?.domElement.remove();
  state.copies.length = 0;
}

export async function openAssembly(project, {saveLayout, onClose} = {}) {
  ensureDialog();
  if (active) {
    // The normal entry point is a button below the modal. Guard programmatic
    // re-entry as well, including an in-flight save and unsaved edits.
    if (!requestClose()) return;
  }
  const state = active = {project, saveLayout, onClose, serial: ++generation, abort: new AbortController(), copies: [], warnings: [], loading: true, saving: false, dirty: false, draft: false, persisted: true, explode: 0, selected: null};
  $('assemblyProjectName').textContent = project.name;
  $('assemblySummary').textContent = `${project.completed} of ${project.required} copies printed`;
  $('assemblyProgress').max = project.required || 1; $('assemblyProgress').value = project.completed;
  $('assemblyParts').replaceChildren(); $('assemblyWarnings').replaceChildren();
  $('assemblyWarningDetails').hidden = true; $('assemblyWarningDetails').open = false;
  $('assemblyPartCount').textContent = ''; $('assemblySceneCount').textContent = '';
  $('assemblyExplode').value = '0'; $('assemblyExplodeValue').textContent = '0%';
  $('assemblySelectionName').textContent = 'No piece selected';
  $('assemblySelectionPath').textContent = $('assemblySelectionProgress').textContent = '';
  $('assemblyTranslate').setAttribute('aria-pressed', 'true'); $('assemblyRotate').setAttribute('aria-pressed', 'false');
  status('Loading project pieces…'); updateFields(state); updateControls(state);
  dialog.showModal();
  try {
    setupRenderer(state);
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (!alive(state)) return;
    const saved = new Map((project.layout || []).map(entry => [`${entry.part_id}:${entry.copy_index}`, entry]));
    let triangles = 0;
    for (const part of project.parts) {
      if (!alive(state)) return;
      if (part.missing) { addWarning(state, `${part.name}: model file is missing. Its saved layout and print progress are retained.`); continue; }
      if (state.copies.length >= MAX_COPIES) { addWarning(state, `${part.name}: not shown because this scene is limited to ${MAX_COPIES} copies.`); continue; }
      status(`Loading ${part.name}…`);
      let loaded;
      try {
        loaded = await loadModel(part.path, state.abort.signal);
        if (!alive(state)) { dispose(loaded.object); return; }
        const count = Math.min(part.required, MAX_COPIES - state.copies.length, Math.floor((MAX_TRIANGLES - triangles) / loaded.triangles));
        if (count < part.required) addWarning(state, `${part.name}: showing ${count} of ${part.required} copies. Scene limit: ${MAX_COPIES} copies and 5 million triangles.`);
        for (let index = 0; index < count; index++) addCopy(state, part, index, loaded.object, saved.get(key(part, index)));
        triangles += loaded.triangles * count;
        if (loaded.object.userData.warnings?.length) addWarning(state, `${part.name}: ${loaded.object.userData.warnings.join(' ')}`);
        // Geometry now belongs to the scene copies. The source's materials do
        // not: each copy has independent transparency and selection appearance.
        if (count) loaded.object.traverse(mesh => { if (mesh.isMesh) materials(mesh).forEach(material => material.dispose()); });
        else dispose(loaded.object);
      } catch (error) {
        if (!alive(state) || error.name === 'AbortError') return;
        addWarning(state, `${part.name}: ${error.message}`);
      }
    }
    if (!alive(state)) return;
    initialLayout(state);
    state.loading = false;
    $('assemblyPartCount').textContent = String(state.copies.length);
    $('assemblySceneCount').textContent = `${state.copies.length} of ${project.required} copies shown`;
    select(state, state.copies[0]);
    frame(state);
    status(state.copies.length ? 'Select a piece and arrange your model. Save layout to keep its position.' : project.parts.length ? 'No pieces could be displayed. See the notices below.' : 'This project has no parts yet. Add models from the project panel.');
    if (!state.copies.length && state.warnings.length) $('assemblyWarningDetails').open = true;
  } catch (error) {
    if (alive(state)) { state.loading = false; status(error.message, true); updateControls(state); }
  }
}
