import { SystemId, asSystemId } from "../types/ids";

/**
 * RR "Galaxy Creation" / Setup.
 *
 * Ported from the original class-based src/engine/layoutEngine.js (now
 * fully superseded — safe to delete once this file is uploaded). Same hex
 * math and placement algorithm; two real differences from the original:
 *
 *  1. LAYOUTS used to be hardcoded here. It isn't anymore — data/
 *     boardLayouts.json is now the single source of truth (it's the same
 *     numbers, just also covers 2p/7p/8p and community variants the
 *     original hardcoded table didn't have). This file only reads it.
 *  2. NEW: buildBoardAdjacency(), which the original never had a reason to
 *     write, because it predates GameState.systems being keyed by SystemId
 *     (the tile's own id, e.g. "18" for Mecatol Rex) rather than by board
 *     slot (0-60). Everything above it works in slot-index space; this is
 *     the bridge that turns a finished slot assignment into the
 *     `state.boardAdjacency: Record<SystemId, SystemId[]>` shape
 *     GameState.ts already expects "computed once ... when the game is
 *     created."
 *
 * This file does NOT build full SystemState objects (planets, wormholes,
 * anomalies, starting units) — only the board skeleton (which tile sits in
 * which slot, and who's physically touching whom). Turning a tiles.json
 * entry into a SystemState, and the rest of setup (speaker, starting
 * units, secret objectives), is separate, later work.
 */

// ---------------------------------------------------------------
// 1. Board position math (axial hex coordinates, pointy-top).
//    Index 0 = Mecatol Rex. Rings 1-3 = base+PoK (indices 1-36).
//    Ring 4 = 7-8 player expansion boards (indices 37-60).
// ---------------------------------------------------------------

export interface HexPosition {
  idx: number;
  q: number;
  r: number;
  ring: number;
}

const PERIMETER_DIRS: [number, number][] = [
  [+1, 0], // SE
  [0, +1], // S
  [-1, +1], // SW
  [-1, 0], // NW
  [0, -1], // N
  [+1, -1], // NE
];

function hexRing(radius: number): { q: number; r: number }[] {
  const results: { q: number; r: number }[] = [];
  let q = 0;
  let r = -radius; // start at North
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      results.push({ q, r });
      q += PERIMETER_DIRS[side][0];
      r += PERIMETER_DIRS[side][1];
    }
  }
  return results;
}

export const BOARD_POSITIONS: HexPosition[] = (() => {
  const positions: HexPosition[] = [{ idx: 0, q: 0, r: 0, ring: 0 }];
  let idx = 1;
  for (let ring = 1; ring <= 4; ring++) {
    for (const hex of hexRing(ring)) {
      positions.push({ idx, q: hex.q, r: hex.r, ring });
      idx++;
    }
  }
  return positions;
})();

export const POSITION_BY_IDX: Record<number, HexPosition> = Object.fromEntries(
  BOARD_POSITIONS.map((p) => [p.idx, p]),
);

function hexDistance(a: HexPosition, b: HexPosition): number {
  const dq = Math.abs(a.q - b.q);
  const dr = Math.abs(a.r - b.r);
  const ds = Math.abs(a.q + a.r - (b.q + b.r));
  return Math.max(dq, dr, ds);
}

/** Slots physically touching `slotIdx` on the table (distance 1), regardless of what's placed there. */
export function getAdjacentSlots(slotIdx: number): number[] {
  const pos = POSITION_BY_IDX[slotIdx];
  if (!pos) return [];
  return BOARD_POSITIONS.filter((p) => p.idx !== slotIdx && hexDistance(p, pos) === 1).map((p) => p.idx);
}

// ---------------------------------------------------------------
// 2. Layout data access — reads data/boardLayouts.json, doesn't hardcode it.
// ---------------------------------------------------------------

export interface BoardLayoutVariant {
  description: string;
  source: string;
  home_worlds: number[];
  primary_tiles: number[];
  secondary_tiles: number[];
  tertiary_tiles: number[];
  hyperlane_tiles: [slot: number, tileId: string, rotation: number][];
}

export interface BoardLayoutsFile {
  size: number;
  pokSize: number;
  styles: Record<string, Record<string, BoardLayoutVariant>>;
}

export function getLayoutVariant(
  boardLayouts: BoardLayoutsFile,
  playerCount: number,
  variant: string = "normal",
): BoardLayoutVariant {
  const forCount = boardLayouts.styles[String(playerCount)];
  if (!forCount) throw new Error(`No hay layouts definidos para ${playerCount} jugadores.`);
  const layout = forCount[variant];
  if (!layout) {
    throw new Error(
      `No existe la variante '${variant}' para ${playerCount}p. Variantes disponibles: ${Object.keys(forCount).join(", ")}`,
    );
  }
  return layout;
}

