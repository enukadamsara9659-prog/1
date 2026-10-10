/**
 * build-assets.mjs
 * ---------------------------------------------------------------------------
 * Turns the raw CC0 sources in .cache/asset-src into the optimised asset set
 * the game loads at runtime (public/assets + public/assets/manifest.json).
 *
 *   textures -> 1K, and (normal.rg + roughness) packed into one image so the
 *               terrain shader only needs 2 samplers per layer.
 *   models   -> copied / renamed (no spaces) and grouped into a manifest.
 *
 * Run:  node scripts/build-assets.mjs            (after scripts/fetch-sources.sh)
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const HOME = process.env.HOME || '/home/user';
const SRC = path.join(HOME, '.cache/asset-src');
const OUT = path.resolve('public/assets');
const TEX = path.join(OUT, 'tex');

const log = (...a) => console.log('•', ...a);
const ensure = (d) => fs.mkdirSync(d, { recursive: true });
const safe = (s) =>
  s
    .replace(/\s+/g, '_')
    .replace(/[()'"]/g, '')
    .toLowerCase();

ensure(OUT);
ensure(path.join(TEX, 'terrain'));
ensure(path.join(TEX, 'surf'));
ensure(path.join(TEX, 'sprites'));
ensure(path.join(OUT, 'env'));
ensure(path.join(OUT, 'models'));

const manifest = { models: {}, tex: { terrain: {}, surf: {} }, env: {}, sprites: {} };

/* ------------------------------------------------------------------ copy ---- */
function copyGroup(name, srcDir, filter = () => true, rename = safe) {
  if (!fs.existsSync(srcDir)) {
    console.warn(`  ! missing ${srcDir}`);
    return {};
  }
  const dstDir = path.join(OUT, 'models', name);
  ensure(dstDir);
  const map = {};
  for (const f of fs.readdirSync(srcDir).sort()) {
    if (!f.toLowerCase().endsWith('.glb')) continue;
    if (!filter(f)) continue;
    const key = rename(f.replace(/\.glb$/i, ''));
    fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, key + '.glb'));
    map[key] = `models/${name}/${key}.glb`;
  }
  manifest.models[name] = map;
  log(`${name}: ${Object.keys(map).length} models`);
  return map;
}

/* --------------------------------------------------------------- textures ---- */
async function packTexture(setDir, base, outName, size = 1024) {
  const find = (suffix) => {
    const cands = fs
      .readdirSync(setDir)
      .filter((f) => f.startsWith(base) && f.includes(suffix) && f.toLowerCase().endsWith('.jpg'));
    return cands.length ? path.join(setDir, cands[0]) : null;
  };
  const color = find('_Color');
  const normal = find('_NormalGL') || find('_NormalDX');
  const rough = find('_Roughness');
  if (!color) throw new Error(`no color map for ${base} in ${setDir}`);

  await sharp(color).resize(size, size, { fit: 'cover' }).jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(TEX, outName + '_color.jpg'));

  if (normal && rough) {
    const n = await sharp(normal).resize(size, size, { fit: 'cover' }).removeAlpha().raw().toBuffer();
    const r = await sharp(rough).resize(size, size, { fit: 'cover' }).grayscale().raw().toBuffer();
    const packed = Buffer.allocUnsafe(size * size * 3);
    for (let i = 0; i < size * size; i++) {
      packed[i * 3 + 0] = n[i * 3 + 0];
      packed[i * 3 + 1] = n[i * 3 + 1];
      packed[i * 3 + 2] = r[i];
    }
    await sharp(packed, { raw: { width: size, height: size, channels: 3 } })
      .jpeg({ quality: 80, chromaSubsampling: '4:4:4' })
      .toFile(path.join(TEX, outName + '_nr.jpg'));
    return true;
  }
  return false;
}

