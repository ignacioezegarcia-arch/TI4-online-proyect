import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, asPlanetId } from "../types/ids";
import { SHIP_TYPES, GROUND_FORCE_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { maybeActivateWormholeNexus } from "../rules/adjacency";
import { isDemilitarizedZone } from "./agendaEffects";
import { drawActionCard } from "./actionCards";
import { checkReinforcementsAvailable } from "../rules/reinforcements";
import { setPlanetController } from "./invasion";
import { isPlayersTurnInWindow, advancePriorityWindowAfterAction } from "../rules/priorityWindow";

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

export function findControlledLegendaryPlanet(
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

export function exhaustLegendaryAbility(state: GameState, systemId: SystemId, planetId: PlanetId): GameState {
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
    // RR "Demilitarized Zone": this project's other "place a ground force
    // on a planet" call sites (commitGroundForces, executeProduction,
    // useTransitDiodes) all check this — this shared helper (used by
    // Atrament and Imperial Arms Vault) previously didn't.
    if (isDemilitarizedZone(planet)) return { ok: false, error: 'RR "Demilitarized Zone": units cannot be placed on this planet.' };
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

/** Primor / "The Atrament": exhaust to place 2 infantry from reinforcements on any planet this player controls. RR: legendary planet EXHAUST abilities without their own more specific timing default to "at the end of your turn" — confirmed by this project's own user — so this needs the same end_of_turn window gating as The Acropolis/The Galactic Council, not free use any time. Always the player's own explicit choice; never automatic. */
export function useAtrament(
  state: GameState,
  action: { type: "USE_ATRAMENT"; playerId: PlayerId; targetPlanetId: PlanetId },
): ActionResult {
  if (!isPlayersTurnInWindow(state, "end_of_turn", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current end-of-turn priority window." };
  }
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("primor"));
  if ("error" in found) return { ok: false, error: found.error };

  const placed = placeGroundForces(state, action.playerId, action.targetPlanetId, "infantry", 2);
  if (!placed.ok) return placed;

  let nextState = exhaustLegendaryAbility(placed.state, found.systemId, asPlanetId("primor"));
  nextState = advancePriorityWindowAfterAction(nextState, action.playerId);
  const events: GameEvent[] = [
    { type: "UNITS_PRODUCED", playerId: action.playerId, systemId: placed.systemId, planetId: action.targetPlanetId, unitType: "infantry", count: 2, totalCost: 0 },
  ];
  return { ok: true, state: nextState, events };
}

/** Hope's End / "Imperial Arms Vault": exhaust to EITHER place 1 mech from reinforcements on any planet this player controls, OR draw 1 action card — the player's own choice. Same end_of_turn window gating as The Atrament above (RR: no more specific timing on this card, defaults to "at the end of your turn"). */
export function useImperialArmsVault(
  state: GameState,
  action: { type: "USE_IMPERIAL_ARMS_VAULT"; playerId: PlayerId; choice: "mech" | "action_card"; targetPlanetId?: PlanetId },
): ActionResult {
  if (!isPlayersTurnInWindow(state, "end_of_turn", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current end-of-turn priority window." };
  }
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("hopes_end"));
  if ("error" in found) return { ok: false, error: found.error };

  let workingState = state;
  const events: GameEvent[] = [];

  if (action.choice === "mech") {
    if (!action.targetPlanetId) return { ok: false, error: "This choice needs a targetPlanetId." };
    const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: "mech", count: 1 }]);
    if (!reinforcementsCheck.ok) return reinforcementsCheck;
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

  let nextState = exhaustLegendaryAbility(workingState, found.systemId, asPlanetId("hopes_end"));
  nextState = advancePriorityWindowAfterAction(nextState, action.playerId);
  return { ok: true, state: nextState, events };
}

/** Mallice / "Exterrix Headquarters": exhaust to EITHER gain 2 trade goods, OR convert all of this player's commodities to trade goods — the player's own choice. Same end_of_turn window gating (RR: no more specific timing on this card either). */
export function useExterrixHeadquarters(
  state: GameState,
  action: { type: "USE_EXTERRIX_HEADQUARTERS"; playerId: PlayerId; choice: "gain_trade_goods" | "convert_commodities" },
): ActionResult {
  if (!isPlayersTurnInWindow(state, "end_of_turn", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current end-of-turn priority window." };
  }
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("mallice"));
  if ("error" in found) return { ok: false, error: found.error };

  const player = state.players[action.playerId];
  const updatedPlayer: Player =
    action.choice === "gain_trade_goods"
      ? { ...player, tradeGoods: player.tradeGoods + 2 }
      : { ...player, tradeGoods: player.tradeGoods + player.commodities, commodities: 0 };

  const stateWithPlayer: GameState = { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } };
  let nextState = exhaustLegendaryAbility(stateWithPlayer, found.systemId, asPlanetId("mallice"));
  nextState = advancePriorityWindowAfterAction(nextState, action.playerId);
  return { ok: true, state: nextState, events: [] };
}

