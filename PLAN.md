# 🌍 AETHERFALL — සම්පූර්ණ සැලැස්ම (Master Plan)

> **AETHERFALL: Cradle of Ash** — open‑world, third‑person, squad‑based action RPG.
> Engine: **three.js (WebGL2)** + **Vite**. 100% browser, 100% CC0 assets.

---

## 1. කතාව (Premise)

අහස පැළෙන වේගයෙන් **උල්කාපාතයක් (meteor)** කඳුවැටියට කඩා වැටේ.
ඒත් එක්කම ආවේ ගිනි පමණක් නෙවෙයි — **"Spawn"** කියන පිටසක්වල ජීවීන්.
Game එක පටන් ගන්නෙ ඒ පිපිරීමෙන් පස්සෙ, දුම් දමන ආවාටය (crater) අයිනෙ ඉඳන්.

* ලෝකය පුරාම **nests (කූඩු)** — උල්කාපාතයෙන් පැතිරුණු ජීවීන් ඉන්න තැන්.
* ඒවා විනාශ කරන්න ඕන — නැත්නම් ගම්මාන විනාශ වෙනවා.
* ඔබ තනියම නෙවෙයි: **4 දෙනෙක්ගෙන් හැදුණු squad එකක්** (ගැහැණු + පිරිමි) ඔබත් එක්ක යනවා.
* අන්තිමට: **Hive Tyrant** (boss) — විශාලම nest එකේ.

---

## 2. ලෝකය (The World) — 8 km × 8 km seamless open world

| Layer | විස්තරය | තාක්ෂණය |
|---|---|---|
| **Terrain** | 2049² heightfield (4 m/px), fbm + ridged noise + domain warp + **hydraulic erosion** | Web Worker (off main thread) |
| **Meteor crater** | 220 m wide impact basin + raised rim + ejecta + scorch + shockwave ring | radial falloff carve |
| **Mountains** | ridged-multifractal ranges up to ~900 m, snow caps | noise + height curve |
| **Rivers** | 6 සැබෑ ගංගා — gradient-descent downhill paths → lakes → sea, carved channels | spline carve + flow shader |
| **Water** | ocean + lakes + flowing rivers | Gerstner waves, fresnel, depth‑fade, foam, sky reflection, flow‑map normals |
| **Biomes** | beach / grassland / forest / savanna / alpine rock / snow / swamp / volcanic ash | splat‑map (RGBA weights) |
| **Vegetation** | ~150 000 instanced props (trees, pines, dead trees, bushes, ferns, flowers, mushrooms, rocks, pebbles, grass clumps) | per‑chunk `InstancedMesh` + distance impostors + wind shader |
| **Roads** | villages/temples/palace සම්බන්ධ කරන terrain‑conforming roads | spline ribbon + PBR road texture |
| **POIs** | 6 villages, 3 temples, 1 royal palace, 12 camps, 9 ruins, 1 monastery, watchtowers, bridges, docks | procedural architecture from modular kits |

**Terrain rendering**: heightfield එක `DataTexture` (R32F) එකකට දාලා **vertex‑texture‑fetch** වලින් displace කරනවා.
ඒ නිසා chunk එකක geometry එක සරල flat grid එකක් විතරයි → **LOD 4 level** (256/128/64/32) instantly මාරු කරන්න පුළුවන්, CPU cost එක 0 යි.
Cracks වහන්න LOD skirt (border verts පහළට ඇදලා) පාවිච්චි කරනවා.

**Terrain material**: `MeshStandardMaterial` + `onBeforeCompile` → 4 layer PBR splat
(grass / dirt‑forest / rock / snow‑sand) — එක layer එකකට texture 2 යි (color + packed **normal.rg + roughness**).
Triplanar detail noise, slope‑based blend, macro colour variation, wetness near water.

---

## 3. Graphics / “AAA look” pipeline

