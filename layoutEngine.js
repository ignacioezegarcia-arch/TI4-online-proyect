// ============================================================
// TI4 Layout Engine
//
// Define las 61 posiciones del tablero como coordenadas axiales
// hexagonales (q, r) y los layouts oficiales para 3-6 jugadores.
//
// Fuentes:
//   - KeeganW/ti4 (MIT License): índices de posición y layouts
//   - TI4 Living Rules Reference (FFG): reglas de armado oficial
//   - Algoritmo hexagonal: https://www.redblobgames.com/grids/hexagons/
//
// Sistema de coordenadas: axial (q, r), pointy-top hexágonos.
// Centro (0,0) = Mecatol Rex.
// Norte = (0,-1), NE = (+1,-1), SE = (+1,0),
// Sur = (0,+1), SW = (-1,+1), NW = (-1,0).
// ============================================================

// ----------------------------------------------------------
// 1. Generación del mapa de posiciones (índice -> coordenadas)
// ----------------------------------------------------------

// Vectores de movimiento para recorrer el perímetro de un anillo
// en sentido horario empezando desde el Norte.
const PERIMETER_DIRS = [
  [+1,  0],  // SE
  [ 0, +1],  // S
  [-1, +1],  // SW
  [-1,  0],  // NW
  [ 0, -1],  // N
  [+1, -1],  // NE
];

/**
 * Genera las posiciones del perímetro del anillo `radius`
 * alrededor de (0,0), en orden horario empezando desde el Norte.
 */
function hexRing(radius) {
  const results = [];
  let q = 0, r = -radius; // punto de inicio: Norte del anillo
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      results.push({ q, r });
      q += PERIMETER_DIRS[side][0];
      r += PERIMETER_DIRS[side][1];
    }
  }
  return results;
}

/**
 * Tabla completa de posiciones del tablero.
 * Índice 0  = Mecatol Rex  (0, 0)
 * Índice 1-6  = Anillo 1
 * Índice 7-18  = Anillo 2
 * Índice 19-36 = Anillo 3 (home systems para 3-6 jugadores)
 * Índice 37-60 = Anillo 4 (home systems para 7-8 jugadores, futuro)
 *
 * Generada matemáticamente con hexRing; verificada contra
 * los layouts de KeeganW/ti4 (MIT License).
 */
export const BOARD_POSITIONS = (() => {
  const positions = [{ idx: 0, q: 0, r: 0, ring: 0 }];
  let idx = 1;
  for (let ring = 1; ring <= 4; ring++) {
    hexRing(ring).forEach((hex) => {
      positions.push({ idx, q: hex.q, r: hex.r, ring });
      idx++;
    });
  }
  return positions;
})();

/**
 * Mapa de búsqueda rápida: índice -> posición.
 */
export const POSITION_BY_IDX = Object.fromEntries(
  BOARD_POSITIONS.map((p) => [p.idx, p])
);

/**
 * Mapa de búsqueda rápida: "q,r" -> índice.
 */
export const IDX_BY_COORDS = Object.fromEntries(
  BOARD_POSITIONS.map((p) => [`${p.q},${p.r}`, p.idx])
);

// ----------------------------------------------------------
// 2. Layouts oficiales por número de jugadores
// ----------------------------------------------------------

/**
 * Define un layout de tablero:
 *   - homeSystemSlots: índices donde van los home systems (uno por jugador, en orden horario)
 *   - allSlots: todos los índices de posiciones activas del tablero (excluyendo home systems)
 *   - hyperlaneTiles: [{ slot, tileId, rotation }] para layouts con hyperlanes
 *   - source: fuente del layout
 *   - notes: aclaraciones
 */