/** Mirage / "Mirage Flight Academy": exhaust to place up to 2 fighters from reinforcements in any system that contains 1 or more of this player's own ships. */
export function useMirageFlightAcademy(
  state: GameState,
  action: { type: "USE_MIRAGE_FLIGHT_ACADEMY"; playerId: PlayerId; targetSystemId: SystemId; count: number },
  rules: RuleData,
): ActionResult {
  if (!isPlayersTurnInWindow(state, "end_of_turn", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current end-of-turn priority window." };
  }
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("mirage"));
  if ("error" in found) return { ok: false, error: found.error };
  if (action.count < 1 || action.count > 2) return { ok: false, error: 'RR "Mirage Flight Academy": must place 1 or 2 fighters.' };

  const targetSystem = state.systems[action.targetSystemId];
  if (!targetSystem) return { ok: false, error: `No system ${action.targetSystemId}.` };
  const hasOwnShipsThere = (targetSystem.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0);
  if (!hasOwnShipsThere) return { ok: false, error: "This player has no ships in that system." };

  // RR 16.3: these fighters land in the space area same as any other —
  // still capped by the combined capacity of this player's own ships
  // there. Previously unchecked.
  const player = state.players[action.playerId];
  const existingCargo = (targetSystem.spaceUnitsByPlayer[action.playerId] ?? []).reduce((sum, s) => (s.unitType === "fighter" || GROUND_FORCE_TYPES.includes(s.unitType) ? sum + s.count : sum), 0);
  const existingCapacity = (targetSystem.spaceUnitsByPlayer[action.playerId] ?? []).reduce((sum, s) => {
    if (!SHIP_TYPES.includes(s.unitType)) return sum;
    const shipStats = getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades);
    return sum + (shipStats?.capacity ?? 0) * s.count;
  }, 0);
  if (existingCargo + action.count > existingCapacity) {
    return { ok: false, error: `RR 16.3: this would leave ${existingCargo + action.count} fighters/ground forces in ${action.targetSystemId}'s space area, exceeding this player's combined ship capacity there (${existingCapacity}).` };
  }

  const stacks = targetSystem.spaceUnitsByPlayer[action.playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === "fighter" && !s.upgradeId);
  const updatedStacks = existing
    ? stacks.map((s) => (s === existing ? { ...s, count: s.count + action.count } : s))
    : [...stacks, { unitType: "fighter" as const, count: action.count, damagedCount: 0 }];
  const updatedSystem: SystemState = { ...targetSystem, spaceUnitsByPlayer: { ...targetSystem.spaceUnitsByPlayer, [action.playerId]: updatedStacks } };

  let nextState: GameState = { ...state, systems: { ...state.systems, [action.targetSystemId]: updatedSystem } };
  nextState = exhaustLegendaryAbility(nextState, found.systemId, asPlanetId("mirage"));
  nextState = advancePriorityWindowAfterAction(nextState, action.playerId);
  // RR 100.2: placing these fighters directly into the wormhole nexus system also flips it active.
  nextState = maybeActivateWormholeNexus(nextState, rules, action.targetSystemId);

  const events: GameEvent[] = [
    { type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.targetSystemId, planetId: asPlanetId("mirage"), unitType: "fighter", count: action.count, totalCost: 0 },
  ];
  return { ok: true, state: nextState, events };
}

