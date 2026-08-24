// ============================================================
// TI4 Tile Engine - Tile & Planet model
//
// Separa los DATOS ESTÁTICOS de un tile (definidos por el juego:
// recursos, influencia, anomalías, wormholes, tech specialties...)
// del ESTADO DINÁMICO de una partida (quién controla cada planeta,
// si está agotado, qué unidades hay).
// ============================================================

import {
  ANOMALY_TYPES,
  getCombinedAnomalyEffects,
  canShipEnterTile,
  canShipPassThroughTile,
  getEffectiveMoveValueLeaving,
  getDefenderCombatBonus,
  getGravityRiftCheck,
} from './anomalyRules';

import { SpaceArea, GroundArea } from './combatAreas';

/**
 * Representa un planeta dentro de un sistema (tile).
 * Los datos estáticos vienen de tiles.json; el estado se
 * inicializa en el constructor.
 */
export class Planet {
  constructor(staticData) {
    this.name = staticData.name;
    this.resources = staticData.resources ?? 0;
    this.influence = staticData.influence ?? 0;
    this.traits = staticData.traits ?? []; // cultural / hazardous / industrial
    this.techSpecialty = staticData.tech ?? []; // ['red'], ['blue'], etc.
    this.isLegendary = !!staticData.isLegendary;
    this.isMecatolRex = !!staticData.isMecatolRex;
    this.isMallice = !!staticData.isMallice;

    // Estado dinámico
    this.controlledBy = null; // playerId o null
    this.exhausted = false;   // true = ya se gastó resources/influence este turno
    this.groundArea = new GroundArea(); // fuerzas terrestres, mechs, PDS y space dock en este planeta
  }

  /** "Optimal value" según definición de Milty: el mayor entre resources e influence. */
  get optimalValue() {
    return Math.max(this.resources, this.influence);
  }

  exhaust() {
    this.exhausted = true;
  }

  ready() {
    this.exhausted = false;
  }

  setController(playerId) {
    this.controlledBy = playerId;
  }

  hasTrait(trait) {
    return this.traits.includes(trait);
  }

  hasTechSpecialty(spec) {
    return this.techSpecialty.includes(spec);
  }
}

/**
 * Representa un tile (casillero hexagonal) del tablero.
 * Puede contener 0, 1, 2 o 3 planetas según el tile.
 */
export class Tile {
  constructor(staticData) {
    this.id = staticData.id;
    this.name = staticData.name;
    this.expansion = staticData.expansion ?? 0;

    this.isHomeSystem = !!staticData.isHome;
    this.isMecatolRex = !!staticData.isMecatolRex;

    // Anomalías presentes (puede haber más de una combinada, regla 9.5)
    this.anomalies = [];
    if (staticData.isAnomaly && staticData.anomalyType) {
      if (staticData.anomalyType === 'alpha-asteroid') {
        this.anomalies.push(ANOMALY_TYPES.ASTEROID_FIELD);
      } else {
        this.anomalies.push(staticData.anomalyType);
      }
    }

    // Wormhole(s)
    // Caso especial: Wormhole Nexus tiene wormholes distintos según su estado
    // (inactivo: solo gamma | activo: alpha+beta+gamma) y NO es una anomalía.
    this.isOffMap = !!staticData.isOffMap;
    if (staticData.wormholeState) {
      this.wormholeState = staticData.wormholeState; // 'inactive' | 'active'
      this.wormholesInactive = staticData.wormholesInactive ?? [];
      this.wormholesActive = staticData.wormholesActive ?? [];
      this.wormholes =
        this.wormholeState === 'active' ? this.wormholesActive : this.wormholesInactive;
    } else {
      this.wormholes = [];
      if (staticData.isWormhole && staticData.wormholeType) {
        this.wormholes.push(staticData.wormholeType);
      }
    }

    this.isBlank = !!staticData.isBlank;
    this.noPlanet = !!staticData.noPlanet || (Array.isArray(staticData.planets) && staticData.planets.length === 0);

    // Planetas: vienen ya desglosados individualmente en staticData.planets
    this.planets = (staticData.planets ?? []).map(
      (p) =>
        new Planet({
          name: p.name,
          resources: p.resources,
          influence: p.influence,
          traits: p.traits ?? [],
          tech: p.tech ?? [],
          isLegendary: !!p.isLegendary,
          isMecatolRex: !!p.isMecatolRex || (this.isMecatolRex && (staticData.planets?.length ?? 0) <= 1),
          isMallice: !!p.isMallice,
        })
    );

    // Posición en el tablero (coordenadas axiales hex)
    this.position = staticData.position ?? null;
    this.rotation = staticData.rotation ?? 0;

    // Espacio del sistema: naves de cada jugador presentes en este tile
    // (compartido entre todos los planetas del tile, si tiene más de uno)
    this.spaceArea = new SpaceArea();
  }

