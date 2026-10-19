import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
import {OBJLoader} from 'three/addons/loaders/OBJLoader.js';
import {PLYLoader} from 'three/addons/loaders/PLYLoader.js';
import {AMFLoader} from 'three/addons/loaders/AMFLoader.js';
import {parse3MF} from './threemf.js';
import {analyze} from './geometry.js';

const token = new URLSearchParams(location.search).get('t') || '';
const $ = id => document.getElementById(id);
const dialog = $('studioDialog');
const materialList = object => Array.isArray(object.material) ? object.material : [object.material];

export function dispose(object) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  object?.traverse(item => {
    if (item.geometry) geometries.add(item.geometry);
    if (item.material) for (const material of materialList(item)) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
}

export async function loadModel(path, signal) {
  const response = await fetch('/api/model?' + new URLSearchParams({path}), {headers: {'X-Auth': token}, signal});
  if (!response.ok) {
    const error = await response.json(); throw new Error(error.error || 'Could not load this model.');
  }
  const stamp = response.headers.get('X-Model-Stamp')?.split(',');
  const buffer = await response.arrayBuffer();
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const ext = path.split('.').pop().toLowerCase();
  let object;
  if (ext === '3mf') object = parse3MF(buffer);
  else if (ext === 'obj') object = new OBJLoader().parse(new TextDecoder().decode(buffer));
  else if (ext === 'amf') object = new AMFLoader().parse(buffer);
  else {
    const geometry = ext === 'stl' ? new STLLoader().parse(buffer) : new PLYLoader().parse(buffer);
    // STL exporters often emit zero or stale facet normals; derive them from
    // the triangles so valid geometry still receives lighting.
    if (ext === 'stl' || !geometry.hasAttribute('normal')) geometry.computeVertexNormals();
    object = new THREE.Group();
    object.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({color: geometry.hasAttribute('color') ? 0xffffff : 0x82b8ed,
      vertexColors: geometry.hasAttribute('color'), roughness: .65, side: THREE.DoubleSide})));
  }
  let triangles = 0;
  object.traverse(item => {
    if (item.isMesh) {
      if (!item.geometry.hasAttribute('normal')) item.geometry.computeVertexNormals();
      triangles += (item.geometry.index?.count || item.geometry.attributes.position?.count || 0) / 3;
      // OBJ/AMF may supply unlit or Phong materials. Use one lighting model in the studio.
      const converted = materialList(item).map(source => {
        const material = new THREE.MeshStandardMaterial({color: source.color || 0x82b8ed, roughness: .65,
          vertexColors: !!item.geometry.attributes.color, side: THREE.DoubleSide,
          transparent: source.transparent, opacity: source.opacity, flatShading: !!source.flatShading});
        source.dispose(); return material;
      });
      item.material = Array.isArray(item.material) ? converted : converted[0];
    }
  });
  object.rotation.x = -Math.PI / 2; // print files use Z-up; Three's orbit controls use Y-up
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite) || !triangles) {
    dispose(object); throw new Error('This model has no finite, renderable triangle geometry.');
  }
  if (triangles > 5000000) { dispose(object); throw new Error('Preview limit: 5 million triangles.'); }
  const center = box.getCenter(new THREE.Vector3()); object.position.sub(center);
  object.updateMatrixWorld(true);
  return {object, stamp, triangles, size: box.getSize(new THREE.Vector3())};
}

function environment(width, height) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true}); }
  catch (_) { throw new Error('3D preview needs WebGL 2. Enable hardware acceleration or try a supported browser.'); }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#151420');
  const camera = new THREE.PerspectiveCamera(38, width / height, .01, 10000);
  const hemisphere = new THREE.HemisphereLight(0xddeeff, 0x303346, 2.2); scene.add(hemisphere);
  const key = new THREE.DirectionalLight(0xfff4e5, 3); key.position.set(3, 5, 4); scene.add(key);
  const fill = new THREE.DirectionalLight(0x9cbfff, 1.5); fill.position.set(-4, 1, -3); scene.add(fill);
  return {renderer, scene, camera, hemisphere, key, fill};
}
function fit(context, object, controls) {
  const box = new THREE.Box3().setFromObject(object), size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, .001);
  const vertical = THREE.MathUtils.degToRad(context.camera.fov) / 2;
  const horizontal = Math.atan(Math.tan(vertical) * context.camera.aspect);
  const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.12;
  context.camera.near = Math.max(distance / 10000, .000001); context.camera.far = distance * 100;
  context.camera.position.set(distance * .65, distance * .45, distance * .65);
  context.camera.position.setLength(distance);
  context.camera.lookAt(0, 0, 0); context.camera.updateProjectionMatrix();
  if (controls) { controls.target.set(0, 0, 0); controls.minDistance = radius * .03; controls.maxDistance = distance * 30; controls.update(); }
}

