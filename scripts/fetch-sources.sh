#!/usr/bin/env bash
# Downloads raw asset SOURCES (CC0 / public domain) from GitHub into .cache/asset-src.
# The game itself only uses the processed output in public/assets (see scripts/build-assets.mjs).
set -euo pipefail
CACHE="${1:-$HOME/.cache/asset-src}"
mkdir -p "$CACHE"
cd "$CACHE"

clone() { # url dir branch
  local url="$1" dir="$2" branch="${3:-main}"
  if [ -d "$dir/.git" ]; then echo "== already cloned: $dir"; return; fi
  echo "== cloning $url -> $dir ($branch)"
  rm -rf "$dir"
  git clone --depth 1 --filter=blob:none --sparse -b "$branch" "$url" "$dir" -q
}

# ---- Kenney CC0 3D packs (village / castle / nature / weapons / graveyard) ----
clone https://github.com/shorepine/kenney.git kenney
( cd kenney && git sparse-checkout set \
    3d/fantasy-town 3d/castle 3d/nature 3d/weapon 3d/graveyard 3d/mini-forest \
    3d/survival 3d/mini-characters 3d/blocky-characters 3d/city-suburban 3d/road )

# ---- three.js example models + textures (CC0 / CC-BY, see repo headers) ----
clone https://github.com/mrdoob/three.js.git three dev
( cd three && git sparse-checkout set \
    examples/models/gltf \
    examples/textures/terrain \
    examples/textures/ambientcg \
    examples/textures/equirectangular \
    examples/textures/sprites \
    examples/textures/decal \
    examples/textures/lava \
    examples/textures/noises \
    examples/textures/carbon )
( cd three && rm -f examples/models/gltf/*.blend )

# ---- ambientCG 2K PBR material pack + flat-shaded weapon GLBs ----
clone https://github.com/petroulacl/fps-asset-kit.git fpsk
( cd fpsk && git sparse-checkout set \
    "weapons/flat_guns_east" \
    textures/Ground037 textures/Ground054 textures/Ground103 \
    textures/Rock058 textures/Rock064 textures/Rock063 \
    textures/Wood092 textures/Concrete034 textures/Plaster001 \
    textures/Metal049A textures/Bricks097 textures/Asphalt023S )

# ---- stylised-realistic vegetation + tiny town + skyboxes ----
clone https://github.com/petroulacl/fps-buildings-env-kit.git envk
( cd envk && git sparse-checkout set \
    environment/vegetation/polypizza-stylized-nature-gltf \
    environment/skyboxes/polyhaven-hdri \
    environment/ground-textures/ambientcg/Grass004_2K-JPG \
    environment/ground-textures/ambientcg/Ground037_2K-JPG \
    environment/ground-textures/ambientcg/Road001_2K-JPG \
    buildings/kenney-tiny-town )

echo "== done. sources in $CACHE"
du -sh "$CACHE"/* 2>/dev/null || true
