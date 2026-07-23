import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, asPlanetId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { maybeActivateWormholeNexus } from "../rules/adjacency";
import { drawActionCard } from "./actionCards";

/**
 * RR 53 LEGENDARY PLANETS: each of the 4 legendary planets has its own
 * ability CARD, separate from the planet card itself (RR 53.2/64.5) — its
 * own exhausted state (PlanetState.legendaryAbilityExhausted), readied
 * independently. RR 25.1/53.2's own rule on what happens to each when
 * control changes hands is already handled in phases/invasion.ts's
 * setPlanetController (readies only if this is the FIRST time it's ever
 * been controlled, i.e. straight from the deck; stays exhausted if it's
 * being taken FROM another player). This file is just the 4 abilities
 * themselves, one dedicated handler each (not worth a generic dispatcher —
 * each does something different, and there will only ever be exactly 4).
 *
 * None of these are component actions ("ACTION:") — they're plain
 * exhaust-to-resolve abilities, offered any time during the action phase,
 * same as several standalone technology abilities elsewhere in this project.
 */

function findControlledLegendaryPlanet(
  state: GameState,
  playerId: PlayerId,
  planetId: PlanetId,
): { systemId: SystemId; system: SystemState; planet: PlanetState } | { error: string } {
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === planetId);
    if (planet) {
      if (planet.controllerId !== playerId) return { error: `This player doesn't control ${planetId}.` };
      if (planet.legendaryAbilityExhausted) return { error: `${planetId}'s legendary ability is already exhausted.` };
      return { systemId: systemId as SystemId, system, planet };
    }
  }
  return { error: `No planet ${planetId} on the board.` };
}

function exhaustLegendaryAbility(state: GameState, systemId: SystemId, planetId: PlanetId): GameState {
  const system = state.systems[systemId];
  const updatedSystem: SystemState = {
    ...system,
    planets: system.planets.map((p) => (p.planetId === planetId ? { ...p, legendaryAbilityExhausted: true } : p)),
  };
  return { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
}

function placeGroundForces(
  state: GameState,
  playerId: PlayerId,
  targetPlanetId: PlanetId,
  unitType: "infantry" | "mech",
  count: number,
): { ok: true; state: GameState; systemId: SystemId } | { ok: false; error: string } {
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === targetPlanetId);
    if (!planet) continue;
    if (planet.controllerId !== playerId) return { ok: false, error: `This player doesn't control ${targetPlanetId}.` };
    const stacks = planet.unitsByPlayer[playerId] ?? [];
    const existing = stacks.find((s) => s.unitType === unitType && !s.upgradeId);
    const updatedStacks = existing
      ? stacks.map((s) => (s === existing ? { ...s, count: s.count + count } : s))
      : [...stacks, { unitType, count, damagedCount: 0 }];
    const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [playerId]: updatedStacks } };
    const updatedSystem: SystemState = { ...system, planets: system.planets.map((p) => (p.planetId === targetPlanetId ? updatedPlanet : p)) };
    return { ok: true, state: { ...state, systems: { ...state.systems, [systemId as SystemId]: updatedSystem } }, systemId: systemId as SystemId };
  }
  return { ok: false, error: `No planet ${targetPlanetId} on the board.` };
}

/** Primor / "The Atrament": exhaust to place 2 infantry from reinforcements on any planet this player controls. */
export function useAtrament(
  state: GameState,
  action: { type: "USE_ATRAMENT"; playerId: PlayerId; targetPlanetId: PlanetId },
): ActionResult {
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("primor"));
  if ("error" in found) return { ok: false, error: found.error };

  const placed = placeGroundForces(state, action.playerId, action.targetPlanetId, "infantry", 2);
  if (!placed.ok) return placed;

  const nextState = exhaustLegendaryAbility(placed.state, found.systemId, asPlanetId("primor"));
  const events: GameEvent[] = [
    { type: "UNITS_PRODUCED", playerId: action.playerId, systemId: placed.systemId, planetId: action.targetPlanetId, unitType: "infantry", count: 2, totalCost: 0 },
  ];
  return { ok: true, state: nextState, events };
}

