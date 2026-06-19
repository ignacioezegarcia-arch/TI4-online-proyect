// ============================================================
// TI4 Tile Engine - Anomaly definitions
// Reglas oficiales (Rule Reference / TI4Rules):
//  - Asteroid Field (9.x / 11.x): bloquea movimiento hacia/a través
//  - Nebula (9.x / 59.x): solo se puede ENTRAR si es sistema activo,
//    nunca atravesar; al salir, move=1; defensor +1 a tiradas de combate
//  - Supernova: bloquea movimiento hacia/a través (excepto Embers of Muaat)
//  - Gravity Rift: nave que sale/atraviesa obtiene +1 de movimiento,
//    luego tira 1d10 (o d6 según variante); 1-3 = nave destruida
// ============================================================

export const ANOMALY_TYPES = {
  ASTEROID_FIELD: 'asteroidField',
  NEBULA: 'nebula',
  SUPERNOVA: 'supernova',
  GRAVITY_RIFT: 'gravityRift',
};

export const WORMHOLE_TYPES = {
  ALPHA: 'alpha',
  BETA: 'beta',
  GAMMA: 'gamma', // Introducido en Prophecy of Kings (Wormhole Nexus, Ghosts of Creuss)
};

export const PLANET_TRAITS = {
  CULTURAL: 'cultural',
  HAZARDOUS: 'hazardous',
  INDUSTRIAL: 'industrial',
};

export const TECH_SPECIALTIES = {
  RED: 'red',       // Warfare
  GREEN: 'green',   // Biotic
  BLUE: 'blue',     // Propulsion
  YELLOW: 'yellow', // Cybernetic
};

// Definición de los efectos de juego de cada anomalía.
// Cada efecto se describe de forma estructurada para que el motor
// pueda consultarlo programáticamente (por ejemplo, al validar
// movimientos o calcular combates) y también mostrarlo al usuario.
export const ANOMALY_RULES = {
  [ANOMALY_TYPES.ASTEROID_FIELD]: {
    label: 'Campo de Asteroides',
    shortLabel: 'Asteroides',
    color: '#8a8a8a',
    movement: {
      canEnter: false,
      canPassThrough: false,
      note: 'Una nave no puede moverse hacia ni a través de un campo de asteroides, salvo que el jugador tenga la tecnología Antimass Deflectors.',
      bypassTech: 'Antimass Deflectors',
    },
    combat: null,
  },
  [ANOMALY_TYPES.NEBULA]: {
    label: 'Nebulosa',
    shortLabel: 'Nebulosa',
    color: '#b35cff',
    movement: {
      canEnter: 'onlyIfActiveSystem',
      canPassThrough: false,
      moveValueWhenLeaving: 1,
      note: 'Una nave solo puede entrar a una nebulosa si esa nebulosa es el sistema activo (no se puede atravesar ni usar como destino de retirada). Al salir de la nebulosa, el valor de movimiento de la nave se trata como 1.',
    },
    combat: {
      defenderCombatRollBonus: 1,
      note: 'Si ocurre un combate espacial en la nebulosa, el defensor aplica +1 a cada tirada de combate de sus naves.',
    },
  },
  [ANOMALY_TYPES.SUPERNOVA]: {
    label: 'Supernova',
    shortLabel: 'Supernova',
    color: '#ff8c42',
    movement: {
      canEnter: false,
      canPassThrough: false,
      note: 'Una nave no puede moverse hacia ni a través de una supernova. Excepción: la facción Embers of Muaat puede mover su flagship a través de supernovas.',
      exceptionFaction: 'embers_of_muaat',
    },
    combat: null,
  },
  [ANOMALY_TYPES.GRAVITY_RIFT]: {
    label: 'Gravity Rift',
    shortLabel: 'Gravity Rift',
    color: '#5c5cff',
    movement: {
      canEnter: true,
      canPassThrough: true,
      moveValueBonus: 1,
      destructionCheck: {
        diceSides: 10,
        destroyOnRollLessOrEqual: 3,
        note: 'Toda nave que se mueva a través de, o salga de, un gravity rift aplica +1 a su valor de movimiento y luego tira 1 dado (d10); con resultado 1-3, la nave es destruida.',
      },
      note: 'El bonus de movimiento se aplica incluso si la nave finalmente es destruida por la tirada.',
    },
    combat: null,
  },
};

// Una misma casilla puede tener múltiples anomalías combinadas
// (regla 9.5: el sistema tiene las propiedades de ambas).
// El motor simplemente aplica todas las reglas de ANOMALY_RULES
// para cada anomalía presente en el tile.
export function getCombinedAnomalyEffects(anomalyTypes = []) {
  return anomalyTypes
    .filter((type) => ANOMALY_RULES[type])
    .map((type) => ({ type, ...ANOMALY_RULES[type] }));
}

// Determina si, según las anomalías presentes, una nave SIN
// tecnologías especiales puede entrar al tile.
export function canShipEnterTile(anomalyTypes = [], { isActiveSystem = false } = {}) {
  for (const type of anomalyTypes) {
    const rule = ANOMALY_RULES[type];
    if (!rule || !rule.movement) continue;
    const { canEnter } = rule.movement;
    if (canEnter === false) return false;
    if (canEnter === 'onlyIfActiveSystem' && !isActiveSystem) return false;
  }
  return true;
}

// Determina si una nave SIN tecnologías especiales puede atravesar el tile.
export function canShipPassThroughTile(anomalyTypes = []) {
  for (const type of anomalyTypes) {
    const rule = ANOMALY_RULES[type];
    if (!rule || !rule.movement) continue;
    if (rule.movement.canPassThrough === false) return false;
  }
  return true;
}

// Calcula el valor de movimiento efectivo de una nave que sale de un tile
// con las anomalías dadas, partiendo de un valor base.
export function getEffectiveMoveValueLeaving(anomalyTypes = [], baseMove = 2) {
  let value = baseMove;
  for (const type of anomalyTypes) {
    const rule = ANOMALY_RULES[type];
    if (!rule || !rule.movement) continue;
    if (typeof rule.movement.moveValueWhenLeaving === 'number') {
      value = rule.movement.moveValueWhenLeaving;
    }
    if (typeof rule.movement.moveValueBonus === 'number') {
      value += rule.movement.moveValueBonus;
    }
  }
  return value;
}

// Devuelve el bonus de combate para el defensor en un tile dado.
export function getDefenderCombatBonus(anomalyTypes = []) {
  let bonus = 0;
  for (const type of anomalyTypes) {
    const rule = ANOMALY_RULES[type];
    if (rule?.combat?.defenderCombatRollBonus) {
      bonus += rule.combat.defenderCombatRollBonus;
    }
  }
  return bonus;
}

// Devuelve info de "destruction check" (gravity rift) si aplica.
export function getGravityRiftCheck(anomalyTypes = []) {
  const rift = anomalyTypes.includes(ANOMALY_TYPES.GRAVITY_RIFT);
  if (!rift) return null;
  return ANOMALY_RULES[ANOMALY_TYPES.GRAVITY_RIFT].movement.destructionCheck;
}
