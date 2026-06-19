// ============================================================
// TI4 Tile Engine - Space & Ground areas
//
// SpaceArea: el espacio de un sistema (tile). Contiene las naves
// de cada jugador presentes en ese sistema. Es UNA por tile,
// compartida entre todos los planetas de ese tile.
//
// GroundArea: la superficie de UN planeta. Contiene fuerzas
// terrestres (infantry, mechs), PDS y space dock de cada jugador
// con presencia en ese planeta. Es UNA por planeta.
//
// La detección de "jugador activo" / "jugador defensor" para
// combate se resolverá más adelante; por ahora estas clases
// exponen qué jugadores tienen presencia para que esa lógica
// se pueda construir encima.
// ============================================================

const SPACE_UNIT_TYPES = ['fighter', 'cruiser', 'destroyer', 'carrier', 'dreadnought', 'warSun', 'flagship'];
const GROUND_UNIT_TYPES = ['infantry', 'mech'];

class UnitArea {
  constructor() {
    // playerId -> { unitType: cantidad, ... }
    this.unitsByPlayer = {};
  }

  addUnits(playerId, unitType, quantity = 1) {
    if (quantity <= 0) return;
    if (!this.unitsByPlayer[playerId]) this.unitsByPlayer[playerId] = {};
    this.unitsByPlayer[playerId][unitType] =
      (this.unitsByPlayer[playerId][unitType] ?? 0) + quantity;
  }

  removeUnits(playerId, unitType, quantity = 1) {
    if (!this.unitsByPlayer[playerId]) return;
    const current = this.unitsByPlayer[playerId][unitType] ?? 0;
    this.unitsByPlayer[playerId][unitType] = Math.max(0, current - quantity);
  }

  getUnits(playerId, unitType) {
    return this.unitsByPlayer[playerId]?.[unitType] ?? 0;
  }

  getAllUnits(playerId) {
    return this.unitsByPlayer[playerId] ?? {};
  }

  /** Total de unidades (de cualquier tipo) que tiene un jugador en esta área. */
  getTotalUnitCount(playerId) {
    const units = this.unitsByPlayer[playerId];
    if (!units) return 0;
    return Object.values(units).reduce((sum, q) => sum + q, 0);
  }

  /** Jugadores con al menos 1 unidad en esta área. */
  getPlayersPresent() {
    return Object.entries(this.unitsByPlayer)
      .filter(([, units]) => Object.values(units).some((q) => q > 0))
      .map(([playerId]) => playerId);
  }

  hasMultiplePlayersPresent() {
    return this.getPlayersPresent().length > 1;
  }

  /** Elimina todas las unidades (ej: tras destrucción total). */
  clear(playerId = null) {
    if (playerId) {
      delete this.unitsByPlayer[playerId];
    } else {
      this.unitsByPlayer = {};
    }
  }
}

/**
 * SpaceArea: espacio de un sistema (1 por tile).
 * Tipos de unidad esperados: fighter, cruiser, destroyer, carrier,
 * dreadnought, warSun, flagship (y variantes de facción a futuro).
 */
export class SpaceArea extends UnitArea {
  addShips(playerId, unitType, quantity = 1) {
    this.addUnits(playerId, unitType, quantity);
  }

  removeShips(playerId, unitType, quantity = 1) {
    this.removeUnits(playerId, unitType, quantity);
  }

  /**
   * ¿Hay combate espacial? (más de un jugador con naves en el sistema)
   * La determinación de quién es atacante/defensor se resuelve en
   * una capa superior (depende de quién activó el sistema).
   */
  hasSpaceCombat() {
    return this.hasMultiplePlayersPresent();
  }
}

/**
 * GroundArea: superficie de UN planeta (1 por planeta).
 * Tipos de unidad esperados: infantry, mech.
 * PDS y space dock se manejan como flags de estructura, no como "unidades"
 * que combaten en invasión, pero se guardan acá por estar en el planeta.
 */
export class GroundArea extends UnitArea {
  constructor() {
    super();
    // playerId -> { pds: cantidad, spaceDock: bool }
    this.structuresByPlayer = {};
  }

  addGroundForces(playerId, unitType, quantity = 1) {
    this.addUnits(playerId, unitType, quantity);
  }

  removeGroundForces(playerId, unitType, quantity = 1) {
    this.removeUnits(playerId, unitType, quantity);
  }

  setPds(playerId, quantity) {
    if (!this.structuresByPlayer[playerId]) this.structuresByPlayer[playerId] = {};
    this.structuresByPlayer[playerId].pds = quantity;
  }

  getPds(playerId) {
    return this.structuresByPlayer[playerId]?.pds ?? 0;
  }

  setSpaceDock(playerId, hasSpaceDock) {
    if (!this.structuresByPlayer[playerId]) this.structuresByPlayer[playerId] = {};
    this.structuresByPlayer[playerId].spaceDock = !!hasSpaceDock;
  }

  hasSpaceDock(playerId) {
    return !!this.structuresByPlayer[playerId]?.spaceDock;
  }

  /**
   * ¿Hay combate terrestre? (más de un jugador con ground forces
   * -infantry o mech- en el planeta). PDS no cuenta para esto.
   */
  hasGroundCombat() {
    const playersWithGroundForces = Object.entries(this.unitsByPlayer).filter(([, units]) =>
      GROUND_UNIT_TYPES.some((t) => (units[t] ?? 0) > 0)
    );
    return playersWithGroundForces.length > 1;
  }
}

export { SPACE_UNIT_TYPES, GROUND_UNIT_TYPES };