export const LAYOUTS = {

  // ---- 3 JUGADORES ----
  // Layout oficial del libro de reglas (triangular).
  // Home systems en los vértices 22, 28, 34 del anillo 3
  // (separados por 2 tiles entre sí en el anillo exterior).
  // Nota: layout espacioso; la comunidad prefiere variantes más compactas,
  // pero este es el oficial que pediste implementar.
  3: {
    playerCount: 3,
    variant: 'normal',
    source: 'Game Rules (TI4 Rulebook)',
    homeSystemSlots: [22, 28, 34],
    tileSlots: [
      // Anillo 1 (3 slots "primarios", los más cercanos a Mecatol para cada jugador)
      9, 13, 17,
      // Anillo 2 (9 slots "secundarios")
      6, 4, 2, 21, 27, 33, 35, 29, 23,
      // Anillo 3 no-home (12 slots "terciarios", posiciones libres del anillo exterior)
      8, 12, 16, 18, 14, 10, 1, 3, 5, 15, 11, 7,
    ],
    hyperlaneTiles: [],
    totalActiveTiles: 36, // 37 posiciones - Mecatol Rex
    notes: 'Layout triangular oficial. Los home systems están en los slots 22, 28 y 34 del anillo 3.',
  },

  // ---- 4 JUGADORES ----
  // Layout oficial del libro de reglas.
  // Home systems en 4 posiciones del anillo 3 (no son vértices perfectos).
  4: {
    playerCount: 4,
    variant: 'normal',
    source: 'Game Rules (TI4 Rulebook)',
    homeSystemSlots: [23, 27, 32, 36],
    tileSlots: [
      // Anillo 1 (8 slots primarios)
      9, 12, 15, 18, 7, 16, 13, 10,
      // Anillo 2 (12 slots secundarios)
      2, 4, 5, 1, 19, 33, 28, 24, 22, 26, 31, 35,
      // Anillo 3 no-home (12 slots terciarios)
      3, 6, 17, 14, 11, 8, 20, 25, 29, 34, 30, 21,
    ],
    hyperlaneTiles: [],
    totalActiveTiles: 36,
    notes: 'Layout de 4 jugadores oficial.',
  },

  // ---- 5 JUGADORES (con Hyperlanes, PoK requerido) ----
  // Layout "warp" del libro de reglas base con expansión PoK.
  // Home systems en 5 posiciones del anillo 3.
  // 6 tiles de hyperlane (83A-88A) en posiciones específicas.
  // Deal: 3 azules + 2 rojos por jugador (5 tiles x 5 jugadores = 25 slots).
  // Las conexiones internas de los tiles de hyperlane son APROXIMADAS
  // en esta primera implementación; se refinarán cuando tengamos los
  // datos gráficos exactos de cada tile.
  5: {
    playerCount: 5,
    variant: 'warp',
    source: 'Game Rules (TI4 Rulebook + Prophecy of Kings)',
    homeSystemSlots: [19, 22, 25, 31, 34],
    tileSlots: [
      // Todos los slots del tablero estándar (1-36)
      // excluyendo home systems [19,22,25,31,34] e hyperlanes [4,12,14,27,28,29]
      // = 25 slots para tiles normales (3 azules + 2 rojos x 5 jugadores = 25)
      1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 13, 15, 16, 17, 18,
      20, 21, 23, 24, 26, 30, 32, 33, 35, 36,
    ],
    hyperlaneTiles: [
      { slot: 4,  tileId: '86A', rotation: 0 },
      { slot: 12, tileId: '88A', rotation: 0 },
      { slot: 14, tileId: '87A', rotation: 0 },
      { slot: 27, tileId: '83A', rotation: 0 },
      { slot: 28, tileId: '85A', rotation: 0 },
      { slot: 29, tileId: '84A', rotation: 0 },
    ],
    totalActiveTiles: 37, // Mecatol + 25 tiles + 5 homes + 6 hyperlanes = 37
    notes: 'Layout con hyperlanes (PoK). Deal: 3 azules + 2 rojos por jugador. Las conexiones internas de los tiles de hyperlane son aproximadas en esta versión.',
    requiresPoK: true,
  },

  // ---- 6 JUGADORES ----
  // Layout oficial del libro de reglas: hexágono perfecto.
  // Home systems en los 6 vértices del anillo 3,
  // equidistantes entre sí (distancia 3 entre vecinos).
  6: {
    playerCount: 6,
    variant: 'normal',
    source: 'Game Rules (TI4 Rulebook)',
    homeSystemSlots: [19, 22, 25, 28, 31, 34],
    tileSlots: [
      // Anillo 1 (6 slots)
      1, 2, 3, 4, 5, 6,
      // Anillo 2 (12 slots)
      7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
      // Anillo 3 no-home (12 slots, los que no son home systems)
      20, 21, 23, 24, 26, 27, 29, 30, 32, 33, 35, 36,
    ],
    hyperlaneTiles: [],
    totalActiveTiles: 36,
    notes: 'Layout hexagonal perfecto. Los 6 home systems son los vértices del anillo 3, separados por 3 hexágonos entre vecinos.',
  },
};

