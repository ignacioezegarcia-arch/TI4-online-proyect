import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { GameEvent } from "../types/Actions";
import { PlayerId, SystemId, NEUTRAL_PLAYER_ID } from "../types/ids";
import { UnitType } from "../types/enums";
import { RuleData } from "../types/RuleData";

const FRACTURE_SYSTEM_IDS: SystemId[] = ["125", "126", "127"] as SystemId[];

const GUARDIAN_KEY_TO_UNIT_TYPE: Record<string, UnitType> = {
  infantry: "infantry",
  fighters: "fighter",
  cruisers: "cruiser",
  carriers: "carrier",
  destroyers: "destroyer",
  dreadnoughts: "dreadnought",
  war_suns: "war_sun",
  pds: "pds",
  mechs: "mech",
};

/**
 * TE The Fracture (rulebook p.9): "they then place neutral units as
 * indicated on the back of The Fracture's tiles." Ground forces
 * (infantry) go on that system's own planet (each of the 3 Fracture
 * systems has exactly 0 or 1 planet with guardians, per this project's
 * own tiles.json data); every other unit type goes in the system's
 * space area. Uses NEUTRAL_PLAYER_ID (see types/ids.ts) so this reuses
 * every existing per-player unit-stack helper unmodified.
 */
export function placeFractureNeutralUnits(state: GameState, rules: RuleData): GameState {
  let systems = state.systems;
  for (const systemId of FRACTURE_SYSTEM_IDS) {
    const system = systems[systemId];
    const guardians = rules.fractureNeutralGuardians[systemId];
    if (!system || !guardians) continue;

    let updatedSystem: SystemState = system;
    let planets = system.planets;
    for (const [key, count] of Object.entries(guardians)) {
      if (!count) continue;
      const unitType = GUARDIAN_KEY_TO_UNIT_TYPE[key];
      if (!unitType) continue;
      if (unitType === "infantry" && planets.length > 0) {
        const targetPlanet = planets[0];
        const stacks = targetPlanet.unitsByPlayer[NEUTRAL_PLAYER_ID] ?? [];
        const updatedPlanet: PlanetState = { ...targetPlanet, unitsByPlayer: { ...targetPlanet.unitsByPlayer, [NEUTRAL_PLAYER_ID]: [...stacks, { unitType, count, damagedCount: 0 }] } };
        planets = planets.map((p) => (p.planetId === targetPlanet.planetId ? updatedPlanet : p));
      } else {
        const stacks = updatedSystem.spaceUnitsByPlayer[NEUTRAL_PLAYER_ID] ?? [];
        updatedSystem = { ...updatedSystem, spaceUnitsByPlayer: { ...updatedSystem.spaceUnitsByPlayer, [NEUTRAL_PLAYER_ID]: [...stacks, { unitType, count, damagedCount: 0 }] } };
      }
    }
    updatedSystem = { ...updatedSystem, planets };
    systems = { ...systems, [systemId]: updatedSystem };
  }
  return { ...state, systems };
}

/**
 * TE The Fracture: called once, right when fractureInPlay actually flips
 * true (from rules/breakthroughs.ts's own grantBreakthrough, on a die
 * roll of 1 or 10) — places every Fracture system's neutral guardians in
 * one pass, and opens the pending ingress-token choice for the
 * triggering player (see PendingFractureIngressChoice on GameState and
 * placeIngressTokens below for how that choice actually gets resolved).
 */
export function setUpFractureOnEntry(state: GameState, rules: RuleData, triggeringPlayerId: PlayerId): { state: GameState; events: GameEvent[] } {
  const withNeutrals = placeFractureNeutralUnits(state, rules);
  const player = state.players[triggeringPlayerId];
  const synergy = player?.hasBreakthrough ? rules.factions[player.factionId]?.breakthroughSynergy ?? null : null;

  const nextState: GameState = {
    ...withNeutrals,
    pendingFractureIngressChoice: { playerId: triggeringPlayerId, synergyColors: synergy },
  };
  return { state: nextState, events: [{ type: "FRACTURE_NEUTRAL_UNITS_PLACED" }] };
}