  // ----- Consultas de anomalías -----

  get isAnomaly() {
    return this.anomalies.length > 0;
  }

  hasAnomalyType(type) {
    return this.anomalies.includes(type);
  }

  get anomalyEffects() {
    return getCombinedAnomalyEffects(this.anomalies);
  }

  canShipEnter({ isActiveSystem = false } = {}) {
    return canShipEnterTile(this.anomalies, { isActiveSystem });
  }

  canShipPassThrough() {
    return canShipPassThroughTile(this.anomalies);
  }

  getEffectiveMoveValueLeaving(baseMove = 2) {
    return getEffectiveMoveValueLeaving(this.anomalies, baseMove);
  }

  getDefenderCombatBonus() {
    return getDefenderCombatBonus(this.anomalies);
  }

  getGravityRiftCheck() {
    return getGravityRiftCheck(this.anomalies);
  }

  // ----- Consultas de wormholes -----

  get hasWormhole() {
    return this.wormholes.length > 0;
  }

  hasWormholeType(type) {
    return this.wormholes.includes(type);
  }

  /**
   * Específico del Wormhole Nexus (PoK): la primera vez que un jugador
   * mueve/coloca una unidad en el Nexus, o gana control de Mallice,
   * el tile se gira a su lado activo (alpha + beta + gamma).
   * No tiene efecto en tiles que no tengan wormholeState definido.
   */
  flipNexus() {
    if (!this.wormholeState) return false;
    if (this.wormholeState === 'active') return false;
    this.wormholeState = 'active';
    this.wormholes = this.wormholesActive;
    return true;
  }

  /**
   * Dos tiles con wormhole del mismo tipo son adyacentes
   * independientemente de su posición física.
   */
  isWormholeAdjacentTo(otherTile) {
    if (!this.hasWormhole || !otherTile.hasWormhole) return false;
    return this.wormholes.some((w) => otherTile.wormholes.includes(w));
  }

  // ----- Consultas de planetas / recursos -----

  get totalResources() {
    return this.planets.reduce((sum, p) => sum + p.resources, 0);
  }

  get totalInfluence() {
    return this.planets.reduce((sum, p) => sum + p.influence, 0);
  }

  get totalOptimal() {
    return this.planets.reduce((sum, p) => sum + p.optimalValue, 0);
  }

  get hasLegendaryPlanet() {
    return this.planets.some((p) => p.isLegendary);
  }

  get techSpecialties() {
    return this.planets.flatMap((p) => p.techSpecialty);
  }

  get planetTraits() {
    return this.planets.flatMap((p) => p.traits);
  }

  /** Resetea el estado de "agotado" de todos los planetas (fase de status). */
  readyAllPlanets() {
    this.planets.forEach((p) => p.ready());
  }

  // ----- Consultas de combate (placeholder para jugador activo/defensor) -----

  /** ¿Hay combate espacial en este sistema? (más de un jugador con naves) */
  hasSpaceCombat() {
    return this.spaceArea.hasSpaceCombat();
  }

  /** ¿Hay combate terrestre en algún planeta de este sistema? */
  hasGroundCombatOnAnyPlanet() {
    return this.planets.some((p) => p.groundArea.hasGroundCombat());
  }
}

/**
 * Construye un Tile a partir de la entrada cruda de tiles.json.
 */
export function createTileFromData(rawTileData, overrides = {}) {
  return new Tile({ ...rawTileData, ...overrides });
}

/**
 * Adyacencia hexagonal estándar (coordenadas axiales).
 * Las 6 direcciones posibles desde un hex.
 */
export const HEX_DIRECTIONS = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function hexNeighbors({ q, r }) {
  return HEX_DIRECTIONS.map((d) => ({ q: q + d.q, r: r + d.r }));
}

export function hexDistance(a, b) {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

/**
 * Dada una lista de Tiles colocados (con .position asignado),
 * determina la adyacencia física + adyacencia por wormhole
 * entre dos tiles.
 */
export function areTilesAdjacent(tileA, tileB) {
  if (!tileA.position || !tileB.position) return false;
  const physicallyAdjacent = hexDistance(tileA.position, tileB.position) === 1;
  if (physicallyAdjacent) return true;
  return tileA.isWormholeAdjacentTo(tileB);
}