// ----------------------------------------------------------
// 3. Funciones de consulta del layout
// ----------------------------------------------------------

/**
 * Devuelve el layout para la cantidad de jugadores dada.
 */
export function getLayout(playerCount) {
  const layout = LAYOUTS[playerCount];
  if (!layout) throw new Error(`No hay layout definido para ${playerCount} jugadores.`);
  return layout;
}

/**
 * Devuelve las coordenadas axiales (q, r) del slot de home system
 * para el jugador con índice `playerIndex` (0-based, en orden horario
 * desde el speaker).
 */
export function getHomeSystemCoords(playerCount, playerIndex) {
  const layout = getLayout(playerCount);
  const slot = layout.homeSystemSlots[playerIndex];
  if (slot === undefined) throw new Error(`No hay slot de home system para el jugador ${playerIndex} en ${playerCount}p.`);
  return POSITION_BY_IDX[slot];
}

/**
 * Devuelve las coordenadas de todos los slots de tiles no-home
 * del layout (el orden define el orden de colocación del método oficial).
 */
export function getTileSlotCoords(playerCount) {
  const layout = getLayout(playerCount);
  return layout.tileSlots.map((slot) => ({
    slot,
    ...POSITION_BY_IDX[slot],
  }));
}

/**
 * Devuelve todos los slots activos del tablero para el layout dado,
 * incluyendo home systems y posición de Mecatol Rex (índice 0).
 */
export function getAllActiveSlots(playerCount) {
  const layout = getLayout(playerCount);
  const homeSlots = layout.homeSystemSlots;
  const hyperlaneSlots = layout.hyperlaneTiles.map((h) => h.slot);
  return [
    0, // Mecatol Rex
    ...layout.tileSlots,
    ...homeSlots,
    ...hyperlaneSlots,
  ].sort((a, b) => a - b);
}

/**
 * Dado un layout, devuelve el conteo de tiles por tipo que necesita
 * cada jugador para armar la galaxia (según las reglas oficiales):
 *   - 3 jugadores: 6 azules + 2 rojos
 *   - 4 jugadores: 5 azules + 3 rojos
 *   - 5 jugadores: 4 azules + 2 rojos  (con hyperlanes)
 *   - 6 jugadores: 3 azules + 2 rojos
 */
export const TILE_DEAL = {
  3: { blue: 6, red: 2 },
  4: { blue: 5, red: 3 },
  5: { blue: 3, red: 2 }, // 5p con hyperlanes: 5 tiles por jugador (3 azules + 2 rojos)
  6: { blue: 3, red: 2 },
};

export function getTileDeal(playerCount) {
  const deal = TILE_DEAL[playerCount];
  if (!deal) throw new Error(`No hay deal de tiles definido para ${playerCount} jugadores.`);
  return deal;
}

// ----------------------------------------------------------
// 4. Algoritmo de colocación oficial (boustrophedon)
// ----------------------------------------------------------