/**
 * TE The Fracture (rulebook p.9): the player who rolled the Fracture
 * into play chooses where its ingress tokens go —
 *   - WITH synergy: up to 3 systems per synergy color (6 max total) that
 *     each contain a planet with that color's tech specialty ("if able" —
 *     fewer is fine if that many don't exist).
 *   - WITHOUT synergy (e.g. a breakthrough gained some other way, with no
 *     synergy pair — the rulebook's own example is the Nekro Virus):
 *     exactly 4 planets, each in a different system, each with a
 *     DIFFERENT tech specialty color. If fewer than 4 distinct colors
 *     exist among the player's candidate choices, the remaining tokens
 *     just aren't placed.
 * A system can never have more than 1 ingress token, regardless of path.
 * Finally — always, either way — an ingress token goes in the Thunder's
 * Edge system if it's already been placed, or Mecatol Rex's system
 * otherwise.
 */
export function placeIngressTokens(
  state: GameState,
  action: { type: "PLACE_INGRESS_TOKENS"; playerId: PlayerId; systemIds: SystemId[] },
  rules: RuleData,
): { ok: true; state: GameState; events: GameEvent[] } | { ok: false; error: string } {
  const pending = state.pendingFractureIngressChoice;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "TE The Fracture: no pending ingress-token choice for this player." };
  }

  const uniqueChosen = Array.from(new Set(action.systemIds));
  for (const systemId of uniqueChosen) {
    if (state.systems[systemId]?.ingressToken) {
      return { ok: false, error: `${systemId} already has an ingress token.` };
    }
  }

  const planetSpecialtyColors = (systemId: SystemId): string[] =>
    (state.systems[systemId]?.planets ?? []).flatMap((p) => rules.planets[p.planetId]?.techSpecialties ?? []);

  if (pending.synergyColors) {
    const [colorA, colorB] = pending.synergyColors;
    const countA = uniqueChosen.filter((id) => planetSpecialtyColors(id).includes(colorA)).length;
    const countB = uniqueChosen.filter((id) => planetSpecialtyColors(id).includes(colorB)).length;
    if (uniqueChosen.length > 6 || countA > 3 || countB > 3) {
      return { ok: false, error: "TE The Fracture: at most 3 systems per synergy color (6 total)." };
    }
    if (uniqueChosen.some((id) => !planetSpecialtyColors(id).includes(colorA) && !planetSpecialtyColors(id).includes(colorB))) {
      return { ok: false, error: "TE The Fracture: every chosen system must contain a planet with one of the 2 synergy colors' specialty." };
    }
  } else {
    if (uniqueChosen.length > 4) {
      return { ok: false, error: "TE The Fracture: at most 4 systems (no synergy)." };
    }
    const colorsUsed = new Set<string>();
    for (const systemId of uniqueChosen) {
      const colors = planetSpecialtyColors(systemId);
      const newColor = colors.find((c) => !colorsUsed.has(c));
      if (!newColor) {
        return { ok: false, error: `TE The Fracture: ${systemId} doesn't contribute a NEW technology specialty color — each of the 4 must be different.` };
      }
      colorsUsed.add(newColor);
    }
  }

  let systems = state.systems;
  for (const systemId of uniqueChosen) {
    systems = { ...systems, [systemId]: { ...systems[systemId], ingressToken: true } };
  }

  // "Finally, the players place an ingress token in the Thunder's Edge
  // system, if it is in play, or in the Mecatol Rex system, if the
  // expedition has not been completed."
  const thunderEdgeSystemId = Object.entries(systems).find(([, sys]) => sys.planets.some((p) => p.planetId === ("thunders_edge" as never)))?.[0] as SystemId | undefined;
  const mecatolSystemId = Object.entries(systems).find(([, sys]) => sys.planets.some((p) => rules.planets[p.planetId]?.isMecatolRex))?.[0] as SystemId | undefined;
  const autoIngressTarget = state.thunderEdgeExpedition.completed && thunderEdgeSystemId ? thunderEdgeSystemId : mecatolSystemId;
  if (autoIngressTarget && !systems[autoIngressTarget]?.ingressToken) {
    systems = { ...systems, [autoIngressTarget]: { ...systems[autoIngressTarget], ingressToken: true } };
  }

  const nextState: GameState = { ...state, systems, pendingFractureIngressChoice: undefined };
  return { ok: true, state: nextState, events: [{ type: "INGRESS_TOKENS_PLACED", playerId: action.playerId, systemIds: [...uniqueChosen, ...(autoIngressTarget ? [autoIngressTarget] : [])] }] };
}