export function getAllActiveSlots(layout: BoardLayoutVariant): number[] {
  return Array.from(
    new Set<number>([
      0,
      ...layout.home_worlds,
      ...layout.primary_tiles,
      ...layout.secondary_tiles,
      ...layout.tertiary_tiles,
      ...layout.hyperlane_tiles.map(([slot]) => slot),
    ]),
  ).sort((a, b) => a - b);
}

/**
 * Non-home, non-hyperlane tile count needed per player (RR Galaxy
 * Creation). TODO: only 3/4/5/6p were confirmed against the printed
 * base+PoK rulebook in an earlier session — 2/7/8p deliberately left
 * unset rather than guessed; add once checked against the official PDF.
 */
export const TILE_DEAL: Partial<Record<number, { blue: number; red: number }>> = {
  3: { blue: 6, red: 2 },
  4: { blue: 5, red: 3 },
  5: { blue: 3, red: 2 },
  6: { blue: 3, red: 2 },
};

export function getTileDeal(playerCount: number): { blue: number; red: number } {
  const deal = TILE_DEAL[playerCount];
  if (!deal) throw new Error(`No hay deal de tiles confirmado para ${playerCount} jugadores todavía.`);
  return deal;
}

// ---------------------------------------------------------------
// 3. Official placement order (boustrophedon: speaker clockwise, reverse
//    at each turn of the ring, the player who just went twice goes again).
// ---------------------------------------------------------------

export interface PlacementStep {
  step: number;
  playerIndex: number; // 0-based, 0 = speaker
  slot: number;
}

export function generatePlacementOrder(playerCount: number, slots: number[]): PlacementStep[] {
  const order: PlacementStep[] = [];
  let step = 0;
  let forward = true;
  const slotQueue = [...slots];

  while (slotQueue.length > 0) {
    const players = forward
      ? Array.from({ length: playerCount }, (_, i) => i)
      : Array.from({ length: playerCount }, (_, i) => playerCount - 1 - i);

    for (const playerIndex of players) {
      if (slotQueue.length === 0) break;
      order.push({ step: step++, playerIndex, slot: slotQueue.shift() as number });
    }

    if (slotQueue.length > 0) {
      const extraPlayer = forward ? playerCount - 1 : 0;
      order.push({ step: step++, playerIndex: extraPlayer, slot: slotQueue.shift() as number });
    }

    forward = !forward;
  }

  return order;
}

// ---------------------------------------------------------------
// 4. Placement-conflict validation (no anomaly next to anomaly, no
//    matching wormhole next to matching wormhole, "unless there's no
//    other option" per RR — the "unless" part is left to the caller: this
//    just reports violations, it doesn't decide whether to allow them).
// ---------------------------------------------------------------

export interface PlaceableTile {
  systemId: SystemId;
  anomalies: string[];
  wormholes: string[];
}

export function validateTilePlacement(
  tile: PlaceableTile,
  targetSlot: number,
  placedBySlot: Map<number, PlaceableTile>,
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  if (!POSITION_BY_IDX[targetSlot]) return { valid: false, violations: ["Slot inválido"] };

  for (const adjSlot of getAdjacentSlots(targetSlot)) {
    const adjTile = placedBySlot.get(adjSlot);
    if (!adjTile) continue;

    if (tile.anomalies.length > 0 && adjTile.anomalies.length > 0) {
      violations.push(`Anomalía adyacente a otra anomalía (slot ${adjSlot}: ${adjTile.anomalies.join(",")})`);
    }

    const sharedWormholes = tile.wormholes.filter((w) => adjTile.wormholes.includes(w));
    if (sharedWormholes.length > 0) {
      violations.push(`Wormhole '${sharedWormholes.join(",")}' adyacente a otro del mismo tipo (slot ${adjSlot})`);
    }
  }

  return { valid: violations.length === 0, violations };
}

// ---------------------------------------------------------------
// 5. Bridge: finished slot assignment -> state.boardAdjacency (SystemId space)
// ---------------------------------------------------------------

/**
 * NOTE: treats hyperlane tiles as normal hexes (adjacent on every touching
 * edge) rather than modeling each hyperlane tile's actual internal wiring
 * (which of its 6 edges really connect through). Flagged rather than
 * silently wrong: base+PoK without hyperlanes (3/4/6p, and 5p's "normal"
 * non-hyperlane variant) is entirely unaffected by this simplification —
 * it only under-restricts adjacency for the hyperlane variants (5p "warp",
 * 7p, 8p "warp").
 */