/* ============================================================================ */
async function main() {
  log('building assets →', OUT);

  /* ---- characters & creatures (three.js examples, CC0/CC-BY per repo) ---- */
  const threeM = path.join(SRC, 'three/examples/models/gltf');
  const chars = path.join(OUT, 'models/characters');
  ensure(chars);
  const charMap = {
    soldier: 'Soldier.glb',
    xbot: 'Xbot.glb',
    michelle: 'Michelle.glb',
    robot: 'RobotExpressive/RobotExpressive.glb',
    horse: 'Horse.glb',
    parrot: 'Parrot.glb',
    flamingo: 'Flamingo.glb',
    stork: 'Stork.glb',
  };
  for (const [k, f] of Object.entries(charMap)) {
    const src = path.join(threeM, f);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(chars, k + '.glb'));
    (manifest.models.characters ||= {})[k] = `models/characters/${k}.glb`;
  }
  log('characters:', Object.keys(manifest.models.characters || {}).length);

  /* ---- weapons (flat-shaded kit) ---- */
  const wdir = path.join(SRC, 'fpsk/weapons/flat_guns_east/Flat Guns East/GLB');
  const wsrc = fs.existsSync(wdir) ? wdir : path.join(SRC, 'fpsk/weapons/flat_guns_east/Flat Guns East/GLB'.replace(' ', ' '));
  const wmap = {
    rifle_assault: 'Rifle_Assault_East.glb',
    rifle_battle: 'Rifle_Battle_East.glb',
    smg: 'SMG_Full_East.glb',
    smg_compact: 'SMG_Compact_East.glb',
    shotgun: 'Shotgun_Pump_East.glb',
    shotgun_auto: 'Shotgun_Auto_East.glb',
    sniper: 'Sniper_Rifle_East.glb',
    sniper_material: 'Sniper_Material_East.glb',
    pistol: 'Pistol_Full_East.glb',
    pistol_compact: 'Pistol_Compact_East.glb',
  };
  const wdst = path.join(OUT, 'models/weapons');
  ensure(wdst);
  for (const [k, f] of Object.entries(wmap)) {
    const src = path.join(wsrc, f);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(wdst, k + '.glb'));
    (manifest.models.weapons ||= {})[k] = `models/weapons/${k}.glb`;
  }
  log('weapons:', Object.keys(manifest.models.weapons || {}).length);

  /* ---- vegetation (PolyPizza stylised nature, CC0) ---- */
  const vegSrc = path.join(SRC, 'envk/environment/vegetation/polypizza-stylized-nature-gltf');
  copyGroup('nature', vegSrc, (f) => !/-[A-Za-z0-9]{10}\.glb$/.test(f)); // skip duplicate variants

  /* ---- Kenney kits (CC0) ---- */
  const K = path.join(SRC, 'kenney/3d');
  copyGroup('town', path.join(K, 'fantasy-town'));
  copyGroup('castle', path.join(K, 'castle'));
  copyGroup('graveyard', path.join(K, 'graveyard'));
  copyGroup('kenney_nature', path.join(K, 'nature'), (f) =>
    /^(tree|rock|cliff|plant|flower|grass|log|stump|bridge|mushroom|path|statue|campfire|tent|ground)/i.test(f)
  );
  copyGroup('props', path.join(K, 'survival'));
  copyGroup('weaponkit', path.join(K, 'weapon'));
  copyGroup('miniforest', path.join(K, 'mini-forest'));

  /* ---- terrain layers: grass / dirt / rock / snow ---- */
  const envkTex = path.join(SRC, 'envk/environment/ground-textures/ambientcg');
  const fpskTex = path.join(SRC, 'fpsk/textures');
  const threeTex = path.join(SRC, 'three/examples/textures');

  await packTexture(path.join(envkTex, 'Grass004_2K-JPG'), 'Grass004_2K-JPG', 'terrain/grass');
  await packTexture(path.join(fpskTex, 'Ground037'), 'Ground037_2K-JPG', 'terrain/dirt');
  await packTexture(path.join(fpskTex, 'Rock058'), 'Rock058_2K-JPG', 'terrain/rock');
  await packTexture(path.join(threeTex, 'ambientcg'), 'Ice002_1K-JPG', 'terrain/snow', 1024);
  manifest.tex.terrain = {
    grass: { color: 'tex/terrain/grass_color.jpg', nr: 'tex/terrain/grass_nr.jpg' },
    dirt: { color: 'tex/terrain/dirt_color.jpg', nr: 'tex/terrain/dirt_nr.jpg' },
    rock: { color: 'tex/terrain/rock_color.jpg', nr: 'tex/terrain/rock_nr.jpg' },
    snow: { color: 'tex/terrain/snow_color.jpg', nr: 'tex/terrain/snow_nr.jpg' },
  };

  /* ---- surface materials for buildings / props ---- */
  const surfSets = [
    [path.join(fpskTex, 'Plaster001'), 'Plaster001_2K-JPG', 'plaster'],
    [path.join(fpskTex, 'Wood092'), 'Wood092_2K-JPG', 'wood'],
    [path.join(fpskTex, 'Bricks097'), 'Bricks097_2K-JPG', 'brick'],
    [path.join(fpskTex, 'Concrete034'), 'Concrete034_2K-JPG', 'concrete'],
    [path.join(fpskTex, 'Metal049A'), 'Metal049A_2K-JPG', 'metal'],
    [path.join(envkTex, 'Road001_2K-JPG'), 'Road001_2K-JPG', 'road'],
    [path.join(fpskTex, 'Rock063'), 'Rock063_2K-JPG', 'stone'],
    [path.join(fpskTex, 'Asphalt023S'), 'Asphalt023S_2K-JPG', 'asphalt'],
  ];
  for (const [dir, base, name] of surfSets) {
    if (!fs.existsSync(dir)) continue;
    await packTexture(dir, base, 'surf/' + name, 1024);
    manifest.tex.surf[name] = { color: `tex/surf/${name}_color.jpg`, nr: `tex/surf/${name}_nr.jpg` };
  }

  /* ---- water normals + sprites ---- */
  fs.copyFileSync(path.join(threeTex, 'waternormals.jpg'), path.join(TEX, 'waternormals.jpg'));
  manifest.waternormals = 'tex/waternormals.jpg';
  fs.copyFileSync(path.join(threeTex, 'terrain/grasslight-big.jpg'), path.join(TEX, 'grass_detail.jpg'));
  manifest.grassDetail = 'tex/grass_detail.jpg';

  for (const s of ['circle.png', 'disc.png', 'spark1.png', 'snowflake1.png', 'snowflake5.png', 'smokeparticle.png', 'ball.png']) {
    const p = path.join(threeTex, 'sprites', s);
    if (fs.existsSync(p)) {
      fs.copyFileSync(p, path.join(TEX, 'sprites', s));
      manifest.sprites[s.replace('.png', '')] = `tex/sprites/${s}`;
    }
  }

  /* ---- HDRI environment maps ---- */
  const hdriSrc = path.join(SRC, 'envk/environment/skyboxes/polyhaven-hdri');
  if (fs.existsSync(hdriSrc)) {
    for (const f of fs.readdirSync(hdriSrc).filter((x) => x.endsWith('.hdr') && x.startsWith('kloppenheim_02'))) {
      fs.copyFileSync(path.join(hdriSrc, f), path.join(OUT, 'env', f));
      manifest.env[f.replace('.hdr', '')] = `env/${f}`;
    }
  }
  const threeEnv = path.join(threeTex, 'equirectangular');
  for (const f of ['venice_sunset_1k.hdr', 'spruit_sunrise_1k.hdr', 'moonless_golf_1k.hdr', 'quarry_01_1k.hdr']) {
    const p = path.join(threeEnv, f);
    if (fs.existsSync(p)) {
      fs.copyFileSync(p, path.join(OUT, 'env', f));
      manifest.env[f.replace('.hdr', '')] = `env/${f}`;
    }
  }
  log('hdris:', Object.keys(manifest.env).length);

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  log('manifest written');
  const size = Number(
    (await import('node:child_process')).execSync(`du -sk ${OUT}`).toString().split('\t')[0]
  );
  log(`total asset size: ${(size / 1024).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
