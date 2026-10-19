/* 3MF core meshes + production component references. Everything stays in memory;
   no ZIP entries or material URLs are extracted to the filesystem or network. */
import * as THREE from 'three';
import {decodePaint, paintedFacets} from './paint3mf.js';
import {unzipSync, strFromU8} from 'three/addons/libs/fflate.module.js';

const children = (node, name) => Array.from(node?.children || []).filter(n => n.localName === name);
const child = (node, name) => children(node, name)[0];
const attr = (node, name) => Array.from(node.attributes).find(a => a.localName === name)?.value;
const units = {micron: .001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000};

function xml(bytes) {
  const doc = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML in this 3MF package.');
  return doc.documentElement;
}
function packagePath(target, from = '') {
  if (!target || /[?#]/.test(target) || /^[a-z]+:/i.test(target)) throw new Error('Unsupported 3MF package reference.');
  let decoded;
  try { decoded = decodeURIComponent(target.replaceAll('\\', '/')); } catch (_) { throw new Error('Invalid package path'); }
  const parts = (decoded.startsWith('/') ? decoded.slice(1) : from + decoded).split('/');
  const result = [];
  for (const part of parts) {
    if (part === '..') { if (!result.length) throw new Error('3MF reference escapes the package.'); result.pop(); }
    else if (part && part !== '.') result.push(part);
  }
  return result.join('/');
}
function matrix(text, unit) {
  if (!text) return new THREE.Matrix4();
  const t = text.trim().split(/\s+/).map(Number);
  if (t.length !== 12 || !t.every(Number.isFinite)) throw new Error('Invalid 3MF component transform.');
  return new THREE.Matrix4().set(t[0], t[3], t[6], t[9] * unit,
    t[1], t[4], t[7], t[10] * unit, t[2], t[5], t[8], t[11] * unit, 0, 0, 0, 1);
}

export function parse3MF(buffer) {
  const archive = unzipSync(new Uint8Array(buffer), {filter: file => /\.(model|rels|config)$/i.test(file.name)});
  if (!archive['_rels/.rels']) throw new Error('The 3MF package has no root relationships.');
  const rel = children(xml(archive['_rels/.rels']), 'Relationship').find(r => (r.getAttribute('Type') || '').endsWith('/3dmodel'));
  if (!rel) throw new Error('The 3MF package has no model relationship.');
  const rootPath = packagePath(rel.getAttribute('Target'));
  const documents = new Map(), definitions = new Map(), meshCache = new Map(), settings = new Map();
  let triangles = 0, instances = 0, expandedTriangles = 0;
  const warnings = new Set(), extruders = new Map(), paintTrees = new Map();
  const validColor = value => typeof value === 'string' && /^#[\da-f]{6}([\da-f]{2})?$/i.test(value);
  let filaments = [];
  if (archive['Metadata/project_settings.config']) {
    try {
      const config = JSON.parse(strFromU8(archive['Metadata/project_settings.config']));
      const values = config.filament_colour || config.extruder_colour || [];
      if (Array.isArray(values)) filaments = values.map(v => validColor(v) ? new THREE.Color(v.slice(0,7)) : null);
    } catch (_) { warnings.add('The slicer filament palette could not be read.'); }
  }
  // PrusaSlicer stores its palette in a text config rather than project JSON.
  if (!filaments.length && archive['Metadata/Slic3r_PE.config']) {
    const text = strFromU8(archive['Metadata/Slic3r_PE.config']);
    const match = text.match(/^;?\s*extruder_colour\s*=\s*(.+)$/m);
    if (match) filaments = match[1].trim().split(';').map(v => validColor(v) ? new THREE.Color(v.slice(0,7)) : null);
  }
  const painting = face => face.getAttribute('paint_color') || face.getAttribute('slic3rpe:mmu_segmentation') || face.getAttribute('mmu_segmentation');
  function paintTree(text) {
    if (!paintTrees.has(text)) {
      try { paintTrees.set(text, decodePaint(text)); }
      catch (_) { paintTrees.set(text, {state: 0, leaves: 1}); warnings.add('Some invalid facet painting was shown using the part colour.'); }
    }
    return paintTrees.get(text);
  }
  function readExtruder(node, key) {
    const value = Number(children(node, 'metadata').find(n => n.getAttribute('key') === 'extruder')?.getAttribute('value'));
    if (Number.isInteger(value) && value > 0) extruders.set(key, value);
  }
  if (archive['Metadata/model_settings.config']) {
    const config = xml(archive['Metadata/model_settings.config']);
    for (const object of children(config, 'object')) {
      const id = object.getAttribute('id');
      const name = children(object, 'metadata').find(n => n.getAttribute('key') === 'name')?.getAttribute('value');
      settings.set('object:' + id, name);
      readExtruder(object, 'object:' + id);
      for (const part of children(object, 'part')) {
        readExtruder(part, `part:${id}:${part.getAttribute('id')}`);
        settings.set(`part:${id}:${part.getAttribute('id')}`, children(part, 'metadata').find(n => n.getAttribute('key') === 'name')?.getAttribute('value'));
      }
    }
  }
  function document(path) {
    if (documents.has(path)) return documents.get(path);
    if (!archive[path]) throw new Error('Missing 3MF component: ' + path);
    const model = xml(archive[path]);
    if (model.localName !== 'model') throw new Error('Invalid 3MF model document.');
    const unit = units[model.getAttribute('unit') || 'millimeter'];
    if (!unit) throw new Error('Unsupported 3MF unit.');
    const resources = child(model, 'resources');
    const info = {model, unit, resources}; documents.set(path, info);
    for (const object of children(resources, 'object')) definitions.set(path + '#' + object.getAttribute('id'), object);
    if (Array.from(resources?.children || []).some(n => ['texture2d', 'texture2dgroup', 'multiproperties'].includes(n.localName))) {
      warnings.add('Textures and advanced material extensions use a neutral preview material.');
    }
    if (model.getAttribute('requiredextensions')) warnings.add('Some 3MF extensions may be shown as core geometry only.');
    return info;
  }
  function mesh(path, id, object, extruder) {
    const key = path + '#' + id + ':' + extruder;
    if (meshCache.has(key)) return meshCache.get(key);
    const info = document(path), data = child(object, 'mesh');
    const vertices = children(child(data, 'vertices'), 'vertex').map(v => {
      const point = ['x','y','z'].map(k => Number(v.getAttribute(k)) * info.unit);
      if (!point.every(Number.isFinite)) throw new Error('Invalid 3MF vertex.');
      return point;
    });
    const faces = children(child(data, 'triangles'), 'triangle');
    triangles += faces.length;
    if (triangles > 5000000) throw new Error('Preview limit: 5 million triangles.');
    let rendered = 0;
    for (const face of faces) {
      const paint = painting(face); rendered += paint ? paintTree(paint).leaves : 1;
      if (rendered > 5000000) throw new Error('Preview limit: 5 million painted triangles.');
    }
    const positions = new Float32Array(rendered * 9), colors = new Float32Array(rendered * 9);
    const palette = new Map(); let hasColor = false;
    for (const resource of Array.from(info.resources.children)) {
      const values = Array.from(resource.children).map(n => n.getAttribute('displaycolor') || n.getAttribute('color'));
      if (values.some(Boolean)) palette.set(resource.getAttribute('id'), values);
    }
    const neutral = new THREE.Color('#82b8ed');
    const defaultColor = filaments[extruder - 1];
    let offset = 0;
    for (const face of faces) {
      const points = ['v1','v2','v3'].map(key => {
        const raw = face.getAttribute(key), vi = Number(raw);
        if (raw === null || !Number.isInteger(vi) || !vertices[vi]) throw new Error('Invalid 3MF triangle index.');
        return vertices[vi];
      });
      const paint = painting(face);
      if (paint) {
        if (!filaments.some(Boolean)) warnings.add('Facet painting is present, but the file has no readable filament palette.');
        paintedFacets(paintTree(paint), points, (triangle, state) => {
          const color = (state ? filaments[state - 1] : defaultColor) || defaultColor || neutral;
          if (state && !filaments[state - 1]) warnings.add('Some painted filament colours are missing from the file.');
          hasColor = hasColor || color !== neutral;
          for (const point of triangle) { positions.set(point, offset); color.toArray(colors, offset); offset += 3; }
        });
      } else {
        const pid = face.getAttribute('pid') || object.getAttribute('pid');
        const fallback = face.getAttribute('p1') || object.getAttribute('pindex') || '0';
        points.forEach((point, j) => {
          const value = palette.get(pid)?.[Number(face.getAttribute('p' + (j + 1)) || fallback)];
          const color = validColor(value) ? new THREE.Color(value.slice(0,7)) : defaultColor || neutral;
          hasColor = hasColor || color !== neutral;
          positions.set(point, offset); color.toArray(colors, offset); offset += 3;
        });
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (hasColor) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({color: hasColor ? 0xffffff : 0x82b8ed, vertexColors: hasColor, roughness: .65, side: THREE.DoubleSide});
    const result = new THREE.Mesh(geometry, material); meshCache.set(key, result); return result;
  }
  function build(path, id, stack = [], parentId = id, inheritedExtruder = 1) {
    const key = path + '#' + id;
    if (stack.includes(key) || stack.length > 64) throw new Error('Cyclic or excessively nested 3MF components.');
    if (++instances > 10000) throw new Error('Preview limit: 10,000 component instances.');
    const info = document(path), object = definitions.get(key);
    if (!object) throw new Error('Missing 3MF object: ' + key);
    const extruder = extruders.get(`part:${parentId}:${id}`) || extruders.get('object:' + id) || inheritedExtruder;
    const group = new THREE.Group();
    group.name = settings.get('object:' + id) || object.getAttribute('name') || 'Object ' + id;
    group.userData = {objectId: id, modelPath: path};
    if (child(object, 'mesh')) {
      const part = mesh(path, id, object, extruder).clone();
      expandedTriangles += part.geometry.attributes.position.count / 3;
      if (expandedTriangles > 5000000) throw new Error('Preview limit: 5 million instanced triangles.');
      const partKey = `part:${parentId}:${id}`, objectKey = 'object:' + parentId;
      part.name = settings.get(partKey) || object.getAttribute('name') || group.name;
      part.userData = {objectId: id, modelPath: path,
        editKey: settings.has(partKey) ? partKey : settings.has(objectKey) ? objectKey : null};
      group.add(part);
    }
    for (const component of children(child(object, 'components'), 'component')) {
      const target = attr(component, 'path');
      const nextPath = target ? packagePath(target, path.slice(0, path.lastIndexOf('/') + 1)) : path;
      const nested = build(nextPath, component.getAttribute('objectid'), [...stack, key], parentId, extruder);
      nested.applyMatrix4(matrix(component.getAttribute('transform'), info.unit)); group.add(nested);
    }
    return group;
  }
  try {
    const info = document(rootPath), result = new THREE.Group();
    const items = children(child(info.model, 'build'), 'item');
    for (const item of items) {
      if (item.getAttribute('printable') === '0') continue;
      const id = item.getAttribute('objectid');
      const target = attr(item, 'path');
      const path = target ? packagePath(target, rootPath.slice(0, rootPath.lastIndexOf('/') + 1)) : rootPath;
      const group = build(path, id); group.applyMatrix4(matrix(item.getAttribute('transform'), info.unit)); result.add(group);
    }
    result.userData.warnings = [...warnings];
    return result;
  } catch (error) {
    for (const mesh of meshCache.values()) { mesh.geometry.dispose(); mesh.material.dispose(); }
    throw error;
  }
}
