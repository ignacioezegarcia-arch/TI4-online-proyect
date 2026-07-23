import { GameState, PlanetState } from "../types/GameState";
import { GameEvent } from "../types/Actions";
import { PlayerId, SystemId, PlanetId } from "../types/ids";
import { SHIP_TYPES, GROUND_FORCE_TYPES, STRUCTURE_TYPES } from "../types/enums";
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

/**
 * RR: combats this player WON during the current tactical action —
 * state.recentEvents resets at ACTIVATE_SYSTEM (see GameState.ts's own doc
 * comment on that field), so this is naturally scoped to "just now,"
 * matching every "win a combat [+ condition]" secret objective's own
 * "Action" timing. Shared by several checkers below.
 */
function combatsWonThisTurn(state: GameState, playerId: PlayerId): { systemId: SystemId; planetId?: PlanetId }[] {
  return (state.recentEvents ?? [])
    .filter(
      (e): e is Extract<GameEvent, { type: "SPACE_COMBAT_ENDED" | "GROUND_COMBAT_ENDED" }> =>
        (e.type === "SPACE_COMBAT_ENDED" || e.type === "GROUND_COMBAT_ENDED") && e.survivingPlayerId === playerId,
    )
    .map((e) => ({ systemId: e.systemId, planetId: e.type === "GROUND_COMBAT_ENDED" ? e.planetId : undefined }));
}

/**
 * RR: who this player was fighting in a given system/planet this turn —
 * inferred from whoever else's units were destroyed there (recentEvents'
 * UNITS_DESTROYED already records the LOSING player's id). Reasonable for
 * the normal 2-combatant case; doesn't try to disambiguate 3+-way
 * scenarios, or distinguish "this player's own attack destroyed it" from
 * "a third party's Space Cannon happened to land the finishing blow in the
 * same tactical action" — same category of simplification as this
 * project's other combat helpers (e.g. rules/combat.ts's own "exactly 2
 * combatants" assumption).
 */