```
Sky (analytic Rayleigh+Mie)  ─┐
Volumetric clouds (raymarch) ─┼─► PMREM env cubemap ─► IBL on everything
Sun/Moon/Stars               ─┘
        │
        ▼
  Scene render (MRT‑less, depthTexture attached)
    • 3-cascade shadow maps (60 m / 220 m / 1200 m)
    • CSM-style stable texel snapping
        │
        ▼
  PostFX composer
    1. GTAO (ground-truth ambient occlusion)
    2. TAA (temporal anti-aliasing + jitter) — fallback SMAA/FXAA
    3. Bloom (UnrealBloom, thresholded, lens dirt)
    4. Depth of field (bokeh, near+far)
    5. Volumetric god-rays / light shafts
    6. Colour grading: ACES filmic tonemap + LUT + exposure/contrast/saturation
    7. Vignette + chromatic aberration + film grain + motion blur
    8. OutputPass (sRGB)
```

**Weather & time**: 24‑min full day cycle, dynamic sun/moon, volumetric fog,
rain (GPU particles + wetness + ripples), snow, dust storms, thunder + lightning flashes,
wind that drives vegetation + clouds + rain direction.

**Particles**: pooled systems — muzzle flash, tracers, impacts (dirt/stone/wood/metal/flesh),
blood/ichor, explosions, embers, fire, smoke columns, rain, snow, dust, footprints,
shell casings (physical), loot pickups, level‑up burst.

**Decals**: pooled projector decals — bullet holes, scorch marks, craters, ichor splats.

---

## 4. Characters

| Role | Model (CC0 source) | Animations |
|---|---|---|
| **Main character** | three.js `Soldier.glb` (retargeted) | Idle / Walk / Run / Sprint + procedural upper body (aim, recoil, reload) |
| **Companion – Assault (♂)** | `Xbot.glb` re‑skinned | retargeted Idle/Walk/Run + combat poses |
| **Companion – Marksman (♀)** | `Michelle.glb` (textured) | **retargeted** from Soldier via `SkeletonUtils.retargetClip` |
| **Companion – Support/Medic (♀)** | `Soldier.glb` variant (tint + gear) | full set |
| **Companion – Engineer (♂)** | `Xbot.glb` variant (tint + gear) | full set |
| **Sentinel enemy** | `RobotExpressive.glb` | Idle / Walking / Running / **Punch** / **Death** / Jump |
| **Wildlife** | `Horse.glb`, `Parrot.glb`, `Flamingo.glb`, `Stork.glb` | baked clips |
| **NPCs** | kit‑bashed (villager/elder/blacksmith/priest/merchant) | idle + talk gestures |

Procedural creatures (built in code from organic primitives, with skeletal‑free part animation):
**Spawnling** (fast swarmer), **Brute** (armoured), **Spitter** (ranged acid),
**Wraith** (floating caster), **Hive Tyrant** (boss, 3 phases, summons).

---

## 5. Combat & Weapons

* **Third‑person** shooter with **first‑person ADS** toggle.
* Weapons (real GLB models, PBR‑re‑textured with metal/wood/plaster PBR maps):
  Assault Rifle · Battle Rifle · SMG · Shotgun · Sniper · Pistol · **Plasma Repeater** · **Grenade Launcher**.
* Each weapon has **stats**: damage, RPM, magazine, spread (hip/ADS), recoil pattern,
  range + falloff, reload time, zoom, penetration, projectile type, weight (affects sway/move speed).
* **Unlimited reserve ammo** (magazine reloading still applies), as requested.
* Hitscan with tracers + **bullet drop option for sniper**, shotgun pellets, rockets with splash.
* Head‑shots (×crit), weak points (glowing cores on creatures), stagger, knockback,
  dismemberment‑lite (limb break on Brutes), death animations + dissolve.
* Weapon mods (scope/extended mag/suppressor/heavy barrel) via crafting.
* Melee: kick, stamina, finisher on staggered enemies, **executions** with camera punch.

---

## 6. Squad system

* 4 companions with **class roles**: Assault, Marksman, Medic, Engineer.
* AI: formation follow (wedge/line), cover points, target prioritisation, focus fire on
  your marked target, suppressive fire, revive downed player, healing, deployable turret.
* Orders: **Follow / Hold position / Regroup / Focus target / Fall back** (keys 1‑5 + radial wheel).
* Banter + contextual voice subtitles, per‑companion personality.
* Companions level up with you and get skill points.

---

## 7. Enemies & Nests

* **Nests**: 34 organic pods scattered by biome; each spawns guards, respawns over time,
  and corrupts terrain (dark ichor + dead vegetation + red fog) within a radius.
  Destroy a nest → area cleansed (visually!), XP + cores + map update.