// ---------------------------------------------------------------------
// TE Thunder's Edge legendary planet abilities (6 exhaust-based + Styx's
// own gain/lose VP one, which lives in phases/invasion.ts's own
// setPlanetController instead, right alongside Shard of the Throne's
// similar relic-based transfer — see that function's own doc comment).
// ---------------------------------------------------------------------

/** Ordinian / "4X41D Hyperion VI": exhaust when you pass to draw 1 action card and gain 1 command token (the player's own choice of pool). */
export function use4X41DHyperionVI(
  state: GameState,
  action: { type: "USE_4X41D_HYPERION_VI"; playerId: PlayerId; commandTokenPool: "tactic" | "fleet" | "strategy" },
): ActionResult {
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("ordinian"));
  if ("error" in found) return { ok: false, error: found.error };

  const player = state.players[action.playerId];
  const { tactic, fleet, strategy, onBoard } = player.commandTokens;
  if (tactic + fleet + strategy + onBoard.length >= 16) {
    return { ok: false, error: "This player already has all 16 of their command tokens in play." };
  }
  const updatedPlayer: Player = { ...player, commandTokens: { ...player.commandTokens, [action.commandTokenPool]: player.commandTokens[action.commandTokenPool] + 1 } };

  const draw = drawActionCard(state);
  let workingState: GameState = { ...state, players: { ...state.players, [action.playerId]: updatedPlayer }, actionCardDeck: draw.deck, actionCardDiscardPile: draw.discardPile };
  const events: GameEvent[] = [];
  if (draw.drawn) {
    const finalPlayer = workingState.players[action.playerId];
    workingState = { ...workingState, players: { ...workingState.players, [action.playerId]: { ...finalPlayer, actionCards: [...finalPlayer.actionCards, draw.drawn] } } };
    events.push({ type: "ACTION_CARD_DRAWN", playerId: action.playerId, cardId: draw.drawn });
  }

  const nextState = exhaustLegendaryAbility(workingState, found.systemId, asPlanetId("ordinian"));
  return { ok: true, state: nextState, events };
}

/**
 * Faunus / "Maxis Central Control": exhaust when you pass to gain
 * control of a non-home, non-legendary planet that contains no units
 * and has no attachments. Routed through invasion.ts's own
 * setPlanetController (exported specifically for this reuse) so the
 * normal control-gain consequences (RR 25.1c automatic exploration, the
 * relic-icon draw, Shard of the Throne's own transfer check) all still
 * apply exactly as they would from any other route to control.
 */
export function useMaxisCentralControl(
  state: GameState,
  action: { type: "USE_MAXIS_CENTRAL_CONTROL"; playerId: PlayerId; targetPlanetId: PlanetId; chosenTrait?: "cultural" | "industrial" | "hazardous" },
  rules: RuleData,
): ActionResult {
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("faunus"));
  if ("error" in found) return { ok: false, error: found.error };

  let targetFound: { systemId: SystemId; planet: PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === action.targetPlanetId);
    if (planet) {
      targetFound = { systemId: systemId as SystemId, planet };
      break;
    }
  }
  if (!targetFound) return { ok: false, error: `No planet ${action.targetPlanetId}.` };
  if (rules.planets[action.targetPlanetId]?.homeFactionId) return { ok: false, error: "Cannot target a home planet." };
  if (rules.planets[action.targetPlanetId]?.isLegendary) return { ok: false, error: "Cannot target a legendary planet." };
  const hasAnyUnits = Object.values(targetFound.planet.unitsByPlayer).some((stacks) => (stacks ?? []).some((s) => s.count > 0));
  if (hasAnyUnits) return { ok: false, error: "That planet must contain no units." };
  if (targetFound.planet.attachmentIds.length > 0) return { ok: false, error: "That planet must have no attachments." };

  const controlResult = setPlanetController(state, targetFound.systemId, action.targetPlanetId, action.playerId, rules, action.chosenTrait);
  const nextState = exhaustLegendaryAbility(controlResult.state, found.systemId, asPlanetId("faunus"));
  return { ok: true, state: nextState, events: [...controlResult.events, { type: "PLANET_CONTROL_ESTABLISHED", systemId: targetFound.systemId, planetId: action.targetPlanetId, playerId: action.playerId }] };
}