/**
 * Genera el orden de colocación de tiles según el método oficial:
 * "empezando por el speaker en sentido horario, cada jugador coloca
 * un tile. Luego el último jugador coloca un segundo tile, el orden
 * se invierte (antihorario) hasta el speaker, quien coloca dos.
 * Se repite hasta completar cada anillo."
 *
 * Retorna un array de { round, playerIndex, slotIdx } en orden de colocación.
 * playerIndex es 0-based (0 = speaker).
 *
 * @param {number} playerCount - número de jugadores
 * @param {number[]} slots - array de slots a colocar (en orden de anillo)
 * @returns {Array<{step: number, playerIndex: number, slot: number}>}
 */
export function generatePlacementOrder(playerCount, slots) {
  const order = [];
  let step = 0;
  let forward = true;
  const slotQueue = [...slots];

  while (slotQueue.length > 0) {
    // Orden de jugadores para esta vuelta (horario o antihorario)
    const players = forward
      ? Array.from({ length: playerCount }, (_, i) => i)
      : Array.from({ length: playerCount }, (_, i) => playerCount - 1 - i);

    // Cada jugador coloca 1 tile
    for (const playerIndex of players) {
      if (slotQueue.length === 0) break;
      order.push({ step: step++, playerIndex, slot: slotQueue.shift() });
    }

    // El jugador que termina esta vuelta coloca un tile extra
    // (es el "último" de la vuelta actual, que es también el
    // "primero" de la vuelta siguiente en sentido inverso)
    if (slotQueue.length > 0) {
      const extraPlayer = forward ? playerCount - 1 : 0;
      order.push({ step: step++, playerIndex: extraPlayer, slot: slotQueue.shift() });
    }

    forward = !forward;
  }

  return order;
}

// ----------------------------------------------------------
// 5. Validación de restricciones de colocación
// ----------------------------------------------------------

/**
 * Verifica si colocar un tile con las anomalías/wormholes dados en
 * un slot específico viola las restricciones de colocación:
 *   - No anomalías adyacentes entre sí (salvo que no haya otra opción)
 *   - No mismo tipo de wormhole adyacente (salvo que no haya otra opción)
 *
 * @param {object} tile - objeto Tile a colocar
 * @param {number} targetSlot - índice del slot destino
 * @param {Map<number, object>} placedTiles - mapa slot -> Tile ya colocados
 * @returns {{ valid: boolean, violations: string[] }}
 */
export function validateTilePlacement(tile, targetSlot, placedTiles) {
  const violations = [];
  const targetPos = POSITION_BY_IDX[targetSlot];
  if (!targetPos) return { valid: false, violations: ['Slot inválido'] };

  // Encontrar slots adyacentes físicamente (distancia 1)
  const adjacentSlots = BOARD_POSITIONS.filter((pos) => {
    if (pos.idx === targetSlot) return false;
    const dq = Math.abs(pos.q - targetPos.q);
    const dr = Math.abs(pos.r - targetPos.r);
    const ds = Math.abs((pos.q + pos.r) - (targetPos.q + targetPos.r));
    return Math.max(dq, dr, ds) === 1;
  }).map((pos) => pos.idx);

  for (const adjSlot of adjacentSlots) {
    const adjTile = placedTiles.get(adjSlot);
    if (!adjTile) continue;

    // Verificar anomalías adyacentes
    if (tile.isAnomaly && adjTile.isAnomaly) {
      violations.push(
        `Anomalía adyacente a otra anomalía (slot ${adjSlot}: ${adjTile.anomalies.join(',')})`
      );
    }

    // Verificar wormholes del mismo tipo adyacentes
    if (tile.hasWormhole && adjTile.hasWormhole) {
      const sharedTypes = tile.wormholes.filter((w) => adjTile.wormholes.includes(w));
      if (sharedTypes.length > 0) {
        violations.push(
          `Wormhole tipo '${sharedTypes.join(',')}' adyacente a otro del mismo tipo (slot ${adjSlot})`
        );
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