* **Directors**: a light AI director controls ambient pressure — patrol groups,
  wandering packs, ambushes at POIs, hunt squads sent after you at high threat.
* Enemy AI states: Idle → Patrol → Alert → Chase → Strafe/Attack → Stagger → Flee(enrage) → Dead.
  Steering: flow‑field over heightfield + obstacle boxes, group separation, flank slot allocation.

---

## 8. Progression, Quests, UI

* **XP / Levels / Skill tree** (3 branches: Combat · Survival · Squad), respec anytime.
* **Loot**: meteor cores, crafting parts, weapon mods, consumables (medkit, stim, grenade, trap).
* **Main quest** (7 acts) + procedural side quests (clear nest, rescue, escort, bounty, delivery).
* **Map**: minimap (fog‑of‑war, markers, compass) + fullscreen world map with filters & fast travel.
* **HUD**: health/shield/stamina, dynamic crosshair, hit markers, damage numbers, kill feed,
  weapon + ammo, squad status, quest tracker, threat meter, notifications.
* **Menus**: main menu (live 3D cinematic background), loading with tips, pause, settings
  (presets Low→Ultra, resolution scale, FOV, sensitivity, audio, keybinds), inventory, skills, journal.
* **Save/Load** to `localStorage`, autosave + manual, plus world‑state persistence (nests, loot, corpses).

---

## 9. Audio (100% procedural — zero bytes shipped)

WebAudio synthesis graph: gunshots (noise burst + band‑pass + pitch envelope + distortion),
explosions, footsteps by surface, creature growls (FM), wind, birds, insects, water,
UI, ambient pads, adaptive combat music (layers by threat).

---

## 10. Asset pipeline (real CC0 assets, downloaded from the web)

Sources fetched by `scripts/fetch-sources.sh` + processed by `scripts/build-assets.mjs`:

| Source | Use |
|---|---|
| `mrdoob/three.js` (`examples/models/gltf`, `examples/textures`) | rigged characters (Soldier, Xbot, Michelle, RobotExpressive), animals, HDRIs, sprites, water normals, terrain grass |
| `shorepine/kenney` (`3d/fantasy-town`, `3d/castle`, `3d/nature`, `3d/weapon`, `3d/graveyard`, `3d/mini-forest`, `3d/survival`, `3d/road`, `3d/city-suburban`) | village/castle/temple modules, props, rocks, trees, weapons, bridges |
| `petroulacl/fps-asset-kit` (ambientCG 2K PBR + “Flat Guns East”) | ground/rock/concrete/plaster/wood/metal/brick PBR maps + assault/SMG/sniper/shotgun/pistol GLBs |
| `petroulacl/fps-buildings-env-kit` (PolyPizza stylised nature, PolyHaven HDRIs) | trees, pines, dead trees, bushes, ferns, flowers, mushrooms, rocks, pebbles, grass |

Textures are **downscaled to 1K, channel‑packed (normal.rg + roughness) and re‑encoded**
so the whole game ships in a few tens of MB.

---

## 11. Architecture

```
src/
  core/     engine · input · assets · settings · save · events · rng · pool
  world/    worldgen(worker) · terrain · water · sky · clouds · weather
            vegetation · structures · roads · crater · nests · props
  entities/ character · player · squad · enemies · creatures · npc
  combat/   weapons · projectiles · damage
  fx/       particles · decals · postfx · screenfx
  ui/       hud · minimap · worldmap · menus · quests · inventory · skills
  audio/    audio (WebAudio synth)
  data/     config · weapons · enemies · quests · skills
```

Performance budget (High preset @1080p): ~2.5–4 ms CPU + ~8–11 ms GPU → **60 fps**.
Adaptive resolution scaler keeps it smooth on weaker machines.

---

## 12. Build order (what ships in this session)

1. ✅ Asset pipeline (fetch + process) & project scaffold
2. Engine core + PostFX + Sky + Terrain + Water
3. Vegetation + Structures (village / temple / palace / roads / bridges)
4. Player controller + camera + weapons + combat + FX
5. Creatures + enemy AI + nests + director
6. Squad + companions + NPCs
7. HUD + minimap + menus + quests + progression + save
8. Meteor intro cinematic, weather, day/night, polish, README