/** Hope's End / "Imperial Arms Vault": exhaust to EITHER place 1 mech from reinforcements on any planet this player controls, OR draw 1 action card — the player's own choice. */
export function useImperialArmsVault(
  state: GameState,
  action: { type: "USE_IMPERIAL_ARMS_VAULT"; playerId: PlayerId; choice: "mech" | "action_card"; targetPlanetId?: PlanetId },
): ActionResult {
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("hopes_end"));
  if ("error" in found) return { ok: false, error: found.error };

  let workingState = state;
  const events: GameEvent[] = [];

  if (action.choice === "mech") {
    if (!action.targetPlanetId) return { ok: false, error: "This choice needs a targetPlanetId." };
    const placed = placeGroundForces(state, action.playerId, action.targetPlanetId, "mech", 1);
    if (!placed.ok) return placed;
    workingState = placed.state;
    events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: placed.systemId, planetId: action.targetPlanetId, unitType: "mech", count: 1, totalCost: 0 });
  } else {
    const draw = drawActionCard(workingState);
    workingState = { ...workingState, actionCardDeck: draw.deck, actionCardDiscardPile: draw.discardPile };
    if (draw.drawn) {
      const player = workingState.players[action.playerId];
      workingState = { ...workingState, players: { ...workingState.players, [action.playerId]: { ...player, actionCards: [...player.actionCards, draw.drawn] } } };
      events.push({ type: "ACTION_CARD_DRAWN", playerId: action.playerId, cardId: draw.drawn });
    }
  }

  const nextState = exhaustLegendaryAbility(workingState, found.systemId, asPlanetId("hopes_end"));
  return { ok: true, state: nextState, events };
}

/** Mallice / "Exterrix Headquarters": exhaust to EITHER gain 2 trade goods, OR convert all of this player's commodities to trade goods — the player's own choice. */
export function useExterrixHeadquarters(
  state: GameState,
  action: { type: "USE_EXTERRIX_HEADQUARTERS"; playerId: PlayerId; choice: "gain_trade_goods" | "convert_commodities" },
): ActionResult {
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("mallice"));
  if ("error" in found) return { ok: false, error: found.error };

  const player = state.players[action.playerId];
  const updatedPlayer: Player =
    action.choice === "gain_trade_goods"
      ? { ...player, tradeGoods: player.tradeGoods + 2 }
      : { ...player, tradeGoods: player.tradeGoods + player.commodities, commodities: 0 };

  const stateWithPlayer: GameState = { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } };
  const nextState = exhaustLegendaryAbility(stateWithPlayer, found.systemId, asPlanetId("mallice"));
  return { ok: true, state: nextState, events: [] };
}

/** Mirage / "Mirage Flight Academy": exhaust to place up to 2 fighters from reinforcements in any system that contains 1 or more of this player's own ships. */
export function useMirageFlightAcademy(
  state: GameState,
  action: { type: "USE_MIRAGE_FLIGHT_ACADEMY"; playerId: PlayerId; targetSystemId: SystemId; count: number },
  rules: RuleData,
): ActionResult {
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("mirage"));
  if ("error" in found) return { ok: false, error: found.error };
  if (action.count < 1 || action.count > 2) return { ok: false, error: 'RR "Mirage Flight Academy": must place 1 or 2 fighters.' };

  const targetSystem = state.systems[action.targetSystemId];
  if (!targetSystem) return { ok: false, error: `No system ${action.targetSystemId}.` };
  const hasOwnShipsThere = (targetSystem.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0);
  if (!hasOwnShipsThere) return { ok: false, error: "This player has no ships in that system." };

  const stacks = targetSystem.spaceUnitsByPlayer[action.playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === "fighter" && !s.upgradeId);
  const updatedStacks = existing
    ? stacks.map((s) => (s === existing ? { ...s, count: s.count + action.count } : s))
    : [...stacks, { unitType: "fighter" as const, count: action.count, damagedCount: 0 }];
  const updatedSystem: SystemState = { ...targetSystem, spaceUnitsByPlayer: { ...targetSystem.spaceUnitsByPlayer, [action.playerId]: updatedStacks } };

  let nextState: GameState = { ...state, systems: { ...state.systems, [action.targetSystemId]: updatedSystem } };
  nextState = exhaustLegendaryAbility(nextState, found.systemId, asPlanetId("mirage"));
  // RR 100.2: placing these fighters directly into the wormhole nexus system also flips it active.
  nextState = maybeActivateWormholeNexus(nextState, rules, action.targetSystemId);

  const events: GameEvent[] = [
    { type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.targetSystemId, planetId: asPlanetId("mirage"), unitType: "fighter", count: action.count, totalCost: 0 },
  ];
  return { ok: true, state: nextState, events };
}
