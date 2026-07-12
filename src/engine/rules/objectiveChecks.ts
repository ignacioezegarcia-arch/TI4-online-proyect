import { GameState, PlanetState } from "../types/GameState";
import { PlayerId, SystemId } from "../types/ids";
import { SHIP_TYPES, STRUCTURE_TYPES } from "../types/enums";
import { RuleData } from "../types/RuleData";
import { getAdjacentSystems } from "./adjacency";

/**
 * RR 52 objective condition checks. Only exists for objectives whose
 * data/objectives.json entry has a real `checkType` (not "manual") — see
 * that file's own note on why roughly half the deck (mostly secrets) isn't
 * covered yet: event-history-dependent conditions ("win a combat against
 * X", "be the last to pass") or map-layout-dependent ones ("edge of the
 * board") that need infrastructure this engine doesn't have yet, rather
 * than a wrong guess.
 *
 * Every checker is a pure read of the CURRENT GameState — "spend X"
 * objectives are handled separately in scoreObjective (they need to
 * perform a spend, not just read state); see this file's SPEND_CHECK_TYPES
 * export.
 */

export interface ObjectiveCheckContext {
  state: GameState;
  rules: RuleData;
  playerId: PlayerId;
}

export type ObjectiveCheckResult = { met: boolean; reason?: string };
export type ObjectiveCheckFn = (ctx: ObjectiveCheckContext, params: Record<string, unknown>) => ObjectiveCheckResult;

// --- shared helpers ---------------------------------------------------------

function controlledPlanets(state: GameState, playerId: PlayerId): { systemId: SystemId; planet: PlanetState }[] {
  const out: { systemId: SystemId; planet: PlanetState }[] = [];
  for (const [systemId, system] of Object.entries(state.systems)) {
    for (const planet of system.planets) {
      if (planet.controllerId === playerId) out.push({ systemId: systemId as SystemId, planet });
    }
  }
  return out;
}

function systemsWithPlayerShips(state: GameState, playerId: PlayerId): SystemId[] {
  return Object.entries(state.systems)
    .filter(([, s]) => (s.spaceUnitsByPlayer[playerId] ?? []).some((u) => u.count > 0 && SHIP_TYPES.includes(u.unitType)))
    .map(([id]) => id as SystemId);
}

function systemsWithPlayerUnits(state: GameState, playerId: PlayerId): SystemId[] {
  return Object.entries(state.systems)
    .filter(([, s]) => {
      const inSpace = (s.spaceUnitsByPlayer[playerId] ?? []).some((u) => u.count > 0);
      const onPlanet = s.planets.some((p) => (p.unitsByPlayer[playerId] ?? []).some((u) => u.count > 0));
      return inSpace || onPlanet;
    })
    .map(([id]) => id as SystemId);
}

function countStructures(state: GameState, playerId: PlayerId): number {
  let count = 0;
  for (const system of Object.values(state.systems)) {
    for (const planet of system.planets) {
      for (const stack of planet.unitsByPlayer[playerId] ?? []) {
        if (STRUCTURE_TYPES.includes(stack.unitType) && stack.count > 0) count += stack.count;
      }
    }
  }
  return count;
}

function findMecatolSystemId(state: GameState, rules: RuleData): SystemId | null {
  for (const [systemId, system] of Object.entries(state.systems)) {
    if (system.planets.some((p) => rules.planets[p.planetId]?.isMecatolRex)) return systemId as SystemId;
  }
  return null;
}

function isHomeSystemOf(state: GameState, rules: RuleData, systemId: SystemId, factionId: string): boolean {
  const system = state.systems[systemId];
  return system?.planets.some((p) => rules.planets[p.planetId]?.homeFactionId === factionId) ?? false;
}

function hasFlagshipOrWarSun(state: GameState, systemId: SystemId, playerId: PlayerId): boolean {
  const stacks = state.systems[systemId]?.spaceUnitsByPlayer[playerId] ?? [];
  return stacks.some((s) => (s.unitType === "flagship" || s.unitType === "war_sun") && s.count > 0);
}

// --- registry ----------------------------------------------------------------

