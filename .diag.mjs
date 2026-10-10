process.on('unhandledRejection', () => {});
import fs from 'fs'; import path from 'path'; import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { clone as skClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
const ROOT = '/home/user/1';
const AS = path.join(ROOT, 'public/assets');
global.self = global; global.window = global; global.document = { createElementNS: () => ({ style:{}, getContext: () => null }), createElement: () => ({ style:{}, getContext: () => null }) };
const loader = new GLTFLoader();
const draco = new DRACOLoader();
let manifest;
const origParse = loader.parse.bind(loader);
loader.parse = (buf, p2, onLoad, onErr) => { try { origParse(buf, p2, onLoad, onErr); } catch (e) { onErr && onErr(e); } };
const models = new Map();
const MAN = JSON.parse(fs.readFileSync(path.join(AS, 'manifest.json'), 'utf8'));
for (const [grp, entries] of Object.entries(MAN.models)) {
 for (const [k, rel] of Object.entries(entries)) {
  const f = path.join(AS, rel);
  if (!fs.existsSync(f)) continue;
  const buf = fs.readFileSync(f);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try { models.set(grp + '/' + k, await new Promise((r, j) => loader.parse(ab, '', r, j))); } catch {}
 }
}
const assetsShim = { model: (g, k) => { const m = models.get(g + '/' + k) || models.get(k); return m ? skClone(m.scene) : null; }, group: () => ({}), tex: () => null, modelNames: () => [] };
global.window.__assets = assetsShim;
const { Character } = await import(path.join(ROOT, 'src/entities/character.js'));
const scene = new THREE.Scene();
const c = new Character(scene, 'soldier', assetsShim, { height: 1.78 });
c.root.position.set(0, 0, 0);
scene.updateMatrixWorld(true);
const hand = c.bones.handR;
const s = new THREE.Vector3(), pos = new THREE.Vector3(), q = new THREE.Quaternion();
hand.matrixWorld.decompose(pos, q, s);
console.log('model scale', c.model.scale.toArray().map(v=>v.toFixed(3)).join(','));
console.log('hand world pos', pos.toArray().map(v=>v.toFixed(2)).join(','), 'scale', s.toArray().map(v=>v.toFixed(2)).join(','));
console.log('root scale', c.root.scale.toArray().join(','), 'model parent chain:', (()=>{let o=c.model,p=[];while(o){p.push(o.type+':'+(o.name||'')+' s='+o.scale.x.toFixed(2));o=o.parent;}return p.join(' | ');})());
const bb = new THREE.Box3().setFromObject(c.model);
console.log('bbox', bb.min.toArray().map(v=>v.toFixed(2)).join(','), '->', bb.max.toArray().map(v=>v.toFixed(2)).join(','), 'height', (bb.max.y-bb.min.y).toFixed(2));