/**
 * Garbozia / "Dok'N Pic's Salvage Yard": exhaust when you pass to place
 * 1 action card from the discard pile faceup on this card; separately,
 * purge cards stored on this card to play them as if they were in hand
 * — 2 distinct actions sharing the same "cards live on the planet
 * itself" storage (PlanetState.storedActionCardIds).
 */
export function useDokNPicsSalvageYardStore(state: GameState, action: { type: "USE_DOK_N_PICS_SALVAGE_YARD_STORE"; playerId: PlayerId; cardId: string }): ActionResult {
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("garbozia"));
  if ("error" in found) return { ok: false, error: found.error };
  const discard = state.actionCardDiscardPile ?? [];
  if (!discard.includes(action.cardId as never)) return { ok: false, error: `${action.cardId} isn't in the action card discard pile.` };

  const updatedPlanet: PlanetState = { ...found.planet, storedActionCardIds: [...(found.planet.storedActionCardIds ?? []), action.cardId] };
  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === asPlanetId("garbozia") ? updatedPlanet : p)) };
  let nextState: GameState = { ...state, systems: { ...state.systems, [found.systemId]: updatedSystem }, actionCardDiscardPile: discard.filter((id) => id !== action.cardId) as never };
  nextState = exhaustLegendaryAbility(nextState, found.systemId, asPlanetId("garbozia"));
  return { ok: true, state: nextState, events: [] };
}

/** Garbozia / "Dok'N Pic's Salvage Yard": the purge-and-play half — doesn't touch legendaryAbilityExhausted at all (that's only for the STORE half above; playing a stored card is unrestricted by the ability's own ready/exhaust state). */
export function useDokNPicsSalvageYardPlay(state: GameState, action: { type: "USE_DOK_N_PICS_SALVAGE_YARD_PLAY"; playerId: PlayerId; cardId: string }): ActionResult {
  let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === asPlanetId("garbozia"));
    if (planet) {
      found = { systemId: systemId as SystemId, system, planet };
      break;
    }
  }
  if (!found || found.planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control Garbozia." };
  if (!(found.planet.storedActionCardIds ?? []).includes(action.cardId)) return { ok: false, error: `${action.cardId} isn't stored on Dok'N Pic's Salvage Yard.` };

  const updatedPlanet: PlanetState = { ...found.planet, storedActionCardIds: (found.planet.storedActionCardIds ?? []).filter((id) => id !== action.cardId) };
  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === asPlanetId("garbozia") ? updatedPlanet : p)) };
  return { ok: true, state: { ...state, systems: { ...state.systems, [found.systemId]: updatedSystem } }, events: [] };
}

/**
 * Emelpar / "The Acropolis": exhaust at the end of your turn to ready
 * another component that isn't a strategy card — deliberately broad
 * (planet, relic, tech, another leader). This implementation covers the
 * concrete component kinds this project actually models as
 * exhaustable/readyable; anything not listed just isn't a valid target.
 */