export const OBJECTIVE_CHECKS: Record<string, ObjectiveCheckFn> = {
  control_planets_with_shared_trait: ({ state, rules, playerId }, params) => {
    const count = params.count as number;
    const traitCounts = new Map<string, number>();
    for (const { planet } of controlledPlanets(state, playerId)) {
      for (const trait of rules.planets[planet.planetId]?.traits ?? []) {
        traitCounts.set(trait, (traitCounts.get(trait) ?? 0) + 1);
      }
    }
    const met = Array.from(traitCounts.values()).some((c) => c >= count);
    return { met, reason: met ? undefined : `No single planet trait shared by ${count}+ controlled planets.` };
  },

  own_unit_upgrade_techs: ({ state, playerId }, params) => {
    const count = params.count as number;
    const owned = state.players[playerId]?.unitUpgrades.length ?? 0;
    return { met: owned >= count, reason: owned >= count ? undefined : `Only ${owned}/${count} unit upgrade techs owned.` };
  },

  own_techs_per_color: ({ state, rules, playerId }, params) => {
    const techsPerColor = params.techsPerColor as number;
    const colorCount = params.colorCount as number;
    const byColor = new Map<string, number>();
    for (const techId of state.players[playerId]?.technologies ?? []) {
      const color = rules.technologies[techId]?.color;
      if (color) byColor.set(color, (byColor.get(color) ?? 0) + 1);
    }
    const colorsWithEnough = Array.from(byColor.values()).filter((c) => c >= techsPerColor).length;
    const met = colorsWithEnough >= colorCount;
    return { met, reason: met ? undefined : `Only ${colorsWithEnough}/${colorCount} colors with ${techsPerColor}+ techs.` };
  },

  control_planets_non_home: ({ state, rules, playerId }, params) => {
    const count = params.count as number;
    const n = controlledPlanets(state, playerId).filter(({ planet }) => !rules.planets[planet.planetId]?.homeFactionId).length;
    return { met: n >= count, reason: n >= count ? undefined : `Only ${n}/${count} non-home planets controlled.` };
  },

  control_planets_with_tech_specialty: ({ state, rules, playerId }, params) => {
    const count = params.count as number;
    const n = controlledPlanets(state, playerId).filter(
      ({ planet }) => (rules.planets[planet.planetId]?.techSpecialties ?? []).length > 0,
    ).length;
    return { met: n >= count, reason: n >= count ? undefined : `Only ${n}/${count} tech-specialty planets controlled.` };
  },

  ships_in_systems_adjacent_to_mecatol: ({ state, rules, playerId }, params) => {
    const count = params.count as number;
    const mecatol = findMecatolSystemId(state, rules);
    if (!mecatol) return { met: false, reason: "Mecatol Rex isn't on the board." };
    const adjacent = new Set(getAdjacentSystems(state, mecatol));
    const n = systemsWithPlayerShips(state, playerId).filter((id) => adjacent.has(id)).length;
    return { met: n >= count, reason: n >= count ? undefined : `Ships in only ${n}/${count} systems adjacent to Mecatol Rex.` };
  },

  have_structures: ({ state, playerId }, params) => {
    const count = params.count as number;
    const n = countStructures(state, playerId);
    return { met: n >= count, reason: n >= count ? undefined : `Only ${n}/${count} structures.` };
  },

  control_planets_with_attachments: ({ state, playerId }, params) => {
    const count = params.count as number;
    const n = controlledPlanets(state, playerId).filter(({ planet }) => planet.attachmentIds.length > 0).length;
    return { met: n >= count, reason: n >= count ? undefined : `Only ${n}/${count} planets with attachments.` };
  },

  have_flagship_or_warsun_on_board: ({ state, playerId }) => {
    const met = Object.keys(state.systems).some((id) => hasFlagshipOrWarSun(state, id as SystemId, playerId));
    return { met, reason: met ? undefined : "No flagship or war sun on the board." };
  },

  units_in_systems_without_planets: ({ state, playerId }, params) => {
    const count = params.count as number;
    const n = systemsWithPlayerUnits(state, playerId).filter((id) => state.systems[id].planets.length === 0).length;
    return { met: n >= count, reason: n >= count ? undefined : `Units in only ${n}/${count} systems without planets.` };
  },

  structures_on_planets_outside_home: ({ state, rules, playerId }, params) => {
    const count = params.count as number;
    const n = controlledPlanets(state, playerId).filter(
      ({ planet }) =>
        !rules.planets[planet.planetId]?.homeFactionId &&
        (planet.unitsByPlayer[playerId] ?? []).some((s) => STRUCTURE_TYPES.includes(s.unitType) && s.count > 0),
    ).length;
    return { met: n >= count, reason: n >= count ? undefined : `Structures on only ${n}/${count} non-home planets.` };
  },

  units_in_special_systems: ({ state, rules, playerId }, params) => {
    const count = params.count as number;
    const n = systemsWithPlayerUnits(state, playerId).filter((id) => {
      const system = state.systems[id];
      const isMecatol = system.planets.some((p) => rules.planets[p.planetId]?.isMecatolRex);
      const isLegendary = system.planets.some((p) => rules.planets[p.planetId]?.isLegendary);
      return isMecatol || isLegendary || system.anomalies.length > 0;
    }).length;
    return { met: n >= count, reason: n >= count ? undefined : `Units in only ${n}/${count} legendary/Mecatol/anomaly systems.` };
  },

  control_more_planets_than_n_neighbors: ({ state, rules, playerId }, params) => {
    const neighborCount = params.neighborCount as number;
    const myPlanetCount = controlledPlanets(state, playerId).length;
    const mySystems = new Set(Object.entries(state.systems).filter(([, s]) => s.planets.some((p) => p.controllerId === playerId)).map(([id]) => id));

    let neighborsBeaten = 0;
    for (const [otherId, otherPlayer] of Object.entries(state.players)) {
      if (otherId === playerId || otherPlayer.eliminated) continue;
      const theirSystems = Object.entries(state.systems).filter(([, s]) => s.planets.some((p) => p.controllerId === otherId));
      const isNeighbor = theirSystems.some(([sysId]) =>
        [sysId, ...getAdjacentSystems(state, sysId as SystemId)].some((id) => mySystems.has(id)),
      );
      if (!isNeighbor) continue;
      const theirPlanetCount = controlledPlanets(state, otherId as PlayerId).length;
      if (myPlanetCount > theirPlanetCount) neighborsBeaten++;
    }
    return {
      met: neighborsBeaten >= neighborCount,
      reason: neighborsBeaten >= neighborCount ? undefined : `Only ahead of ${neighborsBeaten}/${neighborCount} neighbors in planet count.`,
    };
  },

  ships_in_one_system: ({ state, playerId }, params) => {
    const count = params.count as number;
    const met = Object.values(state.systems).some((system) => {
      const n = (system.spaceUnitsByPlayer[playerId] ?? [])
        .filter((s) => SHIP_TYPES.includes(s.unitType) && s.unitType !== "fighter")
        .reduce((sum, s) => sum + s.count, 0);
      return n >= count;
    });
    return { met, reason: met ? undefined : `No single system with ${count}+ non-fighter ships.` };
  },

  control_planets_in_enemy_home: ({ state, rules, playerId }, params) => {
    const count = params.count as number;
    const player = state.players[playerId];
    const n = controlledPlanets(state, playerId).filter((p) => {
      const home = rules.planets[p.planet.planetId]?.homeFactionId;
      return home && home !== player.factionId;
    }).length;
    return { met: n >= count, reason: n >= count ? undefined : `Only ${n}/${count} planets controlled in another player's home.` };
  },

  flagship_or_warsun_in_enemy_home_or_mecatol: ({ state, rules, playerId }) => {
    const player = state.players[playerId];
    const mecatol = findMecatolSystemId(state, rules);
    const met = Object.keys(state.systems).some((id) => {
      if (!hasFlagshipOrWarSun(state, id as SystemId, playerId)) return false;
      if (id === mecatol) return true;
      const system = state.systems[id as SystemId];
      return system.planets.some((p) => {
        const home = rules.planets[p.planetId]?.homeFactionId;
        return home && home !== player.factionId;
      });
    });
    return { met, reason: met ? undefined : "No flagship/war sun in another player's home system or Mecatol Rex." };
  },
};

/** checkTypes that need a `spend` payload executed as part of scoring, handled directly in scoreObjective rather than here (they mutate state, not just read it). Exported so scoreObjective can tell them apart from OBJECTIVE_CHECKS. */
export const SPEND_CHECK_TYPES = new Set([
  "spend_resources",
  "spend_influence",
  "spend_trade_goods",
  "spend_command_tokens",
  "spend_combined",
]);