let thumbContext;
export async function thumbnail(path) {
  const loaded = await loadModel(path);
  try {
    thumbContext ||= environment(320, 256);
    thumbContext.scene.add(loaded.object); fit(thumbContext, loaded.object);
    thumbContext.renderer.render(thumbContext.scene, thumbContext.camera);
    const png = thumbContext.renderer.domElement.toDataURL('image/png');
    await saveThumbnail(path, png, loaded.stamp);
    return png;
  } finally { thumbContext?.scene.remove(loaded.object); dispose(loaded.object); }
}
async function saveThumbnail(path, png, stamp) {
  const response = await fetch('/api/cachePreview', {method: 'POST', headers: {'X-Auth': token, 'Content-Type': 'application/json'},
    body: JSON.stringify({path, png, stamp})});
  if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Could not cache thumbnail.'); }
}

let measuring=false,measurePoints=[],measureGroup=null;
let studio, model, selected, parts = [], originals = new Map(), abort, generation = 0, currentMeta, currentStamp;
function draw() { if (studio && dialog.open) studio.renderer.render(studio.scene, studio.camera); }
function restoreMaterials() {
  for (const part of parts) {
    for (const material of materialList(part)) material.dispose();
    const original = originals.get(part);
    part.material = Array.isArray(original) ? original.map(m => m.clone()) : original.clone();
  }
}
function selectPart(part) {
  if (selected) materialList(selected).forEach(m => { m.emissive.set(0); });
  selected = part;
  if (part) materialList(part).forEach(m => { m.emissive.set('#15382f'); });
  $('studioParts').value = part ? String(parts.indexOf(part)) : '';
  $('studioIsolate').disabled = !part;
  $('studioSelection').textContent = part ? `${part.name || 'Part ' + (parts.indexOf(part) + 1)} · ${((part.geometry.index?.count || part.geometry.attributes.position.count) / 3).toLocaleString()} triangles` : 'No part selected';
  $('studioEditName').hidden = !part?.userData.editKey || !document.getElementById('obj:' + part.userData.editKey);
  draw();
}
function clearMeasurement() {
  if(measureGroup){studio.scene.remove(measureGroup);dispose(measureGroup);measureGroup=null}
  measurePoints=[];$('studioMeasurement').textContent=measuring?'Click two points on the model surface.':'';$('studioClearMeasure').hidden=true;draw();
}
function measurePoint(point) {
  if(measurePoints.length===2)clearMeasurement();
  measurePoints.push(point.clone());
  measureGroup ||= new THREE.Group();studio.scene.add(measureGroup);
  const radius=Math.max(new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).length()*.004,.001);
  const marker=new THREE.Mesh(new THREE.SphereGeometry(radius,12,8),new THREE.MeshBasicMaterial({color:0xffad97,depthTest:false}));marker.position.copy(point);marker.renderOrder=10;measureGroup.add(marker);
  $('studioClearMeasure').hidden=false;
  if(measurePoints.length===2){
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(measurePoints),new THREE.LineBasicMaterial({color:0xffad97,depthTest:false}));line.renderOrder=10;measureGroup.add(line);
    const delta=measurePoints[1].clone().sub(measurePoints[0]);
    $('studioMeasurement').textContent=`${delta.length().toFixed(2)} mm · ΔX ${Math.abs(delta.x).toFixed(2)} · ΔY ${Math.abs(delta.z).toFixed(2)} · ΔZ ${Math.abs(delta.y).toFixed(2)}`;
  }else $('studioMeasurement').textContent='First point set. Click a second surface point.';
  draw();
}
function ensureStudio() {
  if (studio) return;
  studio = environment(640, 480);
  $('studioCanvas').append(studio.renderer.domElement);
  studio.controls = new OrbitControls(studio.camera, studio.renderer.domElement);
  studio.controls.addEventListener('change', draw);
  new ResizeObserver(() => {
    const width = $('studioCanvas').clientWidth, height = $('studioCanvas').clientHeight;
    if (!width || !height) return;
    studio.renderer.setSize(width, height); studio.camera.aspect = width / height;
    studio.camera.updateProjectionMatrix(); draw();
  }).observe($('studioCanvas'));
  let down;
  studio.renderer.domElement.addEventListener('pointerdown', event => { down = [event.clientX, event.clientY]; });
  studio.renderer.domElement.addEventListener('pointerup', event => {
    if (!model || event.button !== 0 || !down || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) return;
    const rect = studio.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(pointer, studio.camera);
    const hit=raycaster.intersectObjects(parts.filter(p=>p.visible),false)[0];
    if(measuring){if(hit)measurePoint(hit.point)}else selectPart(hit?.object||null);
  });
  $('studioMeasure').onclick=()=>{measuring=!measuring;$('studioMeasure').setAttribute('aria-pressed',String(measuring));clearMeasurement()};
  $('studioClearMeasure').onclick=clearMeasurement;
  $('studioFit').onclick = () => { if (model) fit(studio, model, studio.controls); draw(); };
  $('studioParts').onchange = () => selectPart(parts[Number($('studioParts').value)] || null);
  $('studioIsolate').onclick = () => { if (selected) { parts.forEach(p => { p.visible = p === selected; }); draw(); } };
  $('studioShowAll').onclick = () => { parts.forEach(p => { p.visible = true; }); draw(); };
  $('studioEditName').onclick = () => {
    const input = document.getElementById('obj:' + selected?.userData.editKey);
    if (input) { dialog.close(); input.scrollIntoView({block: 'center'}); input.focus(); }
  };
  $('studioLighting').onchange = () => {
    const preset = {soft: [2.2, 3, 1.5], bright: [3, 4, 2.5], dramatic: [.5, 5, .3]}[$('studioLighting').value];
    [studio.hemisphere.intensity, studio.key.intensity, studio.fill.intensity] = preset; draw();
  };
  $('studioExposure').oninput = () => { studio.renderer.toneMappingExposure = Number($('studioExposure').value); draw(); };
  const appearance = () => {
    const preset = $('studioMaterial').value;
    for (const part of selected ? [selected] : parts) {
      const original = originals.get(part), sources = Array.isArray(original) ? original : [original];
      materialList(part).forEach((material, index) => {
        const source = sources[index];
        material.color.copy(preset === 'original' ? source.color : new THREE.Color($('studioColor').value));
        material.vertexColors = preset === 'original' && source.vertexColors;
        material.roughness = {original: .65, matte: .85, metal: .25, gloss: .12}[preset];
        material.metalness = preset === 'metal' ? .8 : 0;
        material.wireframe = $('studioWireframe').checked; material.needsUpdate = true;
      });
    }
    draw();
  };
  for (const id of ['studioMaterial', 'studioWireframe']) $(id).onchange = appearance;
  $('studioColor').oninput = () => { if ($('studioMaterial').value === 'original') $('studioMaterial').value = 'matte'; appearance(); };
  $('studioReset').onclick = () => {
    restoreMaterials(); selectPart(null); parts.forEach(p => { p.visible = true; });
    $('studioMaterial').value = 'original'; $('studioWireframe').checked = false;
    $('studioColor').value = '#82b8ed'; $('studioLighting').value = 'soft'; $('studioExposure').value = '1';
    studio.renderer.toneMappingExposure = 1; $('studioLighting').onchange(); draw();
  };
  $('studioCapture').onclick = async () => {
    if (!model) return;
    try {
      // Capture a bounded image regardless of display scale.
      const previous = selected; selectPart(null); draw();
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
      const source = studio.renderer.domElement;
      const scale = Math.min(512 / source.width, 512 / source.height);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#151420'; ctx.fillRect(0, 0, 512, 512);
      ctx.drawImage(source, (512 - source.width * scale) / 2, (512 - source.height * scale) / 2, source.width * scale, source.height * scale);
      await saveThumbnail(currentMeta.path, canvas.toDataURL('image/png'), currentStamp);
      selectPart(previous); $('studioStatus').textContent = 'Library thumbnail saved. Refresh the library view to display it.';
    } catch (err) { $('studioStatus').textContent = err.message; }
  };
}
function clearModel() {
  measuring=false;clearMeasurement();$('studioMeasure').setAttribute('aria-pressed','false');
  $('studioDimensions').textContent='';$('studioVolume').textContent='';
  selected = null;
  if (model) { studio.scene.remove(model); dispose(model); model = null; }
  for (const original of originals.values()) for (const material of Array.isArray(original) ? original : [original]) material.dispose();
  originals.clear(); parts = [];
  $('studioParts').replaceChildren(); $('studioPartCount').textContent = '';
  $('studioIsolate').disabled = $('studioCapture').disabled = true;
  $('studioEditName').hidden = true; $('studioSelection').textContent = 'No part selected';
}
dialog.addEventListener('close', () => { ++generation; abort?.abort(); clearModel(); });
export async function openStudio(meta) {
  const serial = ++generation;
  abort?.abort(); abort = new AbortController(); currentMeta = meta;
  if (!dialog.open) dialog.showModal();
  $('studioFilename').textContent = meta.name;
  $('studioStatus').textContent = 'Loading model…';
  try {
    ensureStudio(); clearModel();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const loaded = await loadModel(meta.path, abort.signal);
    if (serial !== generation || !dialog.open) { dispose(loaded.object); return; }
    model = loaded.object; currentStamp = loaded.stamp;
    const parserMaterials = new Set();
    model.traverse(part => {
      if (!part.isMesh) return;
      if (!part.name) part.name = 'Part ' + (parts.length + 1);
      parts.push(part);
      const original = part.material; materialList(part).forEach(m => parserMaterials.add(m)); originals.set(part, Array.isArray(original) ? original.map(m => m.clone()) : original.clone());
      // Instances share geometry but need independent appearance when selected.
      part.material = Array.isArray(original) ? original.map(m => m.clone()) : original.clone();
    });
    parserMaterials.forEach(m => m.dispose());
    studio.scene.add(model);
    parts.forEach((part, i) => {
      const option = document.createElement('option'); option.value = String(i); option.textContent = `${i + 1}. ${part.name}`;
      $('studioParts').append(option);
    });
    $('studioPartCount').textContent = `(${parts.length})`;
    $('studioCapture').disabled = false;
    $('studioReset').onclick(); fit(studio, model, studio.controls); draw();
    const dimensions = [loaded.size.x,loaded.size.z,loaded.size.y].map(n => n.toFixed(1)).join(' × ');
    $('studioDimensions').textContent=`${dimensions} mm · ${loaded.triangles.toLocaleString()} triangles`;
    $('studioVolume').textContent='Calculating estimated solid volume…';
    $('studioStatus').textContent = `${loaded.triangles.toLocaleString()} triangles · ${dimensions} mm (STL/OBJ/PLY units assumed mm)` +
      (model.userData.warnings?.length ? ' · ' + model.userData.warnings.join(' ') : '');
    analyze(model,{signal:abort.signal}).then(async result=>{
      if(serial!==generation||!dialog.open)return;
      $('studioVolume').textContent=`Estimated solid volume: ${(result.volume/1000).toFixed(3)} cm³ · ${result.closed?'Closed, consistently wound mesh':'Mesh closure not verified; estimate may be inaccurate'}`;
      const response=await fetch('/api/geometry',{method:'POST',headers:{'X-Auth':token,'Content-Type':'application/json'},body:JSON.stringify({path:meta.path,stamp:loaded.stamp,...result})});
      if(!response.ok)console.warn('Inspection could not be cached');
    }).catch(error=>{if(serial===generation&&error.name!=='AbortError')$('studioVolume').textContent='Volume estimate unavailable: '+error.message});

  } catch (err) {
    if (serial === generation && err.name !== 'AbortError') $('studioStatus').textContent = err.message;
  }
}