function findOpponentInCombat(state: GameState, playerId: PlayerId, systemId: SystemId, planetId?: PlanetId): PlayerId | null {
  const loser = (state.recentEvents ?? []).find(
    (e): e is Extract<GameEvent, { type: "UNITS_DESTROYED" }> =>
      e.type === "UNITS_DESTROYED" &&
      e.systemId === systemId &&
      e.playerId !== playerId &&
      (planetId ? e.planetId === planetId : !e.planetId),
  );
  return loser?.playerId ?? null;
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
    const adjacent = new Set(getAdjacentSystems(state, mecatol, rules));
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
        [sysId, ...getAdjacentSystems(state, sysId as SystemId, rules)].some((id) => mySystems.has(id)),
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

  // --- RR "Action"-timed secrets: all read state.recentEvents, the rolling
  // buffer of this tactical action's own events (see GameState.ts's own
  // doc comment on it) — these were the first checkers to actually need
  // it; every other checkType above only reads CURRENT state. ---

  destroyed_enemy_flagship_or_warsun: ({ state, playerId }) => {
    const met = (state.recentEvents ?? []).some(
      (e) => e.type === "UNITS_DESTROYED" && e.playerId !== playerId && (e.unitType === "war_sun" || e.unitType === "flagship"),
    );
    return { met, reason: met ? undefined : "No enemy war sun or flagship destroyed this tactical action." };
  },

  bombardment_destroyed_last_ground_forces: ({ state, playerId }) => {
    const bombarded = (state.recentEvents ?? []).filter(
      (e): e is Extract<GameEvent, { type: "BOMBARDMENT_RESOLVED" }> =>
        e.type === "BOMBARDMENT_RESOLVED" && e.playerId === playerId && e.hits > 0,
    );
    for (const b of bombarded) {
      const planet = state.systems[b.systemId]?.planets.find((p) => p.planetId === b.planetId);
      if (!planet) continue;
      const stillHasDefenders = Object.entries(planet.unitsByPlayer).some(
        ([pid, stacks]) => pid !== playerId && (stacks ?? []).some((s) => s.count > 0 && GROUND_FORCE_TYPES.includes(s.unitType)),
      );
      if (!stillHasDefenders) return { met: true };
    }
    return { met: false, reason: "No planet where this player's Bombardment wiped out the defender's last ground forces this tactical action." };
  },

  won_combat_vs_vp_leader: ({ state, playerId }) => {
    const nonEliminated = Object.values(state.players).filter((p) => !p.eliminated);
    const maxVP = Math.max(...nonEliminated.map((p) => p.victoryPoints.current));
    for (const { systemId, planetId } of combatsWonThisTurn(state, playerId)) {
      const opponentId = findOpponentInCombat(state, playerId, systemId, planetId);
      if (opponentId && state.players[opponentId]?.victoryPoints.current === maxVP) return { met: true };
    }
    return { met: false, reason: "Didn't win a combat this tactical action against the current victory-point leader (ties count)." };
  },

  space_cannon_destroyed_last_ships: ({ state, playerId }) => {
    const fired = (state.recentEvents ?? []).some(
      (e) => (e.type === "SPACE_CANNON_OFFENSE_FIRED" || e.type === "SPACE_CANNON_DEFENSE_FIRED") && e.playerId === playerId && e.hits > 0,
    );
    if (!fired) return { met: false, reason: "This player hasn't fired a hit-scoring Space Cannon shot this tactical action." };
    const destroyedShips = (state.recentEvents ?? []).filter(
      (e): e is Extract<GameEvent, { type: "UNITS_DESTROYED" }> =>
        e.type === "UNITS_DESTROYED" && e.playerId !== playerId && SHIP_TYPES.includes(e.unitType),
    );
    for (const d of destroyedShips) {
      const remaining = (state.systems[d.systemId]?.spaceUnitsByPlayer[d.playerId] ?? []).reduce((sum, s) => sum + s.count, 0);
      if (remaining === 0) return { met: true };
    }
    return { met: false, reason: "No player's last ship in a system was destroyed by this player's Space Cannon this tactical action." };
  },

  won_space_combat_with_flagship_present: ({ state, playerId }) => {
    const met = (state.recentEvents ?? []).some(
      (e) =>
        e.type === "SPACE_COMBAT_ENDED" &&
        e.survivingPlayerId === playerId &&
        (state.systems[e.systemId]?.spaceUnitsByPlayer[playerId] ?? []).some((s) => s.unitType === "flagship" && s.count > 0),
    );
    return {
      met,
      reason: met ? undefined : "Didn't win a space combat this tactical action in a system with this player's (surviving) flagship.",
    };
  },

  lost_control_of_home_planet: ({ state, rules, playerId }) => {
    const player = state.players[playerId];
    const met = (state.recentEvents ?? []).some(
      (e) =>
        e.type === "PLANET_CONTROL_ESTABLISHED" && e.playerId !== playerId && rules.planets[e.planetId]?.homeFactionId === player.factionId,
    );
    return { met, reason: met ? undefined : "This player hasn't lost control of one of their own home system's planets this tactical action." };
  },

  won_combat_vs_note_holder: ({ state, playerId }) => {
    const heldNoteOwners = new Set(
      (state.players[playerId]?.promissoryNotesInPlayArea ?? [])
        .map((id) => state.promissoryNoteInstances?.[id]?.ownerId)
        .filter((id): id is PlayerId => Boolean(id)),
    );
    for (const { systemId, planetId } of combatsWonThisTurn(state, playerId)) {
      const opponentId = findOpponentInCombat(state, playerId, systemId, planetId);
      if (opponentId && heldNoteOwners.has(opponentId)) return { met: true };
    }
    return {
      met: false,
      reason: "Didn't win a combat this tactical action against a player whose promissory note this player holds in their play area.",
    };
  },

  won_combat_in_anomaly: ({ state, playerId }) => {
    const met = combatsWonThisTurn(state, playerId).some(({ systemId }) => (state.systems[systemId]?.anomalies.length ?? 0) > 0);
    return { met, reason: met ? undefined : "Didn't win a combat this tactical action in an anomaly." };
  },

  won_combat_in_eliminated_home: ({ state, rules, playerId }) => {
    const met = combatsWonThisTurn(state, playerId).some(({ systemId }) => {
      const homeFactionId = state.systems[systemId]?.planets.map((p) => rules.planets[p.planetId]?.homeFactionId).find(Boolean);
      if (!homeFactionId) return false;
      return Object.values(state.players).some((p) => p.factionId === homeFactionId && p.eliminated);
    });
    return { met, reason: met ? undefined : "Didn't win a combat this tactical action in an eliminated player's home system." };
  },

  afb_destroyed_last_fighters: ({ state, playerId }) => {
    const fired = (state.recentEvents ?? []).some((e) => e.type === "ANTI_FIGHTER_BARRAGE_FIRED" && e.playerId === playerId && e.hits > 0);
    if (!fired) return { met: false, reason: "This player hasn't fired a hit-scoring Anti-Fighter Barrage this tactical action." };
    const destroyedFighters = (state.recentEvents ?? []).filter(
      (e): e is Extract<GameEvent, { type: "UNITS_DESTROYED" }> =>
        e.type === "UNITS_DESTROYED" && e.playerId !== playerId && e.unitType === "fighter",
    );
    for (const d of destroyedFighters) {
      const remaining = (state.systems[d.systemId]?.spaceUnitsByPlayer[d.playerId] ?? [])
        .filter((s) => s.unitType === "fighter")
        .reduce((sum, s) => sum + s.count, 0);
      if (remaining === 0) return { met: true };
    }
    return { met: false, reason: "No player's last fighter in a system was destroyed by this player's Anti-Fighter Barrage this tactical action." };
  },

  // RR "Status"-timed: this is a plain CURRENT-state check (unlike the
  // "Action"-timed ones above) — any note sitting in a player's play area
  // is, by construction, never their own (see setup/promissoryNotes.ts:
  // a player's OWN notes always start in hand; a note only ever moves to
  // play area when RECEIVED from someone else and its own placeInPlayArea
  // flag says so), so there's no need to separately check ownership here.
  have_another_players_note_in_play_area: ({ state, playerId }) => {
    const met = (state.players[playerId]?.promissoryNotesInPlayArea.length ?? 0) > 0;
    return { met, reason: met ? undefined : "No other player's promissory note in this player's play area." };
  },

  // RR "discard N action cards" (e.g. Form a Spy Network) — lifetime
  // VOLUNTARY-discard counter, deliberately NOT incremented by playing a
  // card (see Player.actionCardsDiscardedCount's own doc comment on the
  // ruling behind that distinction).
  discarded_action_cards: ({ state, playerId }, params) => {
    const count = params.count as number;
    const n = state.players[playerId]?.actionCardsDiscardedCount ?? 0;
    return { met: n >= count, reason: n >= count ? undefined : `Only discarded ${n}/${count} action cards.` };
  },
};

/** checkTypes that need a `spend` payload executed as part of scoring, handled directly in scoreObjective rather than here (they mutate state, not just read it). Exported so scoreObjective can tell them apart from OBJECTIVE_CHECKS. */
export const SPEND_CHECK_TYPES = new Set([
  "spend_resources",
  "spend_influence",
  "spend_trade_goods",
  "spend_command_tokens",
  "spend_combined",
  "spend_relic_fragments",
]);
