// Shared world constants (used by both the generation worker and the renderer).

export const WORLD = {
  N: 2049,          // heightmap resolution (vertices per side)
  SIZE: 8192,       // world size in metres
  SPLAT_N: 1024,    // splat / mask resolution
  SEA_LEVEL: 0,
  SNOW_LINE: 430,
  TREE_LINE: 560,
};

WORLD.CELL = WORLD.SIZE / (WORLD.N - 1);              // 4 m
WORLD.SPLAT_CELL = WORLD.SIZE / (WORLD.SPLAT_N - 1);  // 8 m
WORLD.HALF = WORLD.SIZE / 2;

/** Convert world x/z (centre origin) to heightmap grid indices (floats). */
export const worldToGrid = (x, z) => [x / WORLD.CELL + (WORLD.N - 1) / 2, z / WORLD.CELL + (WORLD.N - 1) / 2];
export const gridToWorld = (i, j) => [i * WORLD.CELL - WORLD.HALF, j * WORLD.CELL - WORLD.HALF];

export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, SAVANNA: 4, ROCK: 5, SNOW: 6, ASH: 7, SWAMP: 8,
};

export const SPECIES = {
  PINE: 0, TREE: 1, DEAD: 2, TWISTED: 3, BUSH: 4, FERN: 5, PLANT: 6, ROCK: 7, PEBBLE: 8, FLOWER: 9, MUSHROOM: 10, GRASS: 11, TALLGRASS: 12,
};