export function useTheAcropolis(
  state: GameState,
  action: { type: "USE_THE_ACROPOLIS"; playerId: PlayerId; target: { kind: "planet"; planetId: PlanetId } | { kind: "relic"; relicId: string } | { kind: "technology"; techId: import("../types/ids").TechId } | { kind: "leader"; leaderId: string } },
): ActionResult {
  // RR "The Acropolis": "at the end of your turn" — not a generic "EXHAUST:" any-time ability like The Atrament/Imperial Arms Vault/Exterrix Headquarters; only usable during the end_of_turn window (opened by actionPhase.ts's own pass()/maybeAdvanceActivePlayer, same infrastructure TE "Crisis" and "Puppets on a String" use).
  if (!isPlayersTurnInWindow(state, "end_of_turn", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current end-of-turn priority window." };
  }
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("emelpar"));
  if ("error" in found) return { ok: false, error: found.error };

  let nextState = state;
  const player = state.players[action.playerId];
  const target = action.target;
  if (target.kind === "planet") {
    let readied = false;
    for (const [systemId, system] of Object.entries(nextState.systems)) {
      const idx = system.planets.findIndex((p) => p.planetId === target.planetId && p.controllerId === action.playerId);
      if (idx >= 0) {
        const updatedPlanets = system.planets.map((p, i) => (i === idx ? { ...p, exhausted: false } : p));
        nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, planets: updatedPlanets } } };
        readied = true;
        break;
      }
    }
    if (!readied) return { ok: false, error: "This player doesn't control that planet." };
  } else if (target.kind === "relic") {
    if (!(player.exhaustedRelics ?? []).includes(target.relicId as never)) return { ok: false, error: "That relic isn't exhausted." };
    nextState = { ...nextState, players: { ...nextState.players, [action.playerId]: { ...player, exhaustedRelics: (player.exhaustedRelics ?? []).filter((id) => id !== target.relicId) } } };
  } else if (target.kind === "technology") {
    if (!player.exhaustedTechnologies.includes(target.techId)) return { ok: false, error: "That technology isn't exhausted." };
    nextState = { ...nextState, players: { ...nextState.players, [action.playerId]: { ...player, exhaustedTechnologies: player.exhaustedTechnologies.filter((id) => id !== target.techId) } } };
  } else {
    const leaderEntry = player.leaders.find((l) => l.leaderId === target.leaderId);
    if (!leaderEntry?.exhausted) return { ok: false, error: "That leader isn't exhausted." };
    nextState = { ...nextState, players: { ...nextState.players, [action.playerId]: { ...player, leaders: player.leaders.map((l) => (l.leaderId === target.leaderId ? { ...l, exhausted: false } : l)) } } };
  }

  nextState = exhaustLegendaryAbility(nextState, found.systemId, asPlanetId("emelpar"));
  nextState = advancePriorityWindowAfterAction(nextState, action.playerId);
  return { ok: true, state: nextState, events: [] };
}

/**
 * Industrex / "Aeurex Mechanica": exhaust when you pass to place 1 ship
 * that matches a unit upgrade technology this player owns from their
 * reinforcements into a system that contains their own ships.
 */
export function useAeurexMechanica(
  state: GameState,
  action: { type: "USE_AEUREX_MECHANICA"; playerId: PlayerId; unitUpgradeId: import("../types/ids").UnitUpgradeId; targetSystemId: SystemId },
  rules: RuleData,
): ActionResult {
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("industrex"));
  if ("error" in found) return { ok: false, error: found.error };

  const player = state.players[action.playerId];
  if (!player.unitUpgrades.includes(action.unitUpgradeId)) return { ok: false, error: "This player doesn't own that unit upgrade technology." };
  const upgradeData = rules.unitUpgrades[action.unitUpgradeId];
  if (!upgradeData) return { ok: false, error: "Unknown unit upgrade." };
  const targetSystem = state.systems[action.targetSystemId];
  if (!targetSystem) return { ok: false, error: `No system ${action.targetSystemId}.` };
  const hasOwnShipsThere = (targetSystem.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0);
  if (!hasOwnShipsThere) return { ok: false, error: "This player has no ships in that system." };
  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: upgradeData.unitType, count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const stacks = targetSystem.spaceUnitsByPlayer[action.playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === upgradeData.unitType && s.upgradeId === action.unitUpgradeId);
  const updatedStacks = existing
    ? stacks.map((s) => (s === existing ? { ...s, count: s.count + 1 } : s))
    : [...stacks, { unitType: upgradeData.unitType, count: 1, damagedCount: 0, upgradeId: action.unitUpgradeId }];
  const updatedSystem: SystemState = { ...targetSystem, spaceUnitsByPlayer: { ...targetSystem.spaceUnitsByPlayer, [action.playerId]: updatedStacks } };

  let nextState: GameState = { ...state, systems: { ...state.systems, [action.targetSystemId]: updatedSystem } };
  nextState = exhaustLegendaryAbility(nextState, found.systemId, asPlanetId("industrex"));
  nextState = maybeActivateWormholeNexus(nextState, rules, action.targetSystemId);

  return {
    ok: true,
    state: nextState,
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.targetSystemId, planetId: asPlanetId("industrex"), unitType: upgradeData.unitType, count: 1, totalCost: 0 }],
  };
}