export function buildBoardAdjacency(slotToSystemId: Record<number, SystemId>): Record<SystemId, SystemId[]> {
  const result: Record<string, SystemId[]> = {};
  for (const [slotStr, systemId] of Object.entries(slotToSystemId)) {
    const slot = Number(slotStr);
    const neighbors = getAdjacentSlots(slot)
      .map((n) => slotToSystemId[n])
      .filter((id): id is SystemId => id !== undefined);
    result[systemId] = neighbors;
  }
  return result as Record<SystemId, SystemId[]>;
}

// ---------------------------------------------------------------
// 6. Optional one-shot orchestration: shuffle + place + validate + bridge.
//    ASSUMPTION FLAGGED: this assumes an auto-generated map (no human
//    manually placing tiles at the table). If the intended UX is "the
//    speaker places tiles by hand, the app just warns on conflicts",
//    use generatePlacementOrder + validateTilePlacement directly from a
//    UI instead of this function.
// ---------------------------------------------------------------

export interface GenerateMapInput {
  playerCount: number;
  variant?: string;
  boardLayouts: BoardLayoutsFile;
  /** Non-home tile pool to shuffle into primary/secondary/tertiary slots — already filtered to this game's expansions and excluding home systems, Mecatol Rex, and off-map tiles. */
  availableTiles: PlaceableTile[];
  /** Seat order (index 0 = speaker) -> that player's home system tile id, already resolved from their faction. */
  homeSystemsBySeat: SystemId[];
  mecatolSystemId: SystemId;
  rng?: () => number;
}

export interface GeneratedMap {
  slotToSystemId: Record<number, SystemId>;
  boardAdjacency: Record<SystemId, SystemId[]>;
  placementOrder: PlacementStep[];
}

export function generateMap(input: GenerateMapInput): GeneratedMap {
  const { playerCount, boardLayouts, availableTiles, homeSystemsBySeat, mecatolSystemId } = input;
  const variant = input.variant ?? "normal";
  const rng = input.rng ?? Math.random;
  const layout = getLayoutVariant(boardLayouts, playerCount, variant);

  if (homeSystemsBySeat.length !== layout.home_worlds.length) {
    throw new Error(
      `Layout '${variant}' de ${playerCount}p espera ${layout.home_worlds.length} home systems, llegaron ${homeSystemsBySeat.length}.`,
    );
  }

  const slotToSystemId: Record<number, SystemId> = { 0: mecatolSystemId };
  layout.home_worlds.forEach((slot, i) => {
    slotToSystemId[slot] = homeSystemsBySeat[i];
  });
  layout.hyperlane_tiles.forEach(([slot, tileId]) => {
    slotToSystemId[slot] = asSystemId(tileId);
  });

  const nonHomeSlots = [...layout.primary_tiles, ...layout.secondary_tiles, ...layout.tertiary_tiles];
  if (availableTiles.length < nonHomeSlots.length) {
    throw new Error(`Este layout necesita ${nonHomeSlots.length} tiles, hay ${availableTiles.length} disponibles.`);
  }

  const placementOrder = generatePlacementOrder(playerCount, nonHomeSlots);
  const pool = fisherYatesShuffle(availableTiles, rng);
  const placedBySlot = new Map<number, PlaceableTile>();

  for (const step of placementOrder) {
    // Try the pool in shuffled order; take the first tile that doesn't
    // violate placement rules against what's already down, same
    // reshuffle-just-this-clash resolution the rulebook describes rather
    // than restarting the whole deal. Falls back to the first tile left
    // (a violation) only if every remaining tile would violate — better to
    // finish with a flagged violation than throw away an otherwise-fine map.
    let chosenIndex = 0;
    let result = validateTilePlacement(pool[0], step.slot, placedBySlot);
    for (let i = 1; i < pool.length && !result.valid; i++) {
      const attempt = validateTilePlacement(pool[i], step.slot, placedBySlot);
      if (attempt.valid) {
        chosenIndex = i;
        result = attempt;
        break;
      }
    }
    const [chosen] = pool.splice(chosenIndex, 1);
    placedBySlot.set(step.slot, chosen);
    slotToSystemId[step.slot] = chosen.systemId;
  }

  return {
    slotToSystemId,
    boardAdjacency: buildBoardAdjacency(slotToSystemId),
    placementOrder,
  };
}

function fisherYatesShuffle<T>(arr: T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