/**
 * Mecatol Rex / "The Galactic Council" (TE: Mecatol Rex itself becomes
 * legendary — see setup/createGame.ts's own tile-112-vs-tile-18
 * selection fix): "You may exhaust this card and discard 1 secret
 * objective at the end of your turn to draw 1 secret objective." Same
 * end_of_turn window gating as The Acropolis — not a generic "EXHAUST:"
 * any-time ability.
 */
export function useTheGalacticCouncil(
  state: GameState,
  action: { type: "USE_THE_GALACTIC_COUNCIL"; playerId: PlayerId; discardedSecretObjectiveId: string },
): ActionResult {
  if (!isPlayersTurnInWindow(state, "end_of_turn", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current end-of-turn priority window." };
  }
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("mecatol_rex"));
  if ("error" in found) return { ok: false, error: found.error };

  const player = state.players[action.playerId];
  if (!player.secretObjectives.includes(action.discardedSecretObjectiveId as never)) {
    return { ok: false, error: "This player doesn't have that secret objective." };
  }
  if (player.victoryPoints.scoredObjectiveIds.includes(action.discardedSecretObjectiveId as never)) {
    return { ok: false, error: "Cannot discard an already-scored secret objective." };
  }
  const deck = state.secretObjectiveDeck ?? [];
  if (deck.length === 0) return { ok: false, error: "The secret objective deck is empty." };

  const [drawnId, ...restDeck] = deck;
  const updatedPlayer: Player = {
    ...player,
    secretObjectives: [...player.secretObjectives.filter((id) => id !== action.discardedSecretObjectiveId), drawnId],
  };
  let nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer },
    secretObjectiveDeck: [...restDeck, action.discardedSecretObjectiveId as never],
  };
  nextState = exhaustLegendaryAbility(nextState, found.systemId, asPlanetId("mecatol_rex"));
  nextState = advancePriorityWindowAfterAction(nextState, action.playerId);
  return { ok: true, state: nextState, events: [] };
}

/**
 * Thunder's Edge / "Jupiter Brain": "You may exhaust this card at the
 * end of your turn to perform 1 action." CORRECTED — a previous session
 * note wrongly claimed Thunder's Edge had no legendary ability at all;
 * confirmed via FFG's own official preview and ti4.dronz.co's reference
 * page. Same end_of_turn window gating as The Acropolis/The Galactic
 * Council. Reuses Player.masterPlanBonusAvailable (the same flag Master
 * Plan itself sets) for the actual "grants 1 more action" mechanism —
 * see actionPhase.ts's own finishEndOfTurn, fixed in this same pass to
 * actually check that flag once this window closes (previously it
 * would have been silently ignored).
 *
 * The OTHER half of this card ("gain your breakthrough... if you do not
 * already have it") isn't a player choice at all — it's a mandatory
 * on-gain trigger, handled separately in phases/expedition.ts's own
 * completeThunderEdgeExpedition, not here.
 */
export function useJupiterBrain(state: GameState, action: { type: "USE_JUPITER_BRAIN"; playerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "end_of_turn", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current end-of-turn priority window." };
  }
  const found = findControlledLegendaryPlanet(state, action.playerId, asPlanetId("thunders_edge"));
  if ("error" in found) return { ok: false, error: found.error };

  const player = state.players[action.playerId];
  let nextState: GameState = { ...state, players: { ...state.players, [action.playerId]: { ...player, masterPlanBonusAvailable: true } } };
  nextState = exhaustLegendaryAbility(nextState, found.systemId, asPlanetId("thunders_edge"));
  nextState = advancePriorityWindowAfterAction(nextState, action.playerId);
  return { ok: true, state: nextState, events: [] };
}
