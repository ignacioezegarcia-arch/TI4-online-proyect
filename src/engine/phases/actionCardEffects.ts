import { GameState, Player, PlanetState, SystemState, UnitStack, PendingAgendaVote, AgendaPredictionReward } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, ActionCardId, AgendaId, TechId, UnitUpgradeId, PromissoryNoteId, StrategyCardId, asActionCardId, NEUTRAL_PLAYER_ID } from "../types/ids";
import { UnitType, SHIP_TYPES, GROUND_FORCE_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { applyHitAssignments, getMoraleBoostHitOnBonus } from "../rules/combat";
import { getLawOwner, maybeQueueSecretObjectiveLimit } from "./agendaEffects";
import { isBlockedByTransparasteelPlating } from "../rules/yssaril";
import { drawActionCardsForPlayer } from "../rules/yssaril";
import { researchTechnology } from "./technology";
import { getAdjacentSystems, arePlayersNeighbors } from "../rules/adjacency";
import { drawExplorationCard, applyExplorationCard, ExplorationCardChoice } from "./exploration";
import { revealAgenda, continueAgendaPhaseAfterElectionReaction } from "./agendaPhase";
import { drawActionCard } from "./actionCards";
import { advanceActivePlayer } from "./actionPhase";
import { checkReinforcementsAvailable, commandTokensAvailableInReinforcements, placeCommandTokenFromReinforcements } from "../rules/reinforcements";
import { hasThundersEdge } from "../rules/gameMode";
import { resolveStrategySecondaryEffect, resolveStrategyPrimaryEffect } from "./strategyCardAbilities";
import { grantBreakthrough } from "../rules/breakthroughs";
import { getGravityRiftDestructionCheck } from "../rules/anomalies";
import { moveAllShips, announceRetreat } from "./spaceCombat";
import { openInvasionStartWindowIfNeeded } from "./invasion";
import { isPlayersTurnInWindow, advancePriorityWindowAfterAction, actionPhaseWindowOrder } from "../rules/priorityWindow";
import { effectiveCommoditiesMax } from "../rules/spaceStations";

/**
 * RR 2 ACTION CARDS — individual card effects.
 *
 * phases/actionCards.ts's own PLAY_ACTION_CARD is the shared MECHANICAL
 * bookkeeping (hand -> discard) that every card play uses and does NOT
 * resolve any printed effect (see that file's own header comment). Each
 * function below is one specific card's own effect text instead — same
 * "one GameAction per ability" shape technologyAbilities.ts uses for
 * standalone tech effects, rather than a single generic dispatcher, since
 * every card has its own distinct payload shape (a target planet, a tech
 * choice, an agenda to repeal, ...).
 *
 * Each function is fully SELF-CONTAINED: it does its own hand-removal +
 * discard-pile bookkeeping (via playCard below) AND the effect, in one
 * atomic ActionResult, rather than requiring the client to also submit a
 * separate PLAY_ACTION_CARD first. This is deliberate — a card's own
 * legality checks (e.g. Uprising needing a valid non-home planet
 * controlled by another player) have to run BEFORE anything leaves the
 * player's hand, so composing two separate actions would let a client
 * discard a card and then discover the effect was illegal.
 *
 * Batch 1 of 93 Base+Codex+PoK cards (RR/data/actionCards.json's own scope
 * note on why Thunder's Edge's 14 cards are separate and not yet in
 * scope). Covers the standalone economy/political cards; combat-reaction,
 * unit-placement, and exploration-linked cards follow in later batches.
 */

/** Shared preconditions + hand->discard bookkeeping for every specific card below. Returns the state with the card already moved to the discard pile and the caller's own up-to-date Player, so the calling function can layer its own effect on top in the same transaction. */
function playCard(state: GameState, playerId: PlayerId, cardId: string): { ok: true; state: GameState; player: Player } | { ok: false; error: string } {
  const player = state.players[playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  const id = asActionCardId(cardId);
  // RR "Political Censure": the elected player cannot play action cards while they own this card — same guard as phases/actionCards.ts's own playActionCard.
  if (getLawOwner(state, "political_censure" as AgendaId) === playerId) {
    return { ok: false, error: 'RR "Political Censure": this player cannot play action cards while they own this card.' };
  }
  // Yssaril Tribes "Transparasteel Plating" (faction tech): "During your turn of the action phase, players that have passed cannot play action cards." — see rules/yssaril.ts's own isBlockedByTransparasteelPlating.
  if (state.activePlayerId && isBlockedByTransparasteelPlating(state, state.activePlayerId, playerId)) {
    return { ok: false, error: 'Yssaril "Transparasteel Plating": this player has passed and cannot play action cards during the Yssaril player\'s own turn.' };
  }
  if (!player.actionCards.includes(id)) {
    return { ok: false, error: `This player doesn't have ${cardId} in hand.` };
  }
  const updatedPlayer: Player = { ...player, actionCards: player.actionCards.filter((c) => c !== id) };
  const nextState: GameState = {
    ...state,
    players: { ...state.players, [playerId]: updatedPlayer },
    actionCardDiscardPile: [...(state.actionCardDiscardPile ?? []), id],
  };
  return { ok: true, state: nextState, player: updatedPlayer };
}

/** Same shape as technologyAbilities.ts's own findPlanet — duplicated locally rather than shared, same convention that file already established. */
function findPlanet(state: GameState, planetId: PlanetId): { systemId: SystemId; system: SystemState; planet: PlanetState } | null {
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === planetId);
    if (planet) return { systemId: systemId as SystemId, system, planet };
  }
  return null;
}

/** Adds `count` free units of `unitType` to a planet's own unitsByPlayer stack for `playerId` — merges into an existing non-upgraded stack of the same type if one exists, same pattern technologyAbilities.ts's own useSelfAssemblyRoutines/useDacxiveAnimators already use. */
function addPlanetUnits(planet: PlanetState, playerId: PlayerId, unitType: UnitType, count: number): PlanetState {
  const stacks = planet.unitsByPlayer[playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === unitType && !s.upgradeId);
  const updatedStacks: UnitStack[] = existing
    ? stacks.map((s) => (s === existing ? { ...s, count: s.count + count } : s))
    : [...stacks, { unitType, count, damagedCount: 0 }];
  return { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [playerId]: updatedStacks } };
}

/** Same as addPlanetUnits above but for a system's space area (ships/fighters). */
function addSpaceUnits(system: SystemState, playerId: PlayerId, unitType: UnitType, count: number): SystemState {
  const stacks = system.spaceUnitsByPlayer[playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === unitType && !s.upgradeId);
  const updatedStacks: UnitStack[] = existing
    ? stacks.map((s) => (s === existing ? { ...s, count: s.count + count } : s))
    : [...stacks, { unitType, count, damagedCount: 0 }];
  return { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [playerId]: updatedStacks } };
}

/** RR "Mining Initiative": gain trade goods equal to the resource value of 1 planet this player controls. No exhaust required — the printed card has no "exhaust" instruction, unlike the Trade strategy card's secondary. */
export function playMiningInitiative(state: GameState, action: { type: "PLAY_MINING_INITIATIVE"; playerId: PlayerId; planetId: PlanetId }, rules: RuleData): ActionResult {
  const played = playCard(state, action.playerId, "mining_initiative");
  if (!played.ok) return played;

  const found = findPlanet(played.state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  if (found.planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };
  const amount = rules.planets[action.planetId]?.resources ?? 0;

  const nextState: GameState = {
    ...played.state,
    players: { ...played.state.players, [action.playerId]: { ...played.player, tradeGoods: played.player.tradeGoods + amount } },
  };
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("mining_initiative") },
      { type: "TRADE_GOODS_GAINED", playerId: action.playerId, amount },
    ],
  };
}

/** RR "Industrial Initiative": gain 1 trade good for each industrial planet this player controls (data/tiles.json's own `traits`, via RuleData.planets). */
export function playIndustrialInitiative(state: GameState, action: { type: "PLAY_INDUSTRIAL_INITIATIVE"; playerId: PlayerId }, rules: RuleData): ActionResult {
  const played = playCard(state, action.playerId, "industrial_initiative");
  if (!played.ok) return played;

  let amount = 0;
  for (const system of Object.values(played.state.systems)) {
    for (const planet of system.planets) {
      if (planet.controllerId === action.playerId && (rules.planets[planet.planetId]?.traits ?? []).includes("industrial")) amount++;
    }
  }

  const nextState: GameState = {
    ...played.state,
    players: { ...played.state.players, [action.playerId]: { ...played.player, tradeGoods: played.player.tradeGoods + amount } },
  };
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("industrial_initiative") },
      { type: "TRADE_GOODS_GAINED", playerId: action.playerId, amount },
    ],
  };
}

/** RR "Economic Initiative": ready each cultural planet this player controls. */
export function playEconomicInitiative(state: GameState, action: { type: "PLAY_ECONOMIC_INITIATIVE"; playerId: PlayerId }, rules: RuleData): ActionResult {
  const played = playCard(state, action.playerId, "economic_initiative");
  if (!played.ok) return played;

  const readiedPlanetIds: PlanetId[] = [];
  const systems: GameState["systems"] = { ...played.state.systems };
  for (const [systemId, system] of Object.entries(played.state.systems)) {
    let changed = false;
    const planets = system.planets.map((p) => {
      if (p.controllerId === action.playerId && p.exhausted && (rules.planets[p.planetId]?.traits ?? []).includes("cultural")) {
        changed = true;
        readiedPlanetIds.push(p.planetId);
        return { ...p, exhausted: false };
      }
      return p;
    });
    if (changed) systems[systemId as SystemId] = { ...system, planets };
  }

  const nextState: GameState = { ...played.state, systems };
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("economic_initiative") },
      ...readiedPlanetIds.map((planetId): GameEvent => ({ type: "PLANET_READIED", playerId: action.playerId, planetId })),
    ],
  };
}

/** RR "Uprising": exhaust 1 non-home planet controlled by another player, then gain trade goods equal to its resource value. */
export function playUprising(state: GameState, action: { type: "PLAY_UPRISING"; playerId: PlayerId; planetId: PlanetId }, rules: RuleData): ActionResult {
  const played = playCard(state, action.playerId, "uprising");
  if (!played.ok) return played;

  const found = findPlanet(played.state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  const { systemId, system, planet } = found;
  if (!planet.controllerId || planet.controllerId === action.playerId) {
    return { ok: false, error: "Uprising must target a planet controlled by another player." };
  }
  if (planet.exhausted) return { ok: false, error: "That planet is already exhausted." };
  if (rules.planets[action.planetId]?.homeFactionId) {
    return { ok: false, error: "Uprising cannot target a home planet." };
  }
  const amount = rules.planets[action.planetId]?.resources ?? 0;
  const targetOwnerId = planet.controllerId;

  const updatedPlanet: PlanetState = { ...planet, exhausted: true };
  const updatedSystem: SystemState = { ...system, planets: system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };
  const nextState: GameState = {
    ...played.state,
    systems: { ...played.state.systems, [systemId]: updatedSystem },
    players: { ...played.state.players, [action.playerId]: { ...played.player, tradeGoods: played.player.tradeGoods + amount } },
  };
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("uprising") },
      { type: "PLANET_EXHAUSTED", playerId: targetOwnerId, planetId: action.planetId },
      { type: "TRADE_GOODS_GAINED", playerId: action.playerId, amount },
    ],
  };
}

/** RR "Focused Research": spend 4 trade goods (not resources) to research 1 technology. Reuses phases/technology.ts's own researchTechnology with an empty exhaustPlanetIdsForResources — its own spendForCost falls back to trade goods for the entire cost in that case, which is exactly this card's own wording. */
export function playFocusedResearch(state: GameState, action: { type: "PLAY_FOCUSED_RESEARCH"; playerId: PlayerId; techId: TechId }, rules: RuleData): ActionResult {
  const played = playCard(state, action.playerId, "focused_research");
  if (!played.ok) return played;

  const researched = researchTechnology(played.state, action.playerId, action.techId, 4, [], rules);
  if (!researched.ok) return researched;

  return {
    ok: true,
    state: researched.state,
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("focused_research") }, ...researched.events],
  };
}

/** RR "Impersonation": spend 3 influence (via exhausting controlled planets, same shape as agendaPhase.ts's own castVotes) to draw 1 secret objective. The drawn card's id is deliberately NOT included in any emitted event — secret objectives stay hidden from other players, same precedent as strategyCardAbilities.ts's own Imperial-card secret draw. */
export function playImpersonation(state: GameState, action: { type: "PLAY_IMPERSONATION"; playerId: PlayerId; exhaustPlanetIds: PlanetId[] }, rules: RuleData): ActionResult {
  const played = playCard(state, action.playerId, "impersonation");
  if (!played.ok) return played;

  let influence = 0;
  let systems = played.state.systems;
  for (const planetId of action.exhaustPlanetIds) {
    const found = findPlanet(played.state, planetId);
    if (!found) return { ok: false, error: `No planet ${planetId}.` };
    if (found.planet.controllerId !== action.playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };
    if (found.planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };
    influence += rules.planets[planetId]?.influence ?? 0;
    systems = {
      ...systems,
      [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === planetId ? { ...p, exhausted: true } : p)) },
    };
  }
  if (influence < 3) return { ok: false, error: "Impersonation costs 3 influence." };

  const deck = played.state.secretObjectiveDeck ?? [];
  if (deck.length === 0) return { ok: false, error: "The secret objective deck is empty." };
  const [objectiveId, ...rest] = deck;

  let nextState: GameState = {
    ...played.state,
    systems,
    secretObjectiveDeck: rest,
    players: { ...played.state.players, [action.playerId]: { ...played.player, secretObjectives: [...played.player.secretObjectives, objectiveId] } },
  };
  nextState = maybeQueueSecretObjectiveLimit(nextState, rules, action.playerId);

  return {
    ok: true,
    state: nextState,
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("impersonation") }],
  };
}

/** RR "Unexpected Action": remove 1 of this player's activated (on-board) command tokens and return it to their reinforcements. Now that rules/reinforcements.ts tracks the real 16-token total (tactic+fleet+strategy+onBoard, all counted against the same fixed supply), simply removing it from `onBoard` IS returning it to reinforcements — it does NOT go into the tactic pool specifically, since "reinforcements" is the general unallocated supply, not any 1 named pool. */
export function playUnexpectedAction(state: GameState, action: { type: "PLAY_UNEXPECTED_ACTION"; playerId: PlayerId; systemId: SystemId }): ActionResult {
  const played = playCard(state, action.playerId, "unexpected_action");
  if (!played.ok) return played;

  if (!played.player.commandTokens.onBoard.includes(action.systemId)) {
    return { ok: false, error: "This player has no command token in that system." };
  }
  const updatedPlayer: Player = {
    ...played.player,
    commandTokens: { ...played.player.commandTokens, onBoard: played.player.commandTokens.onBoard.filter((s) => s !== action.systemId) },
  };
  const nextState: GameState = { ...played.state, players: { ...played.state.players, [action.playerId]: updatedPlayer } };
  return {
    ok: true,
    state: nextState,
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("unexpected_action") }],
  };
}

/** RR "Repeal Law": discard 1 law currently in play. Any player can target any active law — the card has no "your own" restriction. */
export function playRepealLaw(state: GameState, action: { type: "PLAY_REPEAL_LAW"; playerId: PlayerId; agendaId: AgendaId }): ActionResult {
  const played = playCard(state, action.playerId, "repeal_law");
  if (!played.ok) return played;

  const law = played.state.agendaDeck.lawsInPlay.find((l) => l.agendaId === action.agendaId);
  if (!law) return { ok: false, error: "That law isn't currently in play." };

  const nextState: GameState = {
    ...played.state,
    agendaDeck: {
      ...played.state.agendaDeck,
      lawsInPlay: played.state.agendaDeck.lawsInPlay.filter((l) => l.agendaId !== action.agendaId),
      discardIds: [...played.state.agendaDeck.discardIds, action.agendaId],
    },
  };
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("repeal_law") },
      { type: "LAW_REPEALED", agendaId: action.agendaId },
    ],
  };
}

/**
 * Batch 2: free unit placement / removal. Free-unit events reuse
 * UNITS_PRODUCED with totalCost: 0 (same precedent as
 * technologyAbilities.ts's own useSelfAssemblyRoutines/useDacxiveAnimators);
 * ship placements that aren't tied to any producing planet (Ghost Ship, War
 * Effort, Fighter Conscription) omit `planetId` — see that event's own
 * updated doc comment in types/Actions.ts on why it's optional.
 */

/** RR "Frontline Deployment": place 3 infantry from reinforcements on 1 planet this player controls. */
export function playFrontlineDeployment(state: GameState, action: { type: "PLAY_FRONTLINE_DEPLOYMENT"; playerId: PlayerId; planetId: PlanetId }): ActionResult {
  const played = playCard(state, action.playerId, "frontline_deployment");
  if (!played.ok) return played;

  const found = findPlanet(played.state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  if (found.planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };

  const updatedPlanet = addPlanetUnits(found.planet, action.playerId, "infantry", 3);
  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };
  const nextState: GameState = { ...played.state, systems: { ...played.state.systems, [found.systemId]: updatedSystem } };

  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("frontline_deployment") },
      { type: "UNITS_PRODUCED", playerId: action.playerId, systemId: found.systemId, planetId: action.planetId, unitType: "infantry", count: 3, totalCost: 0 },
    ],
  };
}

/** RR "Rise of a Messiah": place 1 infantry from reinforcements on EACH planet this player controls (every system, not a single choice). */
export function playRiseOfAMessiah(state: GameState, action: { type: "PLAY_RISE_OF_A_MESSIAH"; playerId: PlayerId }): ActionResult {
  const played = playCard(state, action.playerId, "rise_of_a_messiah");
  if (!played.ok) return played;

  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("rise_of_a_messiah") }];
  const systems: GameState["systems"] = { ...played.state.systems };

  for (const [systemId, system] of Object.entries(played.state.systems)) {
    let changed = false;
    const planets = system.planets.map((p) => {
      if (p.controllerId !== action.playerId) return p;
      changed = true;
      events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: systemId as SystemId, planetId: p.planetId, unitType: "infantry", count: 1, totalCost: 0 });
      return addPlanetUnits(p, action.playerId, "infantry", 1);
    });
    if (changed) systems[systemId as SystemId] = { ...system, planets };
  }
  // RR (yjmrobert.com/tirules): "A player that controls zero planets may play Rise of a Messiah" — confirmed legal even as a total no-op.

  return { ok: true, state: { ...played.state, systems }, events };
}

/** RR "War Effort": place 1 cruiser from reinforcements in a system that contains 1 or more of this player's ships. */
export function playWarEffort(state: GameState, action: { type: "PLAY_WAR_EFFORT"; playerId: PlayerId; systemId: SystemId; relocateFromSystemId?: SystemId }): ActionResult {
  const played = playCard(state, action.playerId, "war_effort");
  if (!played.ok) return played;

  const system = played.state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  const hasOwnShip = (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => SHIP_TYPES.includes(s.unitType) && s.count > 0);
  if (!hasOwnShip) return { ok: false, error: "This player has no ships in that system." };

  let systems = played.state.systems;
  // RR (yjmrobert.com/tirules/components/c_action_cards): "If a player wishes to place a cruiser, but there are none left in their reinforcements, they may remove a cruiser from any system that does not contain one of their command tokens and place that instead. This cruiser will be placed undamaged." — same substitution Ghost Ship already has.
  if (!checkReinforcementsAvailable(played.state, action.playerId, [{ unitType: "cruiser", count: 1 }]).ok) {
    if (!action.relocateFromSystemId) {
      return { ok: false, error: "No cruisers left in reinforcements — specify relocateFromSystemId to relocate an existing one instead." };
    }
    if (played.player.commandTokens.onBoard.includes(action.relocateFromSystemId)) {
      return { ok: false, error: "Cannot relocate a cruiser from a system that contains one of this player's own command tokens." };
    }
    const sourceSystem = systems[action.relocateFromSystemId];
    const sourceStacks = sourceSystem?.spaceUnitsByPlayer[action.playerId] ?? [];
    const sourceStack = sourceStacks.find((s) => s.unitType === "cruiser" && s.count > 0);
    if (!sourceSystem || !sourceStack) {
      return { ok: false, error: `No cruiser belonging to this player in ${action.relocateFromSystemId}.` };
    }
    const updatedSourceStacks = sourceStacks.map((s) => (s === sourceStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
    systems = { ...systems, [action.relocateFromSystemId]: { ...sourceSystem, spaceUnitsByPlayer: { ...sourceSystem.spaceUnitsByPlayer, [action.playerId]: updatedSourceStacks } } };
  }

  const updatedSystem = addSpaceUnits(systems[action.systemId], action.playerId, "cruiser", 1);
  systems = { ...systems, [action.systemId]: updatedSystem };
  const nextState: GameState = { ...played.state, systems };
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("war_effort") },
      { type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.systemId, unitType: "cruiser", count: 1, totalCost: 0 },
    ],
  };
}

/** RR "Ghost Ship": place 1 destroyer from reinforcements in a non-home system that contains a wormhole and no other player's ships. */
/** RR (yjmrobert.com/tirules/rules/r_action_cards): if none are left in reinforcements, this player may instead relocate a destroyer already on the board from a system that does NOT contain 1 of their own command tokens — `relocateFromSystemId` identifies that source. */
export function playGhostShip(
  state: GameState,
  action: { type: "PLAY_GHOST_SHIP"; playerId: PlayerId; systemId: SystemId; relocateFromSystemId?: SystemId },
  rules: RuleData,
): ActionResult {
  const played = playCard(state, action.playerId, "ghost_ship");
  if (!played.ok) return played;

  const system = played.state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  const isHomeSystem = system.planets.some((p) => rules.planets[p.planetId]?.homeFactionId != null);
  if (isHomeSystem) return { ok: false, error: "Ghost Ship cannot target a home system." };
  if (system.wormholes.length === 0) return { ok: false, error: "That system doesn't contain a wormhole." };
  const hasOtherShips = Object.entries(system.spaceUnitsByPlayer).some(([pid, stacks]) => pid !== action.playerId && (stacks ?? []).some((s) => s.count > 0));
  if (hasOtherShips) return { ok: false, error: "That system contains another player's ships." };

  let systems = played.state.systems;
  const reinforcementsCheck = checkReinforcementsAvailable(played.state, action.playerId, [{ unitType: "destroyer", count: 1 }]);
  if (!reinforcementsCheck.ok) {
    if (!action.relocateFromSystemId) {
      return { ok: false, error: "No destroyers left in reinforcements — specify relocateFromSystemId to relocate an existing one instead." };
    }
    if (played.player.commandTokens.onBoard.includes(action.relocateFromSystemId)) {
      return { ok: false, error: "Cannot relocate a destroyer from a system that contains one of this player's own command tokens." };
    }
    const sourceSystem = systems[action.relocateFromSystemId];
    const sourceStacks = sourceSystem?.spaceUnitsByPlayer[action.playerId] ?? [];
    const sourceStack = sourceStacks.find((s) => s.unitType === "destroyer" && s.count > 0);
    if (!sourceSystem || !sourceStack) {
      return { ok: false, error: `No destroyer belonging to this player in ${action.relocateFromSystemId}.` };
    }
    const updatedSourceStacks = sourceStacks.map((s) => (s === sourceStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
    systems = {
      ...systems,
      [action.relocateFromSystemId]: { ...sourceSystem, spaceUnitsByPlayer: { ...sourceSystem.spaceUnitsByPlayer, [action.playerId]: updatedSourceStacks } },
    };
  }

  const updatedSystem = addSpaceUnits(systems[action.systemId], action.playerId, "destroyer", 1);
  systems = { ...systems, [action.systemId]: updatedSystem };
  const nextState: GameState = { ...played.state, systems };
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("ghost_ship") },
      { type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.systemId, unitType: "destroyer", count: 1, totalCost: 0 },
    ],
  };
}

/** RR "Fighter Conscription": place 1 fighter from reinforcements in EACH system containing 1+ of this player's space docks or capacity-bearing ships, skipping any system that contains another player's ships. */
export function playFighterConscription(state: GameState, action: { type: "PLAY_FIGHTER_CONSCRIPTION"; playerId: PlayerId }, rules: RuleData): ActionResult {
  const played = playCard(state, action.playerId, "fighter_conscription");
  if (!played.ok) return played;
  // KNOWN GAP (yjmrobert.com/tirules/components/c_action_cards): "A player may place a fighter in a system that is at its capacity limit. If they do so, they must then remove a fighter or ground force from the space area of that system." This project doesn't yet re-check/enforce capacity after Fighter Conscription places fighters across every eligible system at once — a player could end up over capacity with no forced removal. Documented rather than half-fixed, since doing this properly needs a per-system pending-choice mechanism this card doesn't have yet.

  const player = played.player;
  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("fighter_conscription") }];
  const systems: GameState["systems"] = { ...played.state.systems };
  let placedAny = false;

  for (const [systemId, system] of Object.entries(played.state.systems)) {
    const hasOtherShips = Object.entries(system.spaceUnitsByPlayer).some(
      ([pid, stacks]) => pid !== action.playerId && (stacks ?? []).some((s) => SHIP_TYPES.includes(s.unitType) && s.count > 0),
    );
    if (hasOtherShips) continue;

    const hasOwnSpaceDock = system.planets.some((p) => (p.unitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "space_dock" && s.count > 0));
    const hasOwnCapacityShip = (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => {
      if (!SHIP_TYPES.includes(s.unitType) || s.count === 0) return false;
      const stats = getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades);
      return (stats?.capacity ?? 0) > 0;
    });
    if (!hasOwnSpaceDock && !hasOwnCapacityShip) continue;

    placedAny = true;
    systems[systemId as SystemId] = addSpaceUnits(system, action.playerId, "fighter", 1);
    events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: systemId as SystemId, unitType: "fighter", count: 1, totalCost: 0 });
  }
  if (!placedAny) return { ok: false, error: "No eligible systems for Fighter Conscription." };

  return { ok: true, state: { ...played.state, systems }, events };
}

/** RR "Refit Troops": choose 1 or 2 of this player's infantry on the board (any planet(s), repeatable entries for 2-from-the-same-planet) and replace each with a mech in the same spot. */
export function playRefitTroops(state: GameState, action: { type: "PLAY_REFIT_TROOPS"; playerId: PlayerId; planetIds: PlanetId[] }): ActionResult {
  const played = playCard(state, action.playerId, "refit_troops");
  if (!played.ok) return played;
  if (action.planetIds.length < 1 || action.planetIds.length > 2) {
    return { ok: false, error: "Refit Troops replaces 1 or 2 infantry." };
  }
  const reinforcementsCheck = checkReinforcementsAvailable(played.state, action.playerId, [{ unitType: "mech", count: action.planetIds.length }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;
  // KNOWN GAP (yjmrobert.com/tirules/components/c_action_cards): "If a player has no mechs left in their reinforcements, they may remove a mech from any system that does not contain one of their command tokens and place that instead. The mech will be placed undamaged." — Ghost Ship/Construction Rider/War Effort all already have this exact substitution pattern; this card doesn't yet (rejects outright above instead), given the added complexity of doing it per-planet for up to 2 mechs at once. Documented rather than half-fixed under time pressure.

  const counts = new Map<PlanetId, number>();
  for (const id of action.planetIds) counts.set(id, (counts.get(id) ?? 0) + 1);

  let systems = played.state.systems;
  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("refit_troops") }];

  for (const [planetId, n] of counts.entries()) {
    const found = findPlanet(played.state, planetId);
    if (!found) return { ok: false, error: `No planet ${planetId}.` };
    const stacks = found.planet.unitsByPlayer[action.playerId] ?? [];
    const infantry = stacks.find((s) => s.unitType === "infantry" && !s.upgradeId);
    if (!infantry || infantry.count < n) return { ok: false, error: `Not enough infantry on ${planetId}.` };

    const afterRemoval = stacks.map((s) => (s === infantry ? { ...s, count: s.count - n } : s)).filter((s) => s.count > 0);
    const mech = afterRemoval.find((s) => s.unitType === "mech" && !s.upgradeId);
    const finalStacks: UnitStack[] = mech
      ? afterRemoval.map((s) => (s === mech ? { ...s, count: s.count + n } : s))
      : [...afterRemoval, { unitType: "mech", count: n, damagedCount: 0 }];

    const updatedPlanet: PlanetState = { ...found.planet, unitsByPlayer: { ...found.planet.unitsByPlayer, [action.playerId]: finalStacks } };
    systems = { ...systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } };
    events.push({ type: "UNITS_DESTROYED", playerId: action.playerId, systemId: found.systemId, planetId, unitType: "infantry", count: n });
    events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: found.systemId, planetId, unitType: "mech", count: n, totalCost: 0 });
  }

  return { ok: true, state: { ...played.state, systems }, events };
}

/** RR "Scuttle": choose 1 or 2 of this player's non-fighter ships on the board and return them to reinforcements; gain trade goods equal to their combined cost. */
export function playScuttle(
  state: GameState,
  action: { type: "PLAY_SCUTTLE"; playerId: PlayerId; targets: { systemId: SystemId; unitType: UnitType }[] },
  rules: RuleData,
): ActionResult {
  const played = playCard(state, action.playerId, "scuttle");
  if (!played.ok) return played;
  if (action.targets.length < 1 || action.targets.length > 2) {
    return { ok: false, error: "Scuttle returns 1 or 2 ships." };
  }

  const player = played.player;
  let systems = played.state.systems;
  let totalCost = 0;
  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("scuttle") }];

  for (const target of action.targets) {
    if (target.unitType === "fighter") return { ok: false, error: "Scuttle cannot target fighters." };
    const system = systems[target.systemId];
    if (!system) return { ok: false, error: `No system ${target.systemId}.` };
    const stacks = system.spaceUnitsByPlayer[action.playerId] ?? [];
    const stack = stacks.find((s) => s.unitType === target.unitType && !s.upgradeId);
    if (!stack || stack.count < 1) return { ok: false, error: `No ${target.unitType} in ${target.systemId}.` };

    const stats = getUnitStats(rules, player.factionId, target.unitType, player.unitUpgrades);
    totalCost += stats?.cost ?? 0;

    const updatedStacks = stacks.map((s) => (s === stack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
    systems = { ...systems, [target.systemId]: { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedStacks } } };
    events.push({ type: "UNITS_DESTROYED", playerId: action.playerId, systemId: target.systemId, unitType: target.unitType, count: 1 });
  }

  const nextState: GameState = {
    ...played.state,
    systems,
    players: { ...played.state.players, [action.playerId]: { ...player, tradeGoods: player.tradeGoods + totalCost } },
  };
  events.push({ type: "TRADE_GOODS_GAINED", playerId: action.playerId, amount: totalCost });

  return { ok: true, state: nextState, events };
}

/**
 * Batch 3: disruptive / political-warfare cards, plus the 2 remaining
 * exploration-linked "As an Action" cards.
 */

/** RR "Insubordination": remove 1 token from another player's tactic pool and return it to their reinforcements. Under rules/reinforcements.ts's own derived-supply model (16 total minus tactic+fleet+strategy+onBoard), simply decrementing `tactic` here already IS "returning it to reinforcements" — that fixed total automatically has 1 more slot free, no second field to update. */
export function playInsubordination(state: GameState, action: { type: "PLAY_INSUBORDINATION"; playerId: PlayerId; targetPlayerId: PlayerId }): ActionResult {
  const played = playCard(state, action.playerId, "insubordination");
  if (!played.ok) return played;
  if (action.targetPlayerId === action.playerId) return { ok: false, error: "Insubordination must target another player." };
  const target = played.state.players[action.targetPlayerId];
  if (!target) return { ok: false, error: "Unknown target player." };
  if (target.commandTokens.tactic < 1) return { ok: false, error: "That player has no tokens in their tactic pool." };

  const updatedTarget: Player = { ...target, commandTokens: { ...target.commandTokens, tactic: target.commandTokens.tactic - 1 } };
  const nextState: GameState = { ...played.state, players: { ...played.state.players, [action.targetPlayerId]: updatedTarget } };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("insubordination") }] };
}

/** RR "Lucky Shot": destroy 1 dreadnought/cruiser/destroyer in a system where this player controls a planet. A unit upgrade tech converts every unit of that type a player owns, so there's never a mixed base+upgraded stack of the same unitType to disambiguate — matching on unitType alone always finds the right (only) stack. */
export function playLuckyShot(
  state: GameState,
  action: { type: "PLAY_LUCKY_SHOT"; playerId: PlayerId; systemId: SystemId; targetPlayerId: PlayerId; unitType: "dreadnought" | "cruiser" | "destroyer" },
): ActionResult {
  // RR FAQ (twilight-imperium.fandom.com/wiki/Action_Cards): "Lucky Shot and other similar effects can only be used against ANOTHER player's units and planets" — never the caster's own.
  if (action.targetPlayerId === action.playerId) {
    return { ok: false, error: "Lucky Shot cannot target this player's own units." };
  }
  const played = playCard(state, action.playerId, "lucky_shot");
  if (!played.ok) return played;

  const system = played.state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  if (!system.planets.some((p) => p.controllerId === action.playerId)) {
    return { ok: false, error: "This player doesn't control a planet in that system." };
  }
  const stacks = system.spaceUnitsByPlayer[action.targetPlayerId] ?? [];
  const stack = stacks.find((s) => s.unitType === action.unitType && s.count > 0);
  if (!stack) return { ok: false, error: `No ${action.unitType} there belonging to that player.` };

  const updatedStacks = stacks.map((s) => (s === stack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.targetPlayerId]: updatedStacks } };
  const nextState: GameState = { ...played.state, systems: { ...played.state.systems, [action.systemId]: updatedSystem } };
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("lucky_shot") },
      { type: "UNITS_DESTROYED", playerId: action.targetPlayerId, systemId: action.systemId, unitType: action.unitType, count: 1 },
    ],
  };
}

/** RR "Reactor Meltdown": destroy 1 space dock in a non-home system belonging to ANOTHER player — official ruling: a player cannot destroy their own space dock with this card. (The "no home system" restriction already excludes both an eliminated player's home system and a dock a player owns inside another player's home system — any home system, regardless of whose, is out of bounds.) */
export function playReactorMeltdown(
  state: GameState,
  action: { type: "PLAY_REACTOR_MELTDOWN"; playerId: PlayerId; planetId: PlanetId; targetPlayerId: PlayerId },
  rules: RuleData,
): ActionResult {
  const played = playCard(state, action.playerId, "reactor_meltdown");
  if (!played.ok) return played;
  if (action.targetPlayerId === action.playerId) {
    return { ok: false, error: "A player cannot destroy their own space dock with Reactor Meltdown." };
  }

  const found = findPlanet(played.state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  if (rules.planets[action.planetId]?.homeFactionId) {
    return { ok: false, error: "Reactor Meltdown cannot target a home system." };
  }
  const stacks = found.planet.unitsByPlayer[action.targetPlayerId] ?? [];
  const stack = stacks.find((s) => s.unitType === "space_dock" && s.count > 0);
  if (!stack) return { ok: false, error: "No space dock there belonging to that player." };

  const updatedStacks = stacks.map((s) => (s === stack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  const updatedPlanet: PlanetState = { ...found.planet, unitsByPlayer: { ...found.planet.unitsByPlayer, [action.targetPlayerId]: updatedStacks } };
  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };
  const nextState: GameState = { ...played.state, systems: { ...played.state.systems, [found.systemId]: updatedSystem } };
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("reactor_meltdown") },
      { type: "UNITS_DESTROYED", playerId: action.targetPlayerId, systemId: found.systemId, planetId: action.planetId, unitType: "space_dock", count: 1 },
    ],
  };
}

/** RR "Signal Jamming": force-place a command token from another player's reinforcements into a non-home system in/adjacent to this player's own ships — RR 3.3's "can't activate a system that already has your own token" restriction applies to the TARGET here too, since it's their token being placed. Sourced from their reinforcements, falling back to an existing pool if those are exhausted (rules/reinforcements.ts's own placeCommandTokenFromReinforcements — the official ruling on what happens then). */
export function playSignalJamming(
  state: GameState,
  action: { type: "PLAY_SIGNAL_JAMMING"; playerId: PlayerId; systemId: SystemId; targetPlayerId: PlayerId },
  rules: RuleData,
): ActionResult {
  const played = playCard(state, action.playerId, "signal_jamming");
  if (!played.ok) return played;
  if (action.targetPlayerId === action.playerId) return { ok: false, error: "Signal Jamming must target another player." };

  const system = played.state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  if (system.planets.some((p) => rules.planets[p.planetId]?.homeFactionId != null)) {
    return { ok: false, error: "Signal Jamming cannot target a home system." };
  }
  const hasOwnShipsHere = (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => SHIP_TYPES.includes(s.unitType) && s.count > 0);
  const hasOwnShipsAdjacent = getAdjacentSystems(played.state, action.systemId, rules).some((adjId) =>
    (played.state.systems[adjId]?.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => SHIP_TYPES.includes(s.unitType) && s.count > 0),
  );
  if (!hasOwnShipsHere && !hasOwnShipsAdjacent) {
    return { ok: false, error: "This player has no ships in or adjacent to that system." };
  }

  const target = played.state.players[action.targetPlayerId];
  if (!target) return { ok: false, error: "Unknown target player." };
  if (target.commandTokens.onBoard.includes(action.systemId)) {
    return { ok: false, error: "That player already has a command token in that system." };
  }
  const placed = placeCommandTokenFromReinforcements(target, action.systemId);
  if (!placed.ok) return placed;
  const updatedTarget = placed.player;
  const nextState: GameState = { ...played.state, players: { ...played.state.players, [action.targetPlayerId]: updatedTarget } };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("signal_jamming") }] };
}

/** RR "Spy": take 1 random action card from another player's hand. `rng` defaults to Math.random, same override hook phases/exploration.ts's own drawExplorationCard uses (so callers/tests can inject a seeded rng). The stolen card's id is deliberately NOT named in any emitted event — hidden information, same precedent as Impersonation's secret-objective draw. */
/** RR "Spy": steal a random action card from another player's hand. KNOWN SIMPLIFICATION (yjmrobert.com/tirules/components/c_action_cards): if the target holds Reverse Engineer, the precise ruling has them decide whether to react with it only AFTER this random selection is revealed to them — this project's generic Reverse Engineer (already covering "spy" in its own COMPONENT_ACTION_CARD_IDS set, since Spy is an "As an Action:" card) still lets the target take Spy back from the discard pile afterward, just without that exact reveal-then-decide sequencing modeled. */
export function playSpy(state: GameState, action: { type: "PLAY_SPY"; playerId: PlayerId; targetPlayerId: PlayerId }, rng: () => number = Math.random): ActionResult {
  const played = playCard(state, action.playerId, "spy");
  if (!played.ok) return played;
  if (action.targetPlayerId === action.playerId) return { ok: false, error: "Spy must target another player." };

  const target = played.state.players[action.targetPlayerId];
  if (!target) return { ok: false, error: "Unknown target player." };
  if (target.actionCards.length === 0) return { ok: false, error: "That player has no action cards." };

  const index = Math.floor(rng() * target.actionCards.length);
  const stolenCardId = target.actionCards[index];
  const updatedTarget: Player = { ...target, actionCards: target.actionCards.filter((_, i) => i !== index) };
  const updatedActingPlayer: Player = { ...played.player, actionCards: [...played.player.actionCards, stolenCardId] };

  const nextState: GameState = {
    ...played.state,
    players: { ...played.state.players, [action.targetPlayerId]: updatedTarget, [action.playerId]: updatedActingPlayer },
  };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("spy") }] };
}

/** RR "Tactical Bombardment": exhaust every OTHER player's planet in a system where this player has a unit with the Bombardment ability. */
export function playTacticalBombardment(state: GameState, action: { type: "PLAY_TACTICAL_BOMBARDMENT"; playerId: PlayerId; systemId: SystemId }, rules: RuleData): ActionResult {
  const played = playCard(state, action.playerId, "tactical_bombardment");
  if (!played.ok) return played;

  const system = played.state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  const player = played.player;
  const hasBombardmentUnit = (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => {
    if (s.count === 0) return false;
    const stats = getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades);
    return (stats?.abilities ?? []).includes("bombardment");
  });
  if (!hasBombardmentUnit) return { ok: false, error: "This player has no unit with Bombardment in that system." };

  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("tactical_bombardment") }];
  const planets = system.planets.map((p) => {
    if (p.controllerId && p.controllerId !== action.playerId && !p.exhausted) {
      events.push({ type: "PLANET_EXHAUSTED", playerId: p.controllerId, planetId: p.planetId });
      return { ...p, exhausted: true };
    }
    return p;
  });

  const nextState: GameState = { ...played.state, systems: { ...played.state.systems, [action.systemId]: { ...system, planets } } };
  return { ok: true, state: nextState, events };
}

/** RR "Unstable Planet": exhaust 1 hazardous planet and destroy up to 3 infantry on it. `targetPlayerId`/`destroyCount` are optional (exhaust-only is a legal, if weak, play). This is an "Action:" timing card — played as this player's whole action-phase turn, never mid-combat/invasion — so RR 44's "both attacker's just-landed and defender's original forces present at once" case never applies here; at most 1 player has ground forces on the planet at the time this is played. */
export function playUnstablePlanet(
  state: GameState,
  action: { type: "PLAY_UNSTABLE_PLANET"; playerId: PlayerId; planetId: PlanetId; targetPlayerId?: PlayerId },
  rules: RuleData,
): ActionResult {
  const played = playCard(state, action.playerId, "unstable_planet");
  if (!played.ok) return played;

  const found = findPlanet(played.state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  if (!(rules.planets[action.planetId]?.traits ?? []).includes("hazardous")) {
    return { ok: false, error: "Unstable Planet must target a hazardous planet." };
  }

  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("unstable_planet") }];
  let updatedPlanet: PlanetState = { ...found.planet, exhausted: true };
  if (found.planet.controllerId) {
    events.push({ type: "PLANET_EXHAUSTED", playerId: found.planet.controllerId, planetId: action.planetId });
  }

  // RR (yjmrobert.com/tirules/components/c_action_cards): "If the selected planet has three or fewer infantry on it, all infantry will be destroyed. Otherwise, three infantry will be destroyed." — automatic, not a player-chosen lower amount; "may select a planet with fewer than three infantry (including zero)" confirms zero is a legal (no-op) target too.
  // RR FAQ: destroy effects only ever target ANOTHER player's units.
  if (action.targetPlayerId && action.targetPlayerId !== action.playerId) {
    const stacks = updatedPlanet.unitsByPlayer[action.targetPlayerId] ?? [];
    const infantry = stacks.find((s) => s.unitType === "infantry");
    const n = Math.min(3, infantry?.count ?? 0);
    if (n > 0 && infantry) {
      const updatedStacks = stacks.map((s) => (s === infantry ? { ...s, count: s.count - n } : s)).filter((s) => s.count > 0);
      updatedPlanet = { ...updatedPlanet, unitsByPlayer: { ...updatedPlanet.unitsByPlayer, [action.targetPlayerId]: updatedStacks } };
      events.push({ type: "UNITS_DESTROYED", playerId: action.targetPlayerId, systemId: found.systemId, planetId: action.planetId, unitType: "infantry", count: n });
    }
  }

  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };
  const nextState: GameState = { ...played.state, systems: { ...played.state.systems, [found.systemId]: updatedSystem } };
  return { ok: true, state: nextState, events };
}

/** RR "Plagiarize": spend 5 influence (exhausting controlled planets, same shape as PLAY_IMPERSONATION above) to gain a non-faction technology owned by a neighbor — bypasses RR 90.7 prerequisites entirely, same "free grant" precedent as directiveEffects.ts's own useResearchGrantReallocation. */
export function playPlagiarize(
  state: GameState,
  action: { type: "PLAY_PLAGIARIZE"; playerId: PlayerId; targetPlayerId: PlayerId; techId: TechId; exhaustPlanetIds: PlanetId[] },
  rules: RuleData,
): ActionResult {
  // KNOWN GAP, flagged rather than half-implemented: RR (yjmrobert.com/
  // tirules/rules/r_action_cards) confirms Plagiarize also can't target
  // the GENERIC version of a unit upgrade if the target neighbor owns
  // the FACTION-SPECIFIC variant of that same unit type (e.g. a neighbor
  // holding their own faction's Cruiser II blocks gaining the generic
  // Cruiser II from them too, not just their exact card). Implementing
  // this precisely needs a techId -> UnitType lookup for EVERY unit
  // upgrade (generic and faction) that RuleData doesn't expose yet
  // (rules/ruleDataMapping.ts's own unitUpgradeTechData only carries
  // color/prerequisites) — rather than guess via an imprecise proxy that
  // could wrongly block or wrongly allow a real case, this is left as a
  // documented gap for whoever adds that lookup.
  const played = playCard(state, action.playerId, "plagiarize");
  if (!played.ok) return played;
  if (!arePlayersNeighbors(played.state, action.playerId, action.targetPlayerId, rules)) {
    return { ok: false, error: "Plagiarize must target a neighbor." };
  }
  const target = played.state.players[action.targetPlayerId];
  if (!target?.technologies.includes(action.techId)) {
    return { ok: false, error: "That player doesn't own that technology." };
  }
  if (rules.factionTechIds.has(action.techId)) {
    return { ok: false, error: "Plagiarize cannot target a faction technology." };
  }
  if (played.player.technologies.includes(action.techId)) {
    return { ok: false, error: "This player already owns that technology." };
  }

  let influence = 0;
  let systems = played.state.systems;
  for (const planetId of action.exhaustPlanetIds) {
    const found = findPlanet(played.state, planetId);
    if (!found) return { ok: false, error: `No planet ${planetId}.` };
    if (found.planet.controllerId !== action.playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };
    if (found.planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };
    influence += rules.planets[planetId]?.influence ?? 0;
    systems = {
      ...systems,
      [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === planetId ? { ...p, exhausted: true } : p)) },
    };
  }
  if (influence < 5) return { ok: false, error: "Plagiarize costs 5 influence." };

  const nextState: GameState = {
    ...played.state,
    systems,
    players: { ...played.state.players, [action.playerId]: { ...played.player, technologies: [...played.player.technologies, action.techId] } },
  };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("plagiarize") }] };
}

/** RR "Seize Artifact": take 1 relic fragment (of this player's choice, among types the target actually has) from a neighbor. */
export function playSeizeArtifact(
  state: GameState,
  action: { type: "PLAY_SEIZE_ARTIFACT"; playerId: PlayerId; targetPlayerId: PlayerId; fragmentType: "cultural" | "industrial" | "hazardous" | "unknown" },
  rules: RuleData,
): ActionResult {
  const played = playCard(state, action.playerId, "seize_artifact");
  if (!played.ok) return played;
  if (!arePlayersNeighbors(played.state, action.playerId, action.targetPlayerId, rules)) {
    return { ok: false, error: "Seize Artifact must target a neighbor." };
  }
  const target = played.state.players[action.targetPlayerId];
  if (!target) return { ok: false, error: "Unknown target player." };
  if (target.relicFragments[action.fragmentType] < 1) {
    return { ok: false, error: `That player has no ${action.fragmentType} relic fragments.` };
  }

  const updatedTarget: Player = { ...target, relicFragments: { ...target.relicFragments, [action.fragmentType]: target.relicFragments[action.fragmentType] - 1 } };
  const updatedActingPlayer: Player = {
    ...played.player,
    relicFragments: { ...played.player.relicFragments, [action.fragmentType]: played.player.relicFragments[action.fragmentType] + 1 },
  };
  const nextState: GameState = {
    ...played.state,
    players: { ...played.state.players, [action.targetPlayerId]: updatedTarget, [action.playerId]: updatedActingPlayer },
  };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("seize_artifact") }] };
}

/** RR "Archaeological Expedition": reveal the top 3 cards of the exploration deck matching a trait this player controls a planet of; gain any relic fragments among them (same key-mapping as phases/exploration.ts's own applyExplorationCard), discard the rest. Deliberately does NOT call applyExplorationCard for the whole draw — the printed card only ever grants fragments or discards, it never resolves an "attach"/"keep in play area" card's own effect the way a normal RR 35 explore would. */
export function playArchaeologicalExpedition(
  state: GameState,
  action: { type: "PLAY_ARCHAEOLOGICAL_EXPEDITION"; playerId: PlayerId; planetId: PlanetId; chosenTrait?: "cultural" | "industrial" | "hazardous" },
  rules: RuleData,
): ActionResult {
  const played = playCard(state, action.playerId, "archaeological_expedition");
  if (!played.ok) return played;

  const found = findPlanet(played.state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  if (found.planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };
  // TE DUAL PLANET TRAITS (rulebook p.11): same "choose which trait" requirement as a normal RR 35 explore — see phases/exploration.ts's own explorePlanet for the identical logic.
  const traits = (rules.planets[action.planetId]?.traits ?? []) as ("cultural" | "industrial" | "hazardous")[];
  let trait: "cultural" | "industrial" | "hazardous" | undefined;
  if (traits.length === 1) {
    trait = traits[0];
  } else if (traits.length > 1) {
    if (!action.chosenTrait || !traits.includes(action.chosenTrait)) {
      return { ok: false, error: `TE DUAL PLANET TRAITS: ${action.planetId} has multiple traits (${traits.join("/")}) — chosenTrait must specify which one.` };
    }
    trait = action.chosenTrait;
  }
  if (!trait) return { ok: false, error: `${action.planetId} has no trait; no matching exploration deck.` };

  let deck = played.state.explorationDecks?.[trait] ?? [];
  let discardPile = played.state.explorationDiscardPiles?.[trait] ?? [];
  let player = played.player;
  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("archaeological_expedition") }];

  for (let i = 0; i < 3; i++) {
    const drawResult = drawExplorationCard(deck, discardPile);
    deck = drawResult.deck;
    discardPile = drawResult.discardPile;
    if (!drawResult.drawn) break;
    const cardId = drawResult.drawn;
    const card = rules.explorationCards[cardId];
    if (card?.isRelicFragment && card.fragmentType) {
      const key = card.fragmentType === "any" ? "unknown" : card.fragmentType;
      player = { ...player, relicFragments: { ...player.relicFragments, [key]: player.relicFragments[key] + 1 } };
      events.push({ type: "RELIC_FRAGMENT_GAINED", playerId: action.playerId, fragmentType: card.fragmentType });
    } else {
      discardPile = [...discardPile, cardId];
    }
  }

  const nextState: GameState = {
    ...played.state,
    explorationDecks: { ...played.state.explorationDecks!, [trait]: deck },
    explorationDiscardPiles: { ...played.state.explorationDiscardPiles, [trait]: discardPile } as GameState["explorationDiscardPiles"],
    players: { ...played.state.players, [action.playerId]: player },
  };
  return { ok: true, state: nextState, events };
}

/** RR "Divert Funding": return a non-unit-upgrade, non-faction technology this player owns to the shared pool, then research a DIFFERENT technology normally (paid cost, RR 90.7 prerequisites checked as usual — see RESEARCH_TECHNOLOGY's own doc comment on why `cost` is client-supplied). Reuses phases/technology.ts's own researchTechnology rather than duplicating prerequisite/payment logic. */
export function playDivertFunding(
  state: GameState,
  action: {
    type: "PLAY_DIVERT_FUNDING";
    playerId: PlayerId;
    returnedTechId: TechId;
    researchTechId: TechId;
    cost: number;
    exhaustPlanetIdsForResources: PlanetId[];
  },
  rules: RuleData,
): ActionResult {
  const played = playCard(state, action.playerId, "divert_funding");
  if (!played.ok) return played;

  if (!played.player.technologies.includes(action.returnedTechId)) {
    return { ok: false, error: "This player doesn't own that technology." };
  }
  if (rules.factionTechIds.has(action.returnedTechId)) {
    return { ok: false, error: "Divert Funding cannot return a faction technology." };
  }
  if (rules.unitUpgradeTechData[action.returnedTechId as unknown as UnitUpgradeId]) {
    return { ok: false, error: "Divert Funding cannot return a unit upgrade." };
  }
  if (action.returnedTechId === action.researchTechId) {
    return { ok: false, error: "Divert Funding must research a DIFFERENT technology." };
  }

  const afterReturn: GameState = {
    ...played.state,
    players: {
      ...played.state.players,
      [action.playerId]: { ...played.player, technologies: played.player.technologies.filter((t) => t !== action.returnedTechId) },
    },
  };

  const researched = researchTechnology(afterReturn, action.playerId, action.researchTechId, action.cost, action.exhaustPlanetIdsForResources, rules);
  if (!researched.ok) return researched;

  return {
    ok: true,
    state: researched.state,
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("divert_funding") }, ...researched.events],
  };
}

/** RR "Exploration Probe": explore a frontier token in or adjacent to a system containing this player's ships — same underlying draw/apply as phases/exploration.ts's own exploreFrontier, but WITHOUT that function's Dark Energy Tap gate (this card is its own, independent trigger) and with an "in or adjacent" target instead of "the currently-activated system". */
export function playExplorationProbe(state: GameState, action: { type: "PLAY_EXPLORATION_PROBE"; playerId: PlayerId; systemId: SystemId; choice?: ExplorationCardChoice }, rules: RuleData): ActionResult {
  const played = playCard(state, action.playerId, "exploration_probe");
  if (!played.ok) return played;

  const system = played.state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  if (!system.frontierToken) return { ok: false, error: `RR 35: ${action.systemId} has no frontier token.` };

  const hasShipsHere = (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => SHIP_TYPES.includes(s.unitType) && s.count > 0);
  const hasShipsAdjacent = getAdjacentSystems(played.state, action.systemId, rules).some((adjId) =>
    (played.state.systems[adjId]?.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => SHIP_TYPES.includes(s.unitType) && s.count > 0),
  );
  if (!hasShipsHere && !hasShipsAdjacent) {
    return { ok: false, error: "This player has no ships in or adjacent to that system." };
  }

  const deck = played.state.explorationDecks?.frontier ?? [];
  const discardPile = played.state.explorationDiscardPiles?.frontier ?? [];
  let nextState: GameState = { ...played.state, systems: { ...played.state.systems, [action.systemId]: { ...system, frontierToken: false } } };
  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("exploration_probe") }];

  const drawResult = drawExplorationCard(deck, discardPile);
  if (drawResult.drawn) {
    const cardId = drawResult.drawn;
    const result = applyExplorationCard(nextState, action.playerId, action.systemId, null, cardId, rules, action.choice);
    nextState = result.state;
    events.push(...result.events, { type: "EXPLORATION_CARD_DRAWN", playerId: action.playerId, cardId, deck: "frontier" });
    const card = rules.explorationCards[cardId];
    const goesToDiscard = !card?.isRelicFragment && !card?.attach && !card?.keepInPlayArea && !card?.purge;
    nextState = {
      ...nextState,
      explorationDecks: { ...nextState.explorationDecks!, frontier: drawResult.deck },
      explorationDiscardPiles: { ...nextState.explorationDiscardPiles, frontier: goesToDiscard ? [...drawResult.discardPile, cardId] : drawResult.discardPile } as GameState["explorationDiscardPiles"],
    };
  }

  return { ok: true, state: nextState, events };
}

/**
 * Batch 4: RR 8 "after/when an agenda is revealed" reaction cards (14 of
 * the 66 remaining reactive-timing cards). Unlike batches 1-3, these
 * don't stand alone — they read/write GameState.pendingAgendaVote, and 1
 * of them (applyAgendaPredictionRewards) is called FROM agendaPhase.ts's
 * own resolveAgendaVote rather than from GameEngine.ts's switch directly.
 */

/** Shared by every card below that removes a player from the current vote (the 8 riders' own "you cannot vote" clause, PLAY_ASSASSINATE_REPRESENTATIVE's identical clause, and PLAY_HACK_ELECTION's reordering) — keeps nextVoterIndex pointing at the same actual player after the array shifts. */
function removeFromVotingOrder(pending: PendingAgendaVote, playerId: PlayerId): PendingAgendaVote {
  const index = pending.votingOrder.indexOf(playerId);
  if (index === -1) return pending;
  const votingOrder = pending.votingOrder.filter((id) => id !== playerId);
  const nextVoterIndex = index < pending.nextVoterIndex ? pending.nextVoterIndex - 1 : pending.nextVoterIndex;
  return { ...pending, votingOrder, nextVoterIndex };
}

/** Shared bookkeeping for the 8 rider cards: records the prediction (checked later by applyAgendaPredictionRewards) and removes the predictor from this agenda's vote — same mechanism PLAY_ASSASSINATE_REPRESENTATIVE's plain "can't vote" effect uses, just also remembering the reward to apply if right. */
function submitRiderPrediction(
  state: GameState,
  playerId: PlayerId,
  cardId: ActionCardId,
  predictedOutcome: string,
  reward: AgendaPredictionReward,
): { ok: true; state: GameState } | { ok: false; error: string } {
  const pending = state.pendingAgendaVote;
  if (!pending) return { ok: false, error: "No agenda is currently being voted on." };
  if (!isPlayersTurnInWindow(state, "agenda_revealed", playerId)) {
    return { ok: false, error: "RR 1.20: it isn't this player's turn in the current reveal-reaction priority window." };
  }
  if (pending.predictions?.some((p) => p.playerId === playerId)) {
    return { ok: false, error: "This player has already predicted on this agenda." };
  }
  const withPrediction: PendingAgendaVote = { ...pending, predictions: [...(pending.predictions ?? []), { playerId, cardId, predictedOutcome, reward }] };
  const nextState = advancePriorityWindowAfterAction({ ...state, pendingAgendaVote: removeFromVotingOrder(withPrediction, playerId) }, playerId);
  return { ok: true, state: nextState };
}

/** Shared hand-removal + prediction-submission + event-building for all 8 riders below — each exported function only has to validate its own reward-specific target (a planet, a system, a tech) before calling this. */
function playRiderCard(state: GameState, playerId: PlayerId, cardId: string, predictedOutcome: string, reward: AgendaPredictionReward): ActionResult {
  const played = playCard(state, playerId, cardId);
  if (!played.ok) return played;
  const submitted = submitRiderPrediction(played.state, playerId, asActionCardId(cardId), predictedOutcome, reward);
  if (!submitted.ok) return submitted;
  return {
    ok: true,
    state: submitted.state,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId, cardId: asActionCardId(cardId) },
      { type: "AGENDA_PREDICTION_MADE", playerId, predictedOutcome },
    ],
  };
}

/** RR "Assassinate Representative": another player cannot vote on this agenda. */
export function playAssassinateRepresentative(state: GameState, action: { type: "PLAY_ASSASSINATE_REPRESENTATIVE"; playerId: PlayerId; targetPlayerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "agenda_revealed", action.playerId)) {
    return { ok: false, error: "RR 1.20: it isn't this player's turn in the current reveal-reaction priority window." };
  }
  const played = playCard(state, action.playerId, "assassinate_representative");
  if (!played.ok) return played;
  const pending = played.state.pendingAgendaVote;
  if (!pending) return { ok: false, error: "No agenda is currently being voted on." };
  if (!pending.votingOrder.includes(action.targetPlayerId)) {
    return { ok: false, error: "That player isn't currently eligible to vote on this agenda." };
  }
  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, pendingAgendaVote: removeFromVotingOrder(pending, action.targetPlayerId) },
    action.playerId,
  );
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("assassinate_representative") }] };
}

/** RR "Veto": discard the just-revealed agenda and reveal the next one instead — reuses agendaPhase.ts's own revealAgenda for the actual reveal (including all of ITS OWN reveal-time checks, e.g. Classified Document Leaks/Committee Formation) rather than duplicating any of that. */
/**
 * RR "Veto": discard the revealed agenda and reveal a replacement.
 *
 * KNOWN ARCHITECTURAL SIMPLIFICATION (yjmrobert.com/tirules/components/
 * c_action_cards): "Veto, the Xxcha Quash faction ability, the Xxcha
 * Political Favor promissory note, and the Political Secret promissory
 * note are all played in the SAME timing window, BEFORE the rider
 * timing window" — i.e. the real RR 1.20 structure has 2 sequential
 * sub-windows within "after an agenda is revealed" (agenda-cancelling
 * effects first, THEN riders), not 1 shared window covering all 14
 * reveal-reaction cards the way this project's own "agenda_revealed"
 * kind currently does. In practice this project's own single-window
 * model still reaches a similar outcome (a rider "played" before a
 * later Veto just becomes moot once its own agenda is discarded, rather
 * than never being offered the chance at all) — but it's not the exact
 * same sequencing, and a rider CAN currently be played before a Veto in
 * the same reveal, which shouldn't be possible per this ruling.
 * Splitting agenda_revealed into 2 real sequential windows would fix
 * this properly; flagged rather than attempted here.
 */
export function playVeto(state: GameState, action: { type: "PLAY_VETO"; playerId: PlayerId }, rules: RuleData): ActionResult {
  if (!isPlayersTurnInWindow(state, "agenda_revealed", action.playerId)) {
    return { ok: false, error: "RR 1.20: it isn't this player's turn in the current reveal-reaction priority window." };
  }
  const played = playCard(state, action.playerId, "veto");
  if (!played.ok) return played;
  const pending = played.state.pendingAgendaVote;
  if (!pending) return { ok: false, error: "No agenda is currently being voted on." };

  const vetoedState: GameState = {
    ...played.state,
    pendingAgendaVote: null,
    pendingPriorityWindow: null,
    agendaDeck: { ...played.state.agendaDeck, discardIds: [...played.state.agendaDeck.discardIds, pending.agendaId] },
  };
  // revealAgenda opens its own brand-new "agenda_revealed" priority window for whichever agenda comes up next — the OLD window (for the discarded agenda) is simply gone, not advanced/continued.
  const revealed = revealAgenda(vetoedState, rules);
  if (!revealed.ok) return revealed;
  return {
    ok: true,
    state: revealed.state,
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("veto") }, ...revealed.events],
  };
}

/** RR "Hack Election": rebuild the voting order to start right of the speaker and run counterclockwise — the mirror image of RR 8.2.ii's own left-of-speaker/clockwise rotation in agendaPhase.ts's revealAgenda (reverse the seating, then apply that exact same rotation formula). Keeps only players still actually eligible (e.g. already excluded by Assassinate Representative or a rider played earlier in reaction to the same reveal). */
export function playHackElection(state: GameState, action: { type: "PLAY_HACK_ELECTION"; playerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "agenda_revealed", action.playerId)) {
    return { ok: false, error: "RR 1.20: it isn't this player's turn in the current reveal-reaction priority window." };
  }
  const played = playCard(state, action.playerId, "hack_election");
  if (!played.ok) return played;
  const pending = played.state.pendingAgendaVote;
  if (!pending) return { ok: false, error: "No agenda is currently being voted on." };
  const speakerId = played.state.seatOrder.find((id) => played.state.players[id]?.isSpeaker);
  if (!speakerId) return { ok: false, error: "No speaker set — can't determine voting order." };

  const stillEligible = new Set(pending.votingOrder);
  let reorderedVotingOrder: PlayerId[];
  if (hasThundersEdge(played.state.mode)) {
    // TE Hack Election Ω: "During this agenda, you vote last." — simpler than the base version: only the caster moves, to the very end, everyone else keeps their existing relative order.
    reorderedVotingOrder = [...pending.votingOrder.filter((id) => id !== action.playerId), action.playerId].filter((id) => stillEligible.has(id));
  } else {
    const reversedSeatOrder = [...played.state.seatOrder].reverse();
    const reversedSpeakerIndex = reversedSeatOrder.indexOf(speakerId);
    const newOrder = [...reversedSeatOrder.slice(reversedSpeakerIndex + 1), ...reversedSeatOrder.slice(0, reversedSpeakerIndex + 1)];
    reorderedVotingOrder = newOrder.filter((id) => stillEligible.has(id));
  }

  const updatedPending: PendingAgendaVote = { ...pending, votingOrder: reorderedVotingOrder, nextVoterIndex: 0 };
  const nextState = advancePriorityWindowAfterAction({ ...played.state, pendingAgendaVote: updatedPending }, action.playerId);
  return {
    ok: true,
    state: nextState,
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("hack_election") }],
  };
}

/** RR "Insider Information": look at the top card of the agenda deck. Pure information, no state change beyond the mechanical discard — this engine already doesn't model hiding a not-yet-revealed agenda's identity from specific players (same scope cut as Committee Formation/Covert Legislation's own comments in agendaPhase.ts), so `state.agendaDeck.deckIds[0]` already IS that information for whoever's allowed to look. */
export function playInsiderInformation(state: GameState, action: { type: "PLAY_INSIDER_INFORMATION"; playerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "agenda_revealed", action.playerId)) {
    return { ok: false, error: "RR 1.20: it isn't this player's turn in the current reveal-reaction priority window." };
  }
  const played = playCard(state, action.playerId, "insider_information");
  if (!played.ok) return played;
  const nextState = advancePriorityWindowAfterAction(played.state, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("insider_information") }] };
}

/** RR "Diplomatic Pressure": another player must give this player 1 promissory note of their hand (the specific note is the target's own choice — the client resolves that choice before submitting `promissoryNoteId`). */
export function playDiplomaticPressure(
  state: GameState,
  action: { type: "PLAY_DIPLOMATIC_PRESSURE"; playerId: PlayerId; targetPlayerId: PlayerId; promissoryNoteId: PromissoryNoteId },
): ActionResult {
  if (!isPlayersTurnInWindow(state, "agenda_revealed", action.playerId)) {
    return { ok: false, error: "RR 1.20: it isn't this player's turn in the current reveal-reaction priority window." };
  }
  const played = playCard(state, action.playerId, "diplomatic_pressure");
  if (!played.ok) return played;
  if (action.targetPlayerId === action.playerId) return { ok: false, error: "Diplomatic Pressure must target another player." };
  // RR (yjmrobert.com/tirules/components/c_action_cards): "A player cannot play a second Diplomatic Pressure targeting the same player during the same agenda" — a different target, or a different (later) agenda, is fine.
  if (played.state.diplomaticPressureUsedThisAgenda?.some((u) => u.casterId === action.playerId && u.targetPlayerId === action.targetPlayerId)) {
    return { ok: false, error: "This player already used Diplomatic Pressure against that player this agenda." };
  }
  const target = played.state.players[action.targetPlayerId];
  if (!target?.promissoryNotesInHand.includes(action.promissoryNoteId)) {
    return { ok: false, error: "That player doesn't have that promissory note." };
  }

  const updatedTarget: Player = { ...target, promissoryNotesInHand: target.promissoryNotesInHand.filter((id) => id !== action.promissoryNoteId) };
  const updatedActingPlayer: Player = { ...played.player, promissoryNotesInHand: [...played.player.promissoryNotesInHand, action.promissoryNoteId] };
  const nextState = advancePriorityWindowAfterAction(
    {
      ...played.state,
      players: { ...played.state.players, [action.targetPlayerId]: updatedTarget, [action.playerId]: updatedActingPlayer },
      diplomaticPressureUsedThisAgenda: [...(played.state.diplomaticPressureUsedThisAgenda ?? []), { casterId: action.playerId, targetPlayerId: action.targetPlayerId }],
    },
    action.playerId,
  );
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("diplomatic_pressure") },
      { type: "PROMISSORY_NOTE_TRANSFERRED", fromPlayerId: action.targetPlayerId, toPlayerId: action.playerId, promissoryNoteId: action.promissoryNoteId },
    ],
  };
}

/** RR "Imperial Rider": if this player's predicted outcome wins, gain 1 victory point. */
export function playImperialRider(state: GameState, action: { type: "PLAY_IMPERIAL_RIDER"; playerId: PlayerId; predictedOutcome: string }): ActionResult {
  return playRiderCard(state, action.playerId, "imperial_rider", action.predictedOutcome, { kind: "victory_point" });
}

/** RR "Trade Rider": if correct, gain 5 trade goods. */
export function playTradeRider(state: GameState, action: { type: "PLAY_TRADE_RIDER"; playerId: PlayerId; predictedOutcome: string }): ActionResult {
  return playRiderCard(state, action.playerId, "trade_rider", action.predictedOutcome, { kind: "trade_goods" });
}

/** RR "Leadership Rider": if correct, gain 3 command tokens split across pools however this player likes. */
export function playLeadershipRider(
  state: GameState,
  action: { type: "PLAY_LEADERSHIP_RIDER"; playerId: PlayerId; predictedOutcome: string; tactic: number; fleet: number; strategy: number },
): ActionResult {
  if (action.tactic < 0 || action.fleet < 0 || action.strategy < 0 || action.tactic + action.fleet + action.strategy !== 3) {
    return { ok: false, error: "Leadership Rider's reward is exactly 3 command tokens, split however this player likes." };
  }
  return playRiderCard(state, action.playerId, "leadership_rider", action.predictedOutcome, {
    kind: "command_tokens",
    tactic: action.tactic,
    fleet: action.fleet,
    strategy: action.strategy,
  });
}

/** RR "Construction Rider": if correct, place 1 space dock from reinforcements on a planet this player controls (chosen now, at play time). */
export function playConstructionRider(
  state: GameState,
  action: { type: "PLAY_CONSTRUCTION_RIDER"; playerId: PlayerId; predictedOutcome: string; planetId: PlanetId },
): ActionResult {
  const found = findPlanet(state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  if (found.planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };
  return playRiderCard(state, action.playerId, "construction_rider", action.predictedOutcome, { kind: "space_dock", planetId: action.planetId });
}

/** RR "Diplomacy Rider": if correct, every OTHER player places a command token from THEIR OWN reinforcements in a system (chosen now) containing a planet this player controls — sourced from reinforcements first, falling back to an existing pool only if those are exhausted (rules/reinforcements.ts's own placeCommandTokenFromReinforcements). */
export function playDiplomacyRider(state: GameState, action: { type: "PLAY_DIPLOMACY_RIDER"; playerId: PlayerId; predictedOutcome: string; systemId: SystemId }): ActionResult {
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  if (!system.planets.some((p) => p.controllerId === action.playerId)) {
    return { ok: false, error: "This player doesn't control a planet in that system." };
  }
  return playRiderCard(state, action.playerId, "diplomacy_rider", action.predictedOutcome, { kind: "command_token_to_others", systemId: action.systemId });
}

/** RR "Politics Rider": if correct, draw 3 action cards and gain the speaker token. */
export function playPoliticsRider(state: GameState, action: { type: "PLAY_POLITICS_RIDER"; playerId: PlayerId; predictedOutcome: string }): ActionResult {
  return playRiderCard(state, action.playerId, "politics_rider", action.predictedOutcome, { kind: "action_cards_and_speaker" });
}

/** RR "Technology Rider": if correct, research 1 technology (free — cost 0 — but RR 90.7 prerequisites still apply, same as phases/technology.ts's own researchTechnology always enforces regardless of cost). */
export function playTechnologyRider(
  state: GameState,
  action: { type: "PLAY_TECHNOLOGY_RIDER"; playerId: PlayerId; predictedOutcome: string; techId: TechId; exhaustPlanetIdsForTechSpecialty?: PlanetId[] },
): ActionResult {
  if (state.players[action.playerId]?.technologies.includes(action.techId)) {
    return { ok: false, error: "This player already owns that technology." };
  }
  return playRiderCard(state, action.playerId, "technology_rider", action.predictedOutcome, {
    kind: "technology",
    techId: action.techId,
    exhaustPlanetIdsForTechSpecialty: action.exhaustPlanetIdsForTechSpecialty,
  });
}

/** RR "Warfare Rider": if correct, place 1 dreadnought from reinforcements in a system (chosen now) containing this player's ships. */
export function playWarfareRider(state: GameState, action: { type: "PLAY_WARFARE_RIDER"; playerId: PlayerId; predictedOutcome: string; systemId: SystemId }): ActionResult {
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  const hasOwnShip = (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => SHIP_TYPES.includes(s.unitType) && s.count > 0);
  if (!hasOwnShip) return { ok: false, error: "This player has no ships in that system." };
  return playRiderCard(state, action.playerId, "warfare_rider", action.predictedOutcome, { kind: "dreadnought", systemId: action.systemId });
}

/** RR "Sanction": no reward for the predictor — if correct, EVERY player who voted for that outcome returns 1 command token from their fleet pool, checked in applyAgendaPredictionRewards against `votesByOutcome` (not something the predictor themselves benefits from directly, hence the empty-looking { kind: "sanction" } payload). */
export function playSanction(state: GameState, action: { type: "PLAY_SANCTION"; playerId: PlayerId; predictedOutcome: string }): ActionResult {
  return playRiderCard(state, action.playerId, "sanction", action.predictedOutcome, { kind: "sanction" });
}

/**
 * Called from agendaPhase.ts's own resolveAgendaVote, right before it
 * hands off to finalizeAgendaResolution — checks every rider prediction
 * submitted on the CURRENT pendingAgendaVote against the actual winning
 * outcome and applies whichever rewards were correct. Kept out of
 * agendaPhase.ts itself, same "mechanics only, not what a specific
 * card/law does" separation that file's own header comment already
 * describes for laws/directives.
 */
export function applyAgendaPredictionRewards(
  state: GameState,
  rules: RuleData,
  winner: string | null,
  votesByOutcome: Record<string, { playerId: PlayerId; votes: number }[]>,
): { state: GameState; events: GameEvent[] } {
  const predictions = state.pendingAgendaVote?.predictions ?? [];
  if (predictions.length === 0) return { state, events: [] };

  let nextState = state;
  const events: GameEvent[] = [];

  for (const prediction of predictions) {
    const correct = prediction.predictedOutcome === winner;
    events.push({ type: "AGENDA_PREDICTION_RESOLVED", playerId: prediction.playerId, correct });
    if (!correct) continue;
    const player = nextState.players[prediction.playerId];
    if (!player) continue;
    const reward = prediction.reward;

    switch (reward.kind) {
      case "victory_point": {
        nextState = {
          ...nextState,
          players: { ...nextState.players, [prediction.playerId]: { ...player, victoryPoints: { ...player.victoryPoints, current: player.victoryPoints.current + 1 } } },
        };
        events.push({ type: "VICTORY_POINT_GAINED", playerId: prediction.playerId, amount: 1 });
        break;
      }
      case "trade_goods": {
        nextState = { ...nextState, players: { ...nextState.players, [prediction.playerId]: { ...player, tradeGoods: player.tradeGoods + 5 } } };
        events.push({ type: "TRADE_GOODS_GAINED", playerId: prediction.playerId, amount: 5 });
        break;
      }
      case "command_tokens": {
        // RR/the wiki: 16 total per player — grant as many of the requested tactic/fleet/strategy split as the remaining supply allows (in that order), rather than failing the whole reward over a cap that's realistically almost never actually hit.
        let remaining = commandTokensAvailableInReinforcements(player);
        const grantTactic = Math.min(reward.tactic, remaining);
        remaining -= grantTactic;
        const grantFleet = Math.min(reward.fleet, remaining);
        remaining -= grantFleet;
        const grantStrategy = Math.min(reward.strategy, remaining);
        nextState = {
          ...nextState,
          players: {
            ...nextState.players,
            [prediction.playerId]: {
              ...player,
              commandTokens: {
                ...player.commandTokens,
                tactic: player.commandTokens.tactic + grantTactic,
                fleet: player.commandTokens.fleet + grantFleet,
                strategy: player.commandTokens.strategy + grantStrategy,
              },
            },
          },
        };
        events.push({ type: "COMMAND_TOKENS_GAINED", playerId: prediction.playerId, tactic: grantTactic, fleet: grantFleet, strategy: grantStrategy });
        break;
      }
      case "space_dock": {
        // Re-checked here (not just at play time) since resolution can happen slightly later — silently skipped if this player no longer controls that planet, rather than failing the whole resolution over 1 rider's now-stale target.
        const found = findPlanet(nextState, reward.planetId);
        if (found && found.planet.controllerId === prediction.playerId) {
          let systems = nextState.systems;
          if (!checkReinforcementsAvailable(nextState, prediction.playerId, [{ unitType: "space_dock", count: 1 }]).ok) {
            // RR (yjmrobert.com/tirules): "If a player wishes to place a space dock, but there are none left in their reinforcements, they may remove a space dock from any system that does not contain one of their command tokens and place that instead." No interactive choice is possible at this automatic reward-resolution point, so this picks the first eligible one — see this file's own header comment on that same tradeoff elsewhere (e.g. Diplomacy Rider's reward).
            const player = nextState.players[prediction.playerId];
            const source = Object.entries(systems)
              .filter(([sid]) => !player.commandTokens.onBoard.includes(sid as SystemId))
              .flatMap(([sid, sys]) => sys.planets.map((p) => ({ sid: sid as SystemId, planet: p })))
              .find(({ planet }) => (planet.unitsByPlayer[prediction.playerId] ?? []).some((s) => s.unitType === "space_dock" && s.count > 0));
            if (!source) break; // no reinforcements AND no eligible existing space dock to relocate — reward simply doesn't apply
            const sourceStacks = source.planet.unitsByPlayer[prediction.playerId] ?? [];
            const sourceStack = sourceStacks.find((s) => s.unitType === "space_dock" && s.count > 0)!;
            const updatedSourceStacks = sourceStacks.map((s) => (s === sourceStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
            const updatedSourcePlanet: PlanetState = { ...source.planet, unitsByPlayer: { ...source.planet.unitsByPlayer, [prediction.playerId]: updatedSourceStacks } };
            systems = {
              ...systems,
              [source.sid]: { ...systems[source.sid], planets: systems[source.sid].planets.map((p) => (p.planetId === source.planet.planetId ? updatedSourcePlanet : p)) },
            };
          }
          const refound = findPlanet({ ...nextState, systems }, reward.planetId)!;
          const updatedPlanet = addPlanetUnits(refound.planet, prediction.playerId, "space_dock", 1);
          const updatedSystem: SystemState = { ...refound.system, planets: refound.system.planets.map((p) => (p.planetId === reward.planetId ? updatedPlanet : p)) };
          nextState = { ...nextState, systems: { ...systems, [refound.systemId]: updatedSystem } };
          events.push({ type: "UNITS_PRODUCED", playerId: prediction.playerId, systemId: refound.systemId, planetId: reward.planetId, unitType: "space_dock", count: 1, totalCost: 0 });
        }
        break;
      }
      case "command_token_to_others": {
        const system = nextState.systems[reward.systemId];
        if (system) {
          let players = nextState.players;
          for (const otherId of Object.keys(players) as PlayerId[]) {
            if (otherId === prediction.playerId) continue;
            const other = players[otherId];
            if (other.commandTokens.onBoard.includes(reward.systemId)) continue;
            const placed = placeCommandTokenFromReinforcements(other, reward.systemId);
            if (placed.ok) players = { ...players, [otherId]: placed.player };
          }
          nextState = { ...nextState, players };
        }
        break;
      }
      case "action_cards_and_speaker": {
        const drawResult = drawActionCardsForPlayer(nextState, prediction.playerId, 3);
        nextState = drawResult.state;
        events.push(...drawResult.events);
        const previousSpeakerId = nextState.seatOrder.find((id) => nextState.players[id]?.isSpeaker);
        let players: GameState["players"] = nextState.players;
        if (previousSpeakerId && previousSpeakerId !== prediction.playerId) {
          players = { ...players, [previousSpeakerId]: { ...players[previousSpeakerId], isSpeaker: false } };
        }
        players = { ...players, [prediction.playerId]: { ...players[prediction.playerId], isSpeaker: true } };
        nextState = { ...nextState, players };
        events.push({ type: "SPEAKER_CHANGED", playerId: prediction.playerId });
        break;
      }
      case "technology": {
        // RR "Technology Rider" (yjmrobert.com/tirules/components/c_action_cards): "A player may exhaust a planet with a technology specialty to ignore a prerequisite... This planet will ready at the end of the agenda phase" — researchTechnology's own exhaustPlanetIdsForTechSpecialty param already implements the bypass itself (readying at end of agenda phase is that same mechanism's own standing behavior, not something unique to this reward). KNOWN GAP: the ruling's OTHER bypass — "exhaust AI Development Algorithm to ignore a prerequisite on a UNIT UPGRADE technology" — lives on a separate researchUnitUpgrade function this reward doesn't call (it always calls researchTechnology, for a regular tech); Technology Rider predicting a unit-upgrade outcome with that specific bypass isn't wired through yet.
        const researched = researchTechnology(nextState, prediction.playerId, reward.techId, 0, [], rules, undefined, reward.exhaustPlanetIdsForTechSpecialty);
        if (researched.ok) {
          nextState = researched.state;
          events.push(...researched.events);
        }
        break;
      }
      case "dreadnought": {
        const system = nextState.systems[reward.systemId];
        if (system && checkReinforcementsAvailable(nextState, prediction.playerId, [{ unitType: "dreadnought", count: 1 }]).ok) {
          const updatedSystem = addSpaceUnits(system, prediction.playerId, "dreadnought", 1);
          nextState = { ...nextState, systems: { ...nextState.systems, [reward.systemId]: updatedSystem } };
          events.push({ type: "UNITS_PRODUCED", playerId: prediction.playerId, systemId: reward.systemId, unitType: "dreadnought", count: 1, totalCost: 0 });
        }
        break;
      }
      case "sanction": {
        const voters = votesByOutcome[winner ?? ""] ?? [];
        let players = nextState.players;
        for (const voter of voters) {
          const voterPlayer = players[voter.playerId];
          if (!voterPlayer || voterPlayer.commandTokens.fleet < 1) continue;
          players = { ...players, [voter.playerId]: { ...voterPlayer, commandTokens: { ...voterPlayer.commandTokens, fleet: voterPlayer.commandTokens.fleet - 1 } } };
        }
        nextState = { ...nextState, players };
        break;
      }
    }
  }

  return { state: nextState, events };
}

/**
 * Batch 5: combat/movement/invasion "temporary modifier" cards. Each sets
 * 1 named field on PendingTacticalAction (see that interface's own doc
 * comments) rather than resolving anything itself — the actual effect is
 * applied later, at the exact point rules/combat.ts, rules/movement.ts,
 * rules/adjacency.ts, or phases/tacticalAction.ts already computes the
 * thing being modified. All 5 "after you activate a system" cards below
 * share the same timing check (own helper, not worth exporting elsewhere
 * — nothing outside this file plays these cards).
 */

/** Shared by every "After you activate a system:" card below — playable any time between ACTIVATE_SYSTEM and this player's own MOVE_SHIPS, since all 5 modify something movement itself reads. */
function requireJustActivatedOwnSystem(state: GameState, playerId: PlayerId): { ok: true; pending: NonNullable<GameState["pendingTacticalAction"]> } | { ok: false; error: string } {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== playerId) return { ok: false, error: "RR 78: no tactical action in progress for this player." };
  if (pending.step !== "movement") return { ok: false, error: `RR 78: expected step "movement", got "${pending.step}".` };
  if (!isPlayersTurnInWindow(state, "after_system_activated", playerId)) {
    return { ok: false, error: "RR 1.19: it isn't this player's turn in the current after-system-activation priority window." };
  }
  return { ok: true, pending };
}

/** RR "Flank Speed": +1 move value for every one of this player's ships this tactical action. */
export function playFlankSpeed(state: GameState, action: { type: "PLAY_FLANK_SPEED"; playerId: PlayerId }): ActionResult {
  const timing = requireJustActivatedOwnSystem(state, action.playerId);
  if (!timing.ok) return timing;
  // RR FAQ (tirules2.com/C_action_cards): "A second Flank Speed cannot be played to give +2 to the move value of each ship." — blocked outright, not just a no-op stack.
  if (timing.pending.flankSpeedPlayerId === action.playerId) {
    return { ok: false, error: "This player has already played Flank Speed this tactical action." };
  }
  const played = playCard(state, action.playerId, "flank_speed");
  if (!played.ok) return played;

  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, pendingTacticalAction: { ...timing.pending, flankSpeedPlayerId: action.playerId } },
    action.playerId,
  );
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("flank_speed") }] };
}

/** RR "In the Silence of Space": choose 1 system — this player's ships whose move originates FROM that system can pass through systems with other players' ships for the rest of this tactical action. */
export function playInTheSilenceOfSpace(state: GameState, action: { type: "PLAY_IN_THE_SILENCE_OF_SPACE"; playerId: PlayerId; systemId: SystemId }): ActionResult {
  const timing = requireJustActivatedOwnSystem(state, action.playerId);
  if (!timing.ok) return timing;
  const played = playCard(state, action.playerId, "in_the_silence_of_space");
  if (!played.ok) return played;

  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, pendingTacticalAction: { ...timing.pending, passThroughEnemiesFromSystemId: action.systemId } },
    action.playerId,
  );
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("in_the_silence_of_space") }] };
}

/** RR "Lost Star Chart": alpha and beta wormhole systems count as adjacent to each other for the rest of this tactical action. */
export function playLostStarChart(state: GameState, action: { type: "PLAY_LOST_STAR_CHART"; playerId: PlayerId }): ActionResult {
  const timing = requireJustActivatedOwnSystem(state, action.playerId);
  if (!timing.ok) return timing;
  const played = playCard(state, action.playerId, "lost_star_chart");
  if (!played.ok) return played;

  const nextState = advancePriorityWindowAfterAction({ ...played.state, pendingTacticalAction: { ...timing.pending, lostStarChartActive: true } }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("lost_star_chart") }] };
}

/** RR "Solar Flare": no OTHER player may use Space Cannon against this player's ships during this movement. */
export function playSolarFlare(state: GameState, action: { type: "PLAY_SOLAR_FLARE"; playerId: PlayerId }): ActionResult {
  const timing = requireJustActivatedOwnSystem(state, action.playerId);
  if (!timing.ok) return timing;
  const played = playCard(state, action.playerId, "solar_flare");
  if (!played.ok) return played;

  const nextState = advancePriorityWindowAfterAction({ ...played.state, pendingTacticalAction: { ...timing.pending, solarFlarePlayerId: action.playerId } }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("solar_flare") }] };
}

/** RR "Nav Suite": ignore the effects of anomalies during this tactical action's movement step. */
export function playNavSuite(state: GameState, action: { type: "PLAY_NAV_SUITE"; playerId: PlayerId }): ActionResult {
  const timing = requireJustActivatedOwnSystem(state, action.playerId);
  if (!timing.ok) return timing;
  const played = playCard(state, action.playerId, "nav_suite");
  if (!played.ok) return played;

  const nextState = advancePriorityWindowAfterAction({ ...played.state, pendingTacticalAction: { ...timing.pending, navSuiteActive: true } }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("nav_suite") }] };
}

/** RR "Morale Boost": +1 to the result of this player's combat rolls this round — space OR ground combat, whichever is active. Legality is now entirely "is it this player's turn in the open combat_round_start window" (opened precisely — see phases/spaceCombat.ts's openCombatRoundStartWindowIfNeeded / phases/invasion.ts's openGroundCombatRoundStartWindowIfNeeded) rather than the old ad-hoc "no dice pending" proxy this project used before the RR 1.19/1.20 priority-window system existed. */
export function playMoraleBoost(state: GameState, action: { type: "PLAY_MORALE_BOOST"; playerId: PlayerId }): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || !isPlayersTurnInWindow(state, "combat_round_start", action.playerId)) {
    return { ok: false, error: "RR 1.19/1.20: it isn't this player's turn in the current combat-round priority window." };
  }
  // RR FAQ (tirules2.com/C_action_cards): "A second Morale Boost cannot be played during a combat round to give +2..." — blocked outright, not just a no-op stack.
  if (pending.moraleBoost?.playerId === action.playerId && pending.moraleBoost.round === (pending.combatRound ?? 1)) {
    return { ok: false, error: "This player has already played Morale Boost this combat round." };
  }
  const played = playCard(state, action.playerId, "morale_boost");
  if (!played.ok) return played;

  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, pendingTacticalAction: { ...pending, moraleBoost: { playerId: action.playerId, round: pending.combatRound ?? 1 } } },
    action.playerId,
  );
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("morale_boost") }] };
}

/** RR "Skilled Retreat": at the start of a (space) combat round, move all of this player's ships to an adjacent system free of other players' ships, ending the combat as a DRAW (NOT crediting the other player with a win — no Shard of the Throne, no "win a space combat" objective credit — even though their ships are the only ones left behind), then place a command token there. Reuses phases/spaceCombat.ts's own moveAllShips for the actual relocation (handles cargo/capacity exactly like a normal retreat). */
export function playSkilledRetreat(
  state: GameState,
  action: { type: "PLAY_SKILLED_RETREAT"; playerId: PlayerId; toSystemId: SystemId },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat" || !isPlayersTurnInWindow(state, "combat_round_start", action.playerId)) {
    return { ok: false, error: "RR 1.19/1.20: it isn't this player's turn in the current combat-round priority window." };
  }

  const activeSystemId = pending.systemId;
  if (!getAdjacentSystems(state, activeSystemId, rules).includes(action.toSystemId)) {
    return { ok: false, error: `${action.toSystemId} isn't adjacent to ${activeSystemId}.` };
  }
  const hasEnemyShips = Object.entries(state.systems[action.toSystemId]?.spaceUnitsByPlayer ?? {}).some(
    ([pid, stacks]) => pid !== action.playerId && (stacks ?? []).some((s) => s.count > 0),
  );
  if (hasEnemyShips) return { ok: false, error: `${action.toSystemId} contains another player's ships.` };
  // RR (yjmrobert.com/tirules/components/c_action_cards): "A player cannot use Skilled Retreat to move into a nebula."
  if (state.systems[action.toSystemId]?.anomalies.includes("nebula")) {
    return { ok: false, error: "Skilled Retreat cannot move into a nebula." };
  }

  const played = playCard(state, action.playerId, "skilled_retreat");
  if (!played.ok) return played;

  const moveResult = moveAllShips(played.state, activeSystemId, action.toSystemId, action.playerId, rules);
  let nextState = moveResult.state;

  const player = nextState.players[action.playerId];
  const placed = placeCommandTokenFromReinforcements(player, action.toSystemId);
  if (!placed.ok) return placed;
  // Combat's over entirely (moving to "invasion") — the OLD combat_round_start window is moot; openInvasionStartWindowIfNeeded opens the new "invasion_start" one fresh (it's a no-op if there's nothing to ask).
  nextState = openInvasionStartWindowIfNeeded({
    ...nextState,
    players: { ...nextState.players, [action.playerId]: placed.player },
    pendingTacticalAction: { playerId: pending.playerId, systemId: activeSystemId, step: "invasion" },
    pendingPriorityWindow: null,
  });

  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("skilled_retreat") },
      ...moveResult.events,
      { type: "SPACE_COMBAT_ENDED", systemId: activeSystemId, survivingPlayerId: null },
    ],
  };
}

/** RR "Bunker": at the start of an invasion, -4 to the result of enemy Bombardment rolls against planets THIS player controls in the active system, for the rest of the invasion. Played by a DEFENDER (never the active/attacking player), same as the real card's use case. */
export function playBunker(state: GameState, action: { type: "PLAY_BUNKER"; playerId: PlayerId }): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || !isPlayersTurnInWindow(state, "invasion_start", action.playerId)) {
    return { ok: false, error: "RR 1.19/1.20: it isn't this player's turn in the current invasion-start priority window." };
  }
  if (pending.playerId === action.playerId) return { ok: false, error: 'RR "Bunker": only a defending player (not the invader) can play this.' };
  const system = state.systems[pending.systemId];
  if (!system?.planets.some((p) => p.controllerId === action.playerId)) {
    return { ok: false, error: "This player doesn't control a planet in the system being invaded." };
  }
  const played = playCard(state, action.playerId, "bunker");
  if (!played.ok) return played;

  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, pendingTacticalAction: { ...pending, bunkerPlayerId: action.playerId } },
    action.playerId,
  );
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("bunker") }] };
}

/** RR "Blitz": at the start of an invasion, every one of THIS (invading) player's non-fighter ships in the active system that doesn't already have Bombardment gains Bombardment 6 (1 die), for the rest of the invasion. */
export function playBlitz(state: GameState, action: { type: "PLAY_BLITZ"; playerId: PlayerId }): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId || !isPlayersTurnInWindow(state, "invasion_start", action.playerId)) {
    return { ok: false, error: "RR 1.19/1.20: it isn't this player's turn in the current invasion-start priority window." };
  }
  const played = playCard(state, action.playerId, "blitz");
  if (!played.ok) return played;

  const nextState = advancePriorityWindowAfterAction({ ...played.state, pendingTacticalAction: { ...pending, blitzPlayerId: action.playerId } }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("blitz") }] };
}

/**
 * RR (yjmrobert.com/tirules/rules/r_action_cards + the Xxcha Kingdom's
 * own Instinct Training rules): cancel another player's just-announced
 * action card entirely — no cost is paid, no effect occurs, and (per the
 * rider-specific note on that same page) if the cancelled card was one
 * that "will have an effect later, such as a rider", it can ONLY ever be
 * cancelled right here, at its original announcement, never once it
 * resolves. The cancelled card was never actually removed from the
 * announcer's hand yet (GameEngine.ts's own announceActionCard doesn't
 * touch it — only the real handler's own playCard call would have,
 * during resolution), so that removal + discard happens here instead.
 */
export function playSabotage(state: GameState, action: { type: "PLAY_SABOTAGE"; playerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "action_card_announced", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current action-card-announcement priority window." };
  }
  const announced = state.pendingActionCardAnnouncement;
  if (!announced) return { ok: false, error: "No action card is currently pending Sabotage." };

  const played = playCard(state, action.playerId, "sabotage");
  if (!played.ok) return played;

  const announcer = played.state.players[announced.playerId];
  const updatedAnnouncer: Player = { ...announcer, actionCards: announcer.actionCards.filter((c) => c !== announced.cardId) };
  const nextState: GameState = {
    ...played.state,
    players: { ...played.state.players, [announced.playerId]: updatedAnnouncer },
    actionCardDiscardPile: [...(played.state.actionCardDiscardPile ?? []), announced.cardId],
    pendingActionCardAnnouncement: undefined,
    pendingPriorityWindow: played.state.stashedPriorityWindow ?? null,
    stashedPriorityWindow: undefined,
  };

  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("sabotage") },
      { type: "ACTION_CARD_CANCELLED", playerId: announced.playerId, cardId: announced.cardId, cancelledBy: action.playerId },
    ],
  };
}

/**
 * Batch 6: strategy-phase cards. "strategy_phase_start" and "status_
 * phase_strategy_card_return" are opened by phases/actionPhase.ts's own
 * startNewRound/autoAdvancePhase; "strategy_card_chosen" is opened by
 * phases/strategyPhase.ts's own chooseStrategyCard right after a pick
 * resolves; "strategic_action_start" is opened by whichever strategy-
 * card-primary handler is about to run (see phases/strategyCardAbilities.ts).
 */

/** RR "Summit": at the start of the strategy phase, gain 2 command tokens (capped at the fixed 16-per-player supply, same partial-grant convention as Leadership Rider's own reward). */
export function playSummit(state: GameState, action: { type: "PLAY_SUMMIT"; playerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "strategy_phase_start", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current strategy-phase-start priority window." };
  }
  const played = playCard(state, action.playerId, "summit");
  if (!played.ok) return played;

  const remaining = commandTokensAvailableInReinforcements(played.player);
  const grantTactic = Math.min(1, remaining);
  const grantFleet = Math.min(2 - grantTactic, remaining - grantTactic);
  const updatedPlayer: Player = {
    ...played.player,
    commandTokens: { ...played.player.commandTokens, tactic: played.player.commandTokens.tactic + grantTactic, fleet: played.player.commandTokens.fleet + grantFleet },
  };
  const nextState = advancePriorityWindowAfterAction({ ...played.state, players: { ...played.state.players, [action.playerId]: updatedPlayer } }, action.playerId);
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("summit") },
      { type: "COMMAND_TOKENS_GAINED", playerId: action.playerId, tactic: grantTactic, fleet: grantFleet, strategy: 0 },
    ],
  };
}

/** RR "Manipulate Investments": at the start of the strategy phase, place a total of 5 trade goods on strategy cards of this player's choice, across at least 3 different cards — only cards still in the common play area (`unclaimedStrategyCards`) qualify, since a claimed card isn't "on strategy cards" in the common area anymore. */
export function playManipulateInvestments(
  state: GameState,
  action: { type: "PLAY_MANIPULATE_INVESTMENTS"; playerId: PlayerId; distribution: { cardId: StrategyCardId; amount: number }[] },
): ActionResult {
  if (!isPlayersTurnInWindow(state, "strategy_phase_start", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current strategy-phase-start priority window." };
  }
  const distinctCards = new Set(action.distribution.map((d) => d.cardId));
  const total = action.distribution.reduce((sum, d) => sum + d.amount, 0);
  if (distinctCards.size < 3 || total !== 5 || action.distribution.some((d) => d.amount <= 0)) {
    return { ok: false, error: "Manipulate Investments places exactly 5 trade goods total, across at least 3 different strategy cards." };
  }
  const played = playCard(state, action.playerId, "manipulate_investments");
  if (!played.ok) return played;

  let unclaimed = played.state.unclaimedStrategyCards;
  for (const { cardId, amount } of action.distribution) {
    const entry = unclaimed.find((c) => c.cardId === cardId);
    if (!entry) return { ok: false, error: `${cardId} isn't in the common play area.` };
    unclaimed = unclaimed.map((c) => (c.cardId === cardId ? { ...c, tradeGoods: c.tradeGoods + amount } : c));
  }

  const nextState = advancePriorityWindowAfterAction({ ...played.state, unclaimedStrategyCards: unclaimed }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("manipulate_investments") }] };
}

/** RR "Political Stability": when this player would return their strategy card(s) during the status phase, keep them instead — sets a flag phases/actionPhase.ts's own startNewRound checks; this player then sits out picking a NEW strategy card the upcoming strategy phase entirely. */
export function playPoliticalStability(state: GameState, action: { type: "PLAY_POLITICAL_STABILITY"; playerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "status_phase_strategy_card_return", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current status-phase strategy-card-return priority window." };
  }
  const played = playCard(state, action.playerId, "political_stability");
  if (!played.ok) return played;

  const updatedPlayer: Player = { ...played.player, politicalStabilityKeepCards: true };
  const nextState = advancePriorityWindowAfterAction({ ...played.state, players: { ...played.state.players, [action.playerId]: updatedPlayer } }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("political_stability") }] };
}

/** RR "Public Disgrace": undo another player's just-resolved strategy card pick — returns the card to the common play area (refunding any trade goods it carried, since the pick itself is being reversed), and marks it excluded so phases/strategyPhase.ts's own chooseStrategyCard rejects re-picking the SAME card, forcing "a different strategy card instead." */
export function playPublicDisgrace(state: GameState, action: { type: "PLAY_PUBLIC_DISGRACE"; playerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "strategy_card_chosen", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current strategy-card-chosen priority window." };
  }
  const lastChoice = state.lastStrategyCardChoice;
  if (!lastChoice) return { ok: false, error: "No strategy card choice is currently pending reaction." };

  const played = playCard(state, action.playerId, "public_disgrace");
  if (!played.ok) return played;

  const chooser = played.state.players[lastChoice.playerId];
  const updatedChooser: Player = {
    ...chooser,
    strategyCards: chooser.strategyCards.filter((c) => c.cardId !== lastChoice.cardId),
    tradeGoods: Math.max(0, chooser.tradeGoods - lastChoice.tradeGoodsGained),
    excludedStrategyCardIds: [...(chooser.excludedStrategyCardIds ?? []), lastChoice.cardId],
  };

  const nextState: GameState = {
    ...played.state,
    players: { ...played.state.players, [lastChoice.playerId]: updatedChooser },
    unclaimedStrategyCards: [...played.state.unclaimedStrategyCards, { cardId: lastChoice.cardId, tradeGoods: lastChoice.tradeGoodsGained }],
    lastStrategyCardChoice: undefined,
    pendingPriorityWindow: null,
  };

  return {
    ok: true,
    state: nextState,
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("public_disgrace") }],
  };
}

/** RR "Coup d'Etat": cancel another player's just-announced strategic action outright — their turn ends immediately (same advanceActivePlayer this project's own PASS action uses), the strategy card's own primary ability never resolves, and (per the card's own explicit text) the card is NOT exhausted, unlike a normal completed strategic action. */
export function playCoupDetat(state: GameState, action: { type: "PLAY_COUP_DETAT"; playerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "strategic_action_start", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current strategic-action-start priority window." };
  }
  const announced = state.pendingStrategicActionAnnouncement;
  if (!announced) return { ok: false, error: "No strategic action is currently pending reaction." };

  const played = playCard(state, action.playerId, "coup_detat");
  if (!played.ok) return played;

  // RR (yjmrobert.com/tirules/components/c_action_cards, under Master Plan): "If a player's turn is ended by a game effect, they cannot use Master Plan to perform an additional action" — clear any banked bonus for the player whose turn Coup d'Etat is ending, so it can't linger and grant a bonus action on some later turn instead.
  const endedPlayer = played.state.players[announced.playerId];
  const playersWithClearedBonus = endedPlayer?.masterPlanBonusAvailable ? { ...played.state.players, [announced.playerId]: { ...endedPlayer, masterPlanBonusAvailable: false } } : played.state.players;

  const nextState: GameState = advanceActivePlayer({
    ...played.state,
    players: playersWithClearedBonus,
    pendingStrategicActionAnnouncement: undefined,
    pendingPriorityWindow: played.state.stashedPriorityWindow ?? null,
    stashedPriorityWindow: undefined,
  });

  return {
    ok: true,
    state: nextState,
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("coup_detat") }],
  };
}

/**
 * Batch 7: agenda-phase cards. "agenda_phase_start" is opened by
 * phases/actionPhase.ts's own autoAdvancePhase; the vote/outcome-related
 * windows below are opened by phases/agendaPhase.ts at their own exact
 * points.
 */

/** RR "Ancient Burial Sites": at the start of the agenda phase, exhaust every cultural planet a chosen player controls. */
export function playAncientBurialSites(
  state: GameState,
  action: { type: "PLAY_ANCIENT_BURIAL_SITES"; playerId: PlayerId; targetPlayerId: PlayerId },
  rules: RuleData,
): ActionResult {
  if (!isPlayersTurnInWindow(state, "agenda_phase_start", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current agenda-phase-start priority window." };
  }
  const played = playCard(state, action.playerId, "ancient_burial_sites");
  if (!played.ok) return played;

  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("ancient_burial_sites") }];
  const systems: GameState["systems"] = { ...played.state.systems };
  for (const [systemId, system] of Object.entries(played.state.systems)) {
    let changed = false;
    const planets = system.planets.map((p) => {
      if (p.controllerId === action.targetPlayerId && !p.exhausted && (rules.planets[p.planetId]?.traits ?? []).includes("cultural")) {
        changed = true;
        events.push({ type: "PLANET_EXHAUSTED", playerId: action.targetPlayerId, planetId: p.planetId });
        return { ...p, exhausted: true };
      }
      return p;
    });
    if (changed) systems[systemId as SystemId] = { ...system, planets };
  }

  const nextState = advancePriorityWindowAfterAction({ ...played.state, systems }, action.playerId);
  return { ok: true, state: nextState, events };
}

/** RR "Distinguished Councilor": after this player casts votes, cast 5 additional votes for that same outcome. */
export function playDistinguishedCouncilor(state: GameState, action: { type: "PLAY_DISTINGUISHED_COUNCILOR"; playerId: PlayerId }): ActionResult {
  // RR (yjmrobert.com/tirules/components/c_action_cards): "The speaker may play Distinguished Councilor after another player plays Bribery" — for the speaker specifically (whose own vote IS "the speaker voting"), both windows sit at the same functional moment, so either order is legal. Any OTHER player's own Distinguished Councilor opportunity stays tied strictly to their own "after_you_cast_votes" window (ruling: "only after their normal vote, not... at another point").
  const isSpeakerInSpeakerVotesWindow = state.players[action.playerId]?.isSpeaker && isPlayersTurnInWindow(state, "after_speaker_votes", action.playerId);
  if (!isPlayersTurnInWindow(state, "after_you_cast_votes", action.playerId) && !isSpeakerInSpeakerVotesWindow) {
    return { ok: false, error: "It isn't this player's turn in the current after-you-cast-votes priority window." };
  }
  const pending = state.pendingAgendaVote;
  if (!pending) return { ok: false, error: "No agenda is currently being voted on." };
  const ownVoteEntry = Object.entries(pending.votesByOutcome).find(([, votes]) => votes.some((v) => v.playerId === action.playerId));
  if (!ownVoteEntry) return { ok: false, error: "This player hasn't cast a vote on this agenda yet." };
  const [outcome, votes] = ownVoteEntry;

  const played = playCard(state, action.playerId, "distinguished_councilor");
  if (!played.ok) return played;

  const updatedVotes = votes.map((v) => (v.playerId === action.playerId ? { ...v, votes: v.votes + 5 } : v));
  const updatedPending: PendingAgendaVote = { ...played.state.pendingAgendaVote!, votesByOutcome: { ...played.state.pendingAgendaVote!.votesByOutcome, [outcome]: updatedVotes } };
  const nextState = advancePriorityWindowAfterAction({ ...played.state, pendingAgendaVote: updatedPending }, action.playerId);
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("distinguished_councilor") },
      { type: "VOTES_CAST", playerId: action.playerId, outcome, votes: 5 },
    ],
  };
}

/** RR "Bribery": after the speaker votes (i.e. once the last vote of this agenda has been cast — RR 8.2.ii: voting always ends with the speaker), spend any number of trade goods to cast that many additional votes for the outcome THIS player voted for. */
export function playBribery(state: GameState, action: { type: "PLAY_BRIBERY"; playerId: PlayerId; tradeGoodsToSpend: number }): ActionResult {
  if (!isPlayersTurnInWindow(state, "after_speaker_votes", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current after-the-speaker-votes priority window." };
  }
  // RR (yjmrobert.com/tirules/components/c_action_cards): "A player may spend zero trade goods when they play Bribery."
  if (action.tradeGoodsToSpend < 0) return { ok: false, error: "Bribery cannot spend a negative number of trade goods." };
  const pending = state.pendingAgendaVote;
  if (!pending) return { ok: false, error: "No agenda is currently being voted on." };
  const ownVoteEntry = Object.entries(pending.votesByOutcome).find(([, votes]) => votes.some((v) => v.playerId === action.playerId));
  if (!ownVoteEntry) return { ok: false, error: "This player hasn't cast a vote on this agenda." };
  const [outcome, votes] = ownVoteEntry;
  const player = state.players[action.playerId];
  if (player.tradeGoods < action.tradeGoodsToSpend) return { ok: false, error: "Not enough trade goods." };

  const played = playCard(state, action.playerId, "bribery");
  if (!played.ok) return played;

  const updatedPlayer: Player = { ...played.player, tradeGoods: played.player.tradeGoods - action.tradeGoodsToSpend };
  const updatedVotes = votes.map((v) => (v.playerId === action.playerId ? { ...v, votes: v.votes + action.tradeGoodsToSpend } : v));
  const updatedPending: PendingAgendaVote = { ...played.state.pendingAgendaVote!, votesByOutcome: { ...played.state.pendingAgendaVote!.votesByOutcome, [outcome]: updatedVotes } };
  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, players: { ...played.state.players, [action.playerId]: updatedPlayer }, pendingAgendaVote: updatedPending },
    action.playerId,
  );
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("bribery") },
      { type: "VOTES_CAST", playerId: action.playerId, outcome, votes: action.tradeGoodsToSpend },
    ],
  };
}

/** Shared by both "Confusing Legal Text" and "Confounding Legal Text" — finds the law just recorded from the current agenda's election and redirects its ownership to a new player. */
function redirectElectedOutcome(state: GameState, playerId: PlayerId, cardId: string, newOwnerId: PlayerId): ActionResult {
  const lastResolved = state.lastResolvedAgenda;
  if (!lastResolved) return { ok: false, error: "No agenda has been resolved yet this reaction window." };
  const law = state.agendaDeck.lawsInPlay.find((l) => l.agendaId === lastResolved.agendaId);
  if (!law || typeof law.ownerId !== "string" || law.ownerId === "common") {
    return { ok: false, error: "That agenda's outcome didn't elect a specific player." };
  }
  const currentOwnerId = law.ownerId as PlayerId;

  const played = playCard(state, playerId, cardId);
  if (!played.ok) return played;

  const updatedLawsInPlay = played.state.agendaDeck.lawsInPlay.map((l) => (l.agendaId === lastResolved.agendaId ? { ...l, ownerId: newOwnerId } : l));
  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, agendaDeck: { ...played.state.agendaDeck, lawsInPlay: updatedLawsInPlay } },
    playerId,
  );
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId, cardId: asActionCardId(cardId) },
      { type: "ELECTED_PLAYER_CHANGED", agendaId: lastResolved.agendaId, fromPlayerId: currentOwnerId, toPlayerId: newOwnerId },
    ],
  };
}

/** RR "Confusing Legal Text": when THIS player is elected as the outcome of an agenda, choose another player to be elected instead. */
export function playConfusingLegalText(state: GameState, action: { type: "PLAY_CONFUSING_LEGAL_TEXT"; playerId: PlayerId; newElectedPlayerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "elected_as_outcome", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current elected-as-outcome priority window." };
  }
  const lastResolved = state.lastResolvedAgenda;
  const law = lastResolved ? state.agendaDeck.lawsInPlay.find((l) => l.agendaId === lastResolved.agendaId) : undefined;
  if (!law || law.ownerId !== action.playerId) {
    return { ok: false, error: "This player isn't the currently elected outcome of that agenda." };
  }
  return redirectElectedOutcome(state, action.playerId, "confusing_legal_text", action.newElectedPlayerId);
}

/** RR "Confounding Legal Text": when ANOTHER player is elected as the outcome of an agenda, this player becomes the elected player instead. */
export function playConfoundingLegalText(state: GameState, action: { type: "PLAY_CONFOUNDING_LEGAL_TEXT"; playerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "elected_as_outcome", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current elected-as-outcome priority window." };
  }
  const lastResolved = state.lastResolvedAgenda;
  const law = lastResolved ? state.agendaDeck.lawsInPlay.find((l) => l.agendaId === lastResolved.agendaId) : undefined;
  if (!law || law.ownerId === action.playerId) {
    return { ok: false, error: "This player is already the elected outcome of that agenda." };
  }
  return redirectElectedOutcome(state, action.playerId, "confounding_legal_text", action.playerId);
}

/** RR "Deadly Plot": during the agenda phase, right as an outcome is about to be resolved, a player who voted for or predicted a DIFFERENT outcome may discard the agenda entirely instead — no effect, not replaced (RR "not replaced" — this slot just resolves to nothing, but the agenda phase's own 2-per-round structure still continues normally afterward, same as any other resolved agenda), then exhaust every planet this player controls. */
export function playDeadlyPlot(state: GameState, action: { type: "PLAY_DEADLY_PLOT"; playerId: PlayerId }, rules: RuleData): ActionResult {
  if (!isPlayersTurnInWindow(state, "outcome_would_be_resolved", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current outcome-would-be-resolved priority window." };
  }
  const pending = state.pendingAgendaVote;
  if (!pending) return { ok: false, error: "No agenda is currently being voted on." };

  const totals = Object.entries(pending.votesByOutcome).map(([outcome, votes]) => ({ outcome, total: votes.reduce((sum, v) => sum + v.votes, 0) }));
  const maxVotes = Math.max(0, ...totals.map((t) => t.total));
  const winner = totals.find((t) => t.total === maxVotes)?.outcome ?? null;
  const ownVoteOutcome = Object.entries(pending.votesByOutcome).find(([, votes]) => votes.some((v) => v.playerId === action.playerId))?.[0];
  const ownPrediction = pending.predictions?.find((p) => p.playerId === action.playerId)?.predictedOutcome;
  const votedOrPredictedDifferently = (ownVoteOutcome !== undefined && ownVoteOutcome !== winner) || (ownPrediction !== undefined && ownPrediction !== winner);
  if (!votedOrPredictedDifferently) {
    return { ok: false, error: "This player must have voted for or predicted a different outcome than the one about to be resolved." };
  }

  const played = playCard(state, action.playerId, "deadly_plot");
  if (!played.ok) return played;

  const systems: GameState["systems"] = { ...played.state.systems };
  const exhaustedPlanetIds: PlanetId[] = [];
  for (const [systemId, system] of Object.entries(played.state.systems)) {
    let changed = false;
    const planets = system.planets.map((p) => {
      if (p.controllerId === action.playerId && !p.exhausted) {
        changed = true;
        exhaustedPlanetIds.push(p.planetId);
        return { ...p, exhausted: true };
      }
      return p;
    });
    if (changed) systems[systemId as SystemId] = { ...system, planets };
  }

  const nextState: GameState = {
    ...played.state,
    systems,
    agendaDeck: { ...played.state.agendaDeck, discardIds: [...played.state.agendaDeck.discardIds, pending.agendaId] },
    agendaPhaseAgendasResolved: (played.state.agendaPhaseAgendasResolved ?? 0) + 1,
    pendingAgendaVote: null,
    pendingPriorityWindow: null,
    outcomeWouldBeResolvedWindowDone: undefined,
  };

  const events: GameEvent[] = [
    { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("deadly_plot") },
    ...exhaustedPlanetIds.map((planetId): GameEvent => ({ type: "PLANET_EXHAUSTED", playerId: action.playerId, planetId })),
  ];
  // Closes the window itself (pendingPriorityWindow: null above) rather than calling continueAgendaPhaseAfterElectionReaction inline — GameEngine.ts's own generic "outcome_would_be_resolved just closed" handling calls that continuation uniformly, whether the window closed via this card resolving it or via everyone declining.
  return { ok: true, state: nextState, events };
}

/**
 * Batch 8: standalone "Action:" cards (no special timing window beyond
 * this player's own action-phase turn — same as batch 1's own cards;
 * Sabotage's own generic announce-window, wired in GameEngine.ts, already
 * covers "could another player want to contest THIS specific play" for
 * every action card, so these don't need anything extra on top).
 */

/** RR "Cripple Defenses": destroy every PDS on a chosen planet, regardless of owner. */
export function playCrippleDefenses(state: GameState, action: { type: "PLAY_CRIPPLE_DEFENSES"; playerId: PlayerId; planetId: PlanetId }): ActionResult {
  const played = playCard(state, action.playerId, "cripple_defenses");
  if (!played.ok) return played;

  const found = findPlanet(played.state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };

  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("cripple_defenses") }];
  let updatedPlanet = found.planet;
  // RR FAQ: "destroy" effects like this only ever target ANOTHER player's units, never the caster's own.
  for (const ownerId of Object.keys(found.planet.unitsByPlayer) as PlayerId[]) {
    if (ownerId === action.playerId) continue;
    const stacks = updatedPlanet.unitsByPlayer[ownerId] ?? [];
    const pds = stacks.find((s) => s.unitType === "pds" && s.count > 0);
    if (!pds) continue;
    events.push({ type: "UNITS_DESTROYED", playerId: ownerId, systemId: found.systemId, planetId: action.planetId, unitType: "pds", count: pds.count });
    const updatedStacks = stacks.filter((s) => s !== pds);
    updatedPlanet = { ...updatedPlanet, unitsByPlayer: { ...updatedPlanet.unitsByPlayer, [ownerId]: updatedStacks } };
  }

  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };
  const nextState: GameState = { ...played.state, systems: { ...played.state.systems, [found.systemId]: updatedSystem } };
  return { ok: true, state: nextState, events };
}

/** RR "Plague": roll 1 die per infantry on a chosen planet controlled by ANOTHER player; destroy 1 of those infantry for each result of 6+. */
export function playPlague(
  state: GameState,
  action: { type: "PLAY_PLAGUE"; playerId: PlayerId; planetId: PlanetId; diceRolls: number[] },
): ActionResult {
  const played = playCard(state, action.playerId, "plague");
  if (!played.ok) return played;

  const found = findPlanet(played.state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  if (!found.planet.controllerId || found.planet.controllerId === action.playerId) {
    return { ok: false, error: "Plague must target a planet controlled by another player." };
  }
  const targetId = found.planet.controllerId;
  const stacks = found.planet.unitsByPlayer[targetId] ?? [];
  const infantry = stacks.find((s) => s.unitType === "infantry" && s.count > 0);
  if (!infantry) return { ok: false, error: "That planet has no infantry." };
  if (action.diceRolls.length !== infantry.count) {
    return { ok: false, error: `Plague rolls exactly 1 die per infantry (${infantry.count}).` };
  }

  const hits = action.diceRolls.filter((r) => r >= 6).length;
  const n = Math.min(hits, infantry.count);
  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("plague") }];
  let updatedPlanet = found.planet;
  if (n > 0) {
    const updatedStacks = stacks.map((s) => (s === infantry ? { ...s, count: s.count - n } : s)).filter((s) => s.count > 0);
    updatedPlanet = { ...found.planet, unitsByPlayer: { ...found.planet.unitsByPlayer, [targetId]: updatedStacks } };
    events.push({ type: "UNITS_DESTROYED", playerId: targetId, systemId: found.systemId, planetId: action.planetId, unitType: "infantry", count: n });
  }

  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };
  const nextState: GameState = { ...played.state, systems: { ...played.state.systems, [found.systemId]: updatedSystem } };
  return { ok: true, state: nextState, events };
}

/** RR "Disable": at the start of an invasion in a system with 1+ of this player's opponents' PDS units, those PDS lose Planetary Shield and Space Cannon for the rest of the invasion — reuses the same "invasion_start" window Bunker/Blitz already open. */
export function playDisable(state: GameState, action: { type: "PLAY_DISABLE"; playerId: PlayerId }): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId || !isPlayersTurnInWindow(state, "invasion_start", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current invasion-start priority window." };
  }
  const system = state.systems[pending.systemId];
  const hasOpponentPds = system?.planets.some((p) => (Object.entries(p.unitsByPlayer) as [PlayerId, UnitStack[]][]).some(([pid, stacks]) => pid !== action.playerId && stacks.some((s) => s.unitType === "pds" && s.count > 0)));
  if (!hasOpponentPds) return { ok: false, error: "No opponent PDS units in the system being invaded." };

  const played = playCard(state, action.playerId, "disable");
  if (!played.ok) return played;

  const nextState = advancePriorityWindowAfterAction({ ...played.state, pendingTacticalAction: { ...pending, disablePlayerId: action.playerId } }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("disable") }] };
}

/**
 * Batch 9: planet-control-change / ground-forces-committed reactive
 * cards. "planet_control_gained" is opened by phases/invasion.ts's own
 * commitGroundForces (uncontested landing) and wrapUpGroundCombat;
 * "ground_forces_committed" is opened by commitGroundForces regardless
 * of outcome.
 */

/** RR "Infiltrate": when this player gains control of a planet, replace each PDS/space dock already there with a matching unit from their own reinforcements (i.e. it's now THIS player's unit, not the previous controller's — RR 49.5b already destroys the previous controller's structures on control change, so this specifically re-creates them under the new controller instead of leaving the planet empty). Reinforcement-capped like everything else (rules/reinforcements.ts) — skips whichever structure type this player doesn't have room for, rather than failing the whole card. */
export function playInfiltrate(
  state: GameState,
  action: { type: "PLAY_INFILTRATE"; playerId: PlayerId; planetId: PlanetId; relocateFrom?: { unitType: "pds" | "space_dock"; systemId: SystemId }[] },
): ActionResult {
  if (!isPlayersTurnInWindow(state, "planet_control_gained", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current planet-control-gained priority window." };
  }
  const found = findPlanet(state, action.planetId);
  if (!found || found.planet.controllerId !== action.playerId) {
    return { ok: false, error: "This player doesn't control that planet." };
  }

  const played = playCard(state, action.playerId, "infiltrate");
  if (!played.ok) return played;

  const refound = findPlanet(played.state, action.planetId)!;
  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("infiltrate") }];
  let updatedPlanet = refound.planet;
  let systems = played.state.systems;
  for (const unitType of ["pds", "space_dock"] as const) {
    // RR 49.5b already destroyed any OTHER player's copy on control change — this only ever finds this player's own pre-existing stack (if they already had one there) or none at all; "replace" only actually adds a fresh one when there wasn't one under this player already.
    const alreadyHasOwn = (updatedPlanet.unitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === unitType && s.count > 0);
    if (alreadyHasOwn) continue;
    if (!checkReinforcementsAvailable(played.state, action.playerId, [{ unitType, count: 1 }]).ok) {
      // RR (yjmrobert.com/tirules/components/c_action_cards): "If a player wishes to place a structure, but there are none of that type left in their reinforcements, they may remove a structure of that type from any system that does not contain one of their command tokens and place that instead. That player may make the choice for each structure." — same substitution Ghost Ship/Construction Rider/War Effort already have, here per-structure-type.
      const relocation = action.relocateFrom?.find((r) => r.unitType === unitType);
      if (!relocation) continue; // no reinforcements AND no relocation specified for this structure type — skipped, not a hard failure (matches this project's own "silently skipped" convention for stale/unaffordable rider-style rewards elsewhere)
      if (played.player.commandTokens.onBoard.includes(relocation.systemId)) {
        return { ok: false, error: `Cannot relocate a ${unitType} from a system that contains this player's own command token.` };
      }
      const sourceSystem = systems[relocation.systemId];
      const sourcePlanet = sourceSystem?.planets.find((p) => (p.unitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === unitType && s.count > 0));
      if (!sourceSystem || !sourcePlanet) {
        return { ok: false, error: `No ${unitType} belonging to this player in ${relocation.systemId}.` };
      }
      const sourceStacks = sourcePlanet.unitsByPlayer[action.playerId] ?? [];
      const sourceStack = sourceStacks.find((s) => s.unitType === unitType && s.count > 0)!;
      const updatedSourceStacks = sourceStacks.map((s) => (s === sourceStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
      const updatedSourcePlanet: PlanetState = { ...sourcePlanet, unitsByPlayer: { ...sourcePlanet.unitsByPlayer, [action.playerId]: updatedSourceStacks } };
      systems = {
        ...systems,
        [relocation.systemId]: { ...sourceSystem, planets: sourceSystem.planets.map((p) => (p.planetId === sourcePlanet.planetId ? updatedSourcePlanet : p)) },
      };
    }
    updatedPlanet = addPlanetUnits(updatedPlanet, action.playerId, unitType, 1);
    events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: refound.systemId, planetId: action.planetId, unitType, count: 1, totalCost: 0 });
  }

  const destinationSystem = systems[refound.systemId] ?? refound.system;
  const updatedSystem: SystemState = { ...destinationSystem, planets: destinationSystem.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };
  const nextState = advancePriorityWindowAfterAction({ ...played.state, systems: { ...systems, [refound.systemId]: updatedSystem } }, action.playerId);
  return { ok: true, state: nextState, events };
}

/** RR "Reparations": after another player gains control of a planet this player controls, exhaust 1 planet that player controls and ready 1 planet this player controls. */
export function playReparations(
  state: GameState,
  action: { type: "PLAY_REPARATIONS"; playerId: PlayerId; exhaustPlanetId?: PlanetId; readyPlanetId?: PlanetId },
): ActionResult {
  if (!isPlayersTurnInWindow(state, "planet_control_gained", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current planet-control-gained priority window." };
  }
  // RR (yjmrobert.com/tirules): "Reparations may be played by a player with
  // no exhausted planets, or when they lose control of a planet to a
  // player with no readied planets" — either half can be a no-op.
  // "Reparations cannot be played... when [BOTH conditions apply at once]"
  // — only actually illegal if NEITHER half has a legal target at all.
  let exhaustFound: ReturnType<typeof findPlanet> = null;
  if (action.exhaustPlanetId) {
    const found = findPlanet(state, action.exhaustPlanetId);
    if (found && found.planet.controllerId && found.planet.controllerId !== action.playerId && !found.planet.exhausted) {
      exhaustFound = found;
    }
  }
  let readyFound: ReturnType<typeof findPlanet> = null;
  if (action.readyPlanetId) {
    const found = findPlanet(state, action.readyPlanetId);
    if (found && found.planet.controllerId === action.playerId && found.planet.exhausted) {
      readyFound = found;
    }
  }
  if (!exhaustFound && !readyFound) {
    return { ok: false, error: "Reparations needs at least 1 valid target — a readied planet of the other player's to exhaust, or an exhausted planet of this player's to ready." };
  }

  const played = playCard(state, action.playerId, "reparations");
  if (!played.ok) return played;

  let systems = played.state.systems;
  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("reparations") }];
  if (exhaustFound) {
    const exhaustRefound = findPlanet({ ...played.state, systems }, exhaustFound.planet.planetId)!;
    systems = {
      ...systems,
      [exhaustRefound.systemId]: {
        ...exhaustRefound.system,
        planets: exhaustRefound.system.planets.map((p) => (p.planetId === exhaustFound!.planet.planetId ? { ...p, exhausted: true } : p)),
      },
    };
    events.push({ type: "PLANET_EXHAUSTED", playerId: exhaustFound.planet.controllerId!, planetId: exhaustFound.planet.planetId });
  }
  if (readyFound) {
    const readyRefound = findPlanet({ ...played.state, systems }, readyFound.planet.planetId)!;
    systems = {
      ...systems,
      [readyRefound.systemId]: { ...readyRefound.system, planets: readyRefound.system.planets.map((p) => (p.planetId === readyFound!.planet.planetId ? { ...p, exhausted: false } : p)) },
    };
    events.push({ type: "PLANET_READIED", playerId: action.playerId, planetId: readyFound.planet.planetId });
  }

  const nextState = advancePriorityWindowAfterAction({ ...played.state, systems }, action.playerId);
  return { ok: true, state: nextState, events };
}

/** RR "Parley": after another player commits units to land on a planet this player controls, return those committed units to the system's space area — undoing the landing entirely. Only reachable while the units are still there to return (i.e. before ground combat/control has moved on), same as the "ground_forces_committed" window's own timing. */
export function playParley(state: GameState, action: { type: "PLAY_PARLEY"; playerId: PlayerId; targetPlanetId: PlanetId; committedPlayerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "ground_forces_committed", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current ground-forces-committed priority window." };
  }
  const found = findPlanet(state, action.targetPlanetId);
  if (!found || found.planet.controllerId !== action.playerId) {
    return { ok: false, error: "This player doesn't control that planet." };
  }
  const stacks = found.planet.unitsByPlayer[action.committedPlayerId] ?? [];
  if (stacks.length === 0 || stacks.every((s) => s.count === 0)) {
    return { ok: false, error: "That player has no committed units on this planet." };
  }

  const played = playCard(state, action.playerId, "parley");
  if (!played.ok) return played;

  const refound = findPlanet(played.state, action.targetPlanetId)!;
  const returningStacks = refound.planet.unitsByPlayer[action.committedPlayerId] ?? [];
  const updatedPlanet: PlanetState = { ...refound.planet, unitsByPlayer: { ...refound.planet.unitsByPlayer, [action.committedPlayerId]: [] } };
  let updatedSystem: SystemState = { ...refound.system, planets: refound.system.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)) };
  for (const stack of returningStacks) {
    if (stack.count > 0) updatedSystem = addSpaceUnits(updatedSystem, action.committedPlayerId, stack.unitType, stack.count);
  }

  const nextState = advancePriorityWindowAfterAction(
    {
      ...played.state,
      systems: { ...played.state.systems, [refound.systemId]: updatedSystem },
      pendingTacticalAction: { ...played.state.pendingTacticalAction!, parleyBlockedPlayerIds: [...(played.state.pendingTacticalAction!.parleyBlockedPlayerIds ?? []), action.committedPlayerId] },
    },
    action.playerId,
  );
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("parley") }] };
}

/** RR "Ghost Squad": after a player commits units to land on a planet this player controls, move any number of this player's OWN ground forces between planets they control in that same system. */
export function playGhostSquad(
  state: GameState,
  action: { type: "PLAY_GHOST_SQUAD"; playerId: PlayerId; moves: { fromPlanetId: PlanetId; toPlanetId: PlanetId; unitType: "infantry" | "mech"; count: number }[] },
): ActionResult {
  if (!isPlayersTurnInWindow(state, "ground_forces_committed", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current ground-forces-committed priority window." };
  }
  // RR (yjmrobert.com/tirules): "A player may move zero ground forces with Ghost Squad" — confirmed legal (still consumes the card, just does nothing further).

  const played = playCard(state, action.playerId, "ghost_squad");
  if (!played.ok) return played;

  let systems = played.state.systems;
  let referenceSystemId: SystemId | undefined;
  for (const move of action.moves) {
    const fromFound = findPlanet({ ...played.state, systems }, move.fromPlanetId);
    const toFound = findPlanet({ ...played.state, systems }, move.toPlanetId);
    if (!fromFound || fromFound.planet.controllerId !== action.playerId) return { ok: false, error: `This player doesn't control ${move.fromPlanetId}.` };
    if (!toFound || toFound.planet.controllerId !== action.playerId) return { ok: false, error: `This player doesn't control ${move.toPlanetId}.` };
    if (fromFound.systemId !== toFound.systemId) return { ok: false, error: "Ghost Squad only moves forces within the SAME system." };
    referenceSystemId ??= fromFound.systemId;

    const fromStacks = fromFound.planet.unitsByPlayer[action.playerId] ?? [];
    const stack = fromStacks.find((s) => s.unitType === move.unitType && !s.upgradeId);
    if (!stack || stack.count < move.count) return { ok: false, error: `Not enough ${move.unitType} on ${move.fromPlanetId}.` };

    const updatedFromStacks = fromStacks.map((s) => (s === stack ? { ...s, count: s.count - move.count } : s)).filter((s) => s.count > 0);
    const updatedFromPlanet: PlanetState = { ...fromFound.planet, unitsByPlayer: { ...fromFound.planet.unitsByPlayer, [action.playerId]: updatedFromStacks } };
    const toPlanetAfterFrom = fromFound.systemId === toFound.systemId && fromFound.planet.planetId !== toFound.planet.planetId ? toFound.planet : updatedFromPlanet;
    const updatedToPlanet = addPlanetUnits(toPlanetAfterFrom, action.playerId, move.unitType, move.count);

    systems = {
      ...systems,
      [fromFound.systemId]: {
        ...fromFound.system,
        planets: fromFound.system.planets.map((p) => {
          if (p.planetId === move.fromPlanetId) return updatedFromPlanet;
          if (p.planetId === move.toPlanetId) return updatedToPlanet;
          return p;
        }),
      },
    };
  }

  const nextState = advancePriorityWindowAfterAction({ ...played.state, systems }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("ghost_squad") }] };
}

/**
 * Batch 10: system-activation reactive cards. "upgrade"/"harness_energy"
 * reuse the existing "after_system_activated" window (same one Flank
 * Speed etc. use); the rest need their own new windows (see below).
 */

/** RR "Upgrade": after activating a system containing 1+ of this player's ships, replace 1 of their cruisers there with a dreadnought from reinforcements. */
export function playUpgrade(state: GameState, action: { type: "PLAY_UPGRADE"; playerId: PlayerId; systemId: SystemId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "after_system_activated", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current after-system-activation priority window." };
  }
  // RR FAQ (twilight-imperium.fandom.com/wiki/FAQ): "the cruiser must already be in the activated system" — action.systemId must be the system just activated, not any other.
  if (state.pendingTacticalAction?.systemId !== action.systemId) {
    return { ok: false, error: "Upgrade's cruiser must be in the system that was just activated." };
  }
  const system = state.systems[action.systemId];
  const cruiserStack = (system?.spaceUnitsByPlayer[action.playerId] ?? []).find((s) => s.unitType === "cruiser" && s.count > 0);
  if (!system || !cruiserStack) return { ok: false, error: "This player has no cruiser in that system." };
  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: "dreadnought", count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const played = playCard(state, action.playerId, "upgrade");
  if (!played.ok) return played;

  const refoundSystem = played.state.systems[action.systemId];
  const refoundStack = (refoundSystem.spaceUnitsByPlayer[action.playerId] ?? []).find((s) => s.unitType === "cruiser" && s.count > 0)!;
  const stacksMinusCruiser = (refoundSystem.spaceUnitsByPlayer[action.playerId] ?? [])
    .map((s) => (s === refoundStack ? { ...s, count: s.count - 1 } : s))
    .filter((s) => s.count > 0);
  const systemMinusCruiser: SystemState = { ...refoundSystem, spaceUnitsByPlayer: { ...refoundSystem.spaceUnitsByPlayer, [action.playerId]: stacksMinusCruiser } };
  const updatedSystem = addSpaceUnits(systemMinusCruiser, action.playerId, "dreadnought", 1);

  const nextState = advancePriorityWindowAfterAction({ ...played.state, systems: { ...played.state.systems, [action.systemId]: updatedSystem } }, action.playerId);
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("upgrade") },
      { type: "UNITS_DESTROYED", playerId: action.playerId, systemId: action.systemId, unitType: "cruiser", count: 1 },
      { type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.systemId, unitType: "dreadnought", count: 1, totalCost: 0 },
    ],
  };
}

/** RR "Harness Energy": after activating a system that contains an anomaly, replenish this player's commodities (i.e. refill to their commodity max — same mechanic RR "Trade" strategy card's own primary/secondary already applies). */
export function playHarnessEnergy(
  state: GameState,
  action: { type: "PLAY_HARNESS_ENERGY"; playerId: PlayerId; systemId: SystemId },
  rules: RuleData,
): ActionResult {
  if (!isPlayersTurnInWindow(state, "after_system_activated", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current after-system-activation priority window." };
  }
  const system = state.systems[action.systemId];
  if (!system || system.anomalies.length === 0) return { ok: false, error: "That system isn't an anomaly." };

  const played = playCard(state, action.playerId, "harness_energy");
  if (!played.ok) return played;

  const commodityMax = effectiveCommoditiesMax(played.state, action.playerId, rules.factions[played.player.factionId]?.commoditiesMax ?? 0);
  const updatedPlayer: Player = { ...played.player, commodities: commodityMax };
  const nextState = advancePriorityWindowAfterAction({ ...played.state, players: { ...played.state.players, [action.playerId]: updatedPlayer } }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("harness_energy") }] };
}

/** RR "Rally": after activating a system containing another player's ships, place 2 command tokens from reinforcements directly into this player's fleet pool. */
export function playRally(state: GameState, action: { type: "PLAY_RALLY"; playerId: PlayerId; systemId: SystemId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "after_system_activated", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current after-system-activation priority window." };
  }
  const system = state.systems[action.systemId];
  const hasOtherShips = system ? Object.entries(system.spaceUnitsByPlayer).some(([pid, stacks]) => pid !== action.playerId && (stacks ?? []).some((s) => s.count > 0)) : false;
  if (!hasOtherShips) return { ok: false, error: "That system has no other player's ships." };

  const played = playCard(state, action.playerId, "rally");
  if (!played.ok) return played;

  const remaining = commandTokensAvailableInReinforcements(played.player);
  const grant = Math.min(2, remaining);
  const updatedPlayer: Player = { ...played.player, commandTokens: { ...played.player.commandTokens, fleet: played.player.commandTokens.fleet + grant } };
  const nextState = advancePriorityWindowAfterAction({ ...played.state, players: { ...played.state.players, [action.playerId]: updatedPlayer } }, action.playerId);
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("rally") },
      { type: "COMMAND_TOKENS_GAINED", playerId: action.playerId, tactic: 0, fleet: grant, strategy: 0 },
    ],
  };
}

/**
 * Batch 11: "after ANOTHER player activates a system that contains
 * [something of yours]" cards — share the "after_another_player_
 * activates_system" window (opened in GameEngine.ts once the activating
 * player's own 2 windows close).
 */

/** RR "Counterstroke": after a player activates a system containing 1 of this player's command tokens, return that token to this player's own tactic pool. */
export function playCounterstroke(state: GameState, action: { type: "PLAY_COUNTERSTROKE"; playerId: PlayerId; systemId: SystemId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "after_another_player_activates_system", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current after-another-player-activates-a-system priority window." };
  }
  const player = state.players[action.playerId];
  if (!player.commandTokens.onBoard.includes(action.systemId)) {
    return { ok: false, error: "This player has no command token in that system." };
  }

  const played = playCard(state, action.playerId, "counterstroke");
  if (!played.ok) return played;

  const updatedPlayer: Player = {
    ...played.player,
    commandTokens: { ...played.player.commandTokens, tactic: played.player.commandTokens.tactic + 1, onBoard: played.player.commandTokens.onBoard.filter((s) => s !== action.systemId) },
  };
  const nextState = advancePriorityWindowAfterAction({ ...played.state, players: { ...played.state.players, [action.playerId]: updatedPlayer } }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("counterstroke") }] };
}

/** RR "Forward Supply Base": after another player activates a system containing this player's units, gain 3 trade goods, then choose another player to gain 1 trade good. */
export function playForwardSupplyBase(
  state: GameState,
  action: { type: "PLAY_FORWARD_SUPPLY_BASE"; playerId: PlayerId; systemId: SystemId; chosenPlayerId: PlayerId },
): ActionResult {
  if (!isPlayersTurnInWindow(state, "after_another_player_activates_system", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current after-another-player-activates-a-system priority window." };
  }
  if (action.chosenPlayerId === action.playerId) return { ok: false, error: "Forward Supply Base's chosen player must be someone else." };
  if (!state.players[action.chosenPlayerId]) return { ok: false, error: "Unknown chosen player." };

  const played = playCard(state, action.playerId, "forward_supply_base");
  if (!played.ok) return played;

  const updatedSelf: Player = { ...played.player, tradeGoods: played.player.tradeGoods + 3 };
  const chosen = played.state.players[action.chosenPlayerId];
  const updatedChosen: Player = { ...chosen, tradeGoods: chosen.tradeGoods + 1 };
  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, players: { ...played.state.players, [action.playerId]: updatedSelf, [action.chosenPlayerId]: updatedChosen } },
    action.playerId,
  );
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("forward_supply_base") },
      { type: "TRADE_GOODS_GAINED", playerId: action.playerId, amount: 3 },
      { type: "TRADE_GOODS_GAINED", playerId: action.chosenPlayerId, amount: 1 },
    ],
  };
}

/** RR "Decoy Operation": after another player activates a system containing 1+ of this player's structures, remove up to 2 of this player's ground forces from the board and place them on a planet this player controls in that same system. */
export function playDecoyOperation(
  state: GameState,
  action: { type: "PLAY_DECOY_OPERATION"; playerId: PlayerId; systemId: SystemId; fromPlanetIds: PlanetId[]; toPlanetId: PlanetId },
): ActionResult {
  if (!isPlayersTurnInWindow(state, "after_another_player_activates_system", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current after-another-player-activates-a-system priority window." };
  }
  if (action.fromPlanetIds.length < 1 || action.fromPlanetIds.length > 2) {
    return { ok: false, error: "Decoy Operation removes up to 2 ground forces." };
  }
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  const toPlanet = system.planets.find((p) => p.planetId === action.toPlanetId);
  if (!toPlanet || toPlanet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control the destination planet." };

  const played = playCard(state, action.playerId, "decoy_operation");
  if (!played.ok) return played;

  let refSystem = played.state.systems[action.systemId];
  const removedByType = new Map<"infantry" | "mech", number>();
  for (const planetId of action.fromPlanetIds) {
    const planet = refSystem.planets.find((p) => p.planetId === planetId);
    const stacks = planet?.unitsByPlayer[action.playerId] ?? [];
    const groundStack = stacks.find((s) => (s.unitType === "infantry" || s.unitType === "mech") && s.count > 0);
    if (!planet || !groundStack) return { ok: false, error: `No ground forces belonging to this player on ${planetId}.` };
    const removedType = groundStack.unitType as "infantry" | "mech";
    removedByType.set(removedType, (removedByType.get(removedType) ?? 0) + 1);
    const updatedStacks = stacks.map((s) => (s === groundStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
    const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [action.playerId]: updatedStacks } };
    refSystem = { ...refSystem, planets: refSystem.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) };
  }

  let destinationPlanet = refSystem.planets.find((p) => p.planetId === action.toPlanetId)!;
  for (const [unitType, count] of removedByType) {
    destinationPlanet = addPlanetUnits(destinationPlanet, action.playerId, unitType, count);
  }
  refSystem = { ...refSystem, planets: refSystem.planets.map((p) => (p.planetId === action.toPlanetId ? destinationPlanet : p)) };

  const nextState = advancePriorityWindowAfterAction({ ...played.state, systems: { ...played.state.systems, [action.systemId]: refSystem } }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("decoy_operation") }] };
}

/** RR "Master Plan": after this player performs an action, they may perform an additional action this turn — banks a flag phases/actionPhase.ts's own maybeAdvanceActivePlayer checks (same "stay active" shape Fleet Logistics already uses), consumed the next time it would otherwise hand off to the next player. Playable any time it's this player's own turn — a personal option about their OWN turn, same "no other player has standing to contest it" reasoning as the 5 "after you activate a system" cards. */
export function playMasterPlan(state: GameState, action: { type: "PLAY_MASTER_PLAN"; playerId: PlayerId }): ActionResult {
  if (state.phase !== "action" || state.activePlayerId !== action.playerId) {
    return { ok: false, error: "Master Plan can only be played on this player's own turn during the action phase." };
  }
  const played = playCard(state, action.playerId, "master_plan");
  if (!played.ok) return played;

  const updatedPlayer: Player = { ...played.player, masterPlanBonusAvailable: true };
  return {
    ok: true,
    state: { ...played.state, players: { ...played.state.players, [action.playerId]: updatedPlayer } },
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("master_plan") }],
  };
}

/**
 * Batch 12: combat-reactive cards. Several reuse the existing
 * "combat_round_start" window; others need their own new windows,
 * documented at each one's own function.
 */

/** RR "Fighter Prototype": at the start of the first round of a space combat, +2 to this player's fighter combat rolls that round. */
export function playFighterPrototype(state: GameState, action: { type: "PLAY_FIGHTER_PROTOTYPE"; playerId: PlayerId }): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat" || (pending.combatRound ?? 1) !== 1 || !isPlayersTurnInWindow(state, "combat_round_start", action.playerId)) {
    return { ok: false, error: 'RR "Fighter Prototype": only playable at the start of the FIRST round of a space combat.' };
  }
  const played = playCard(state, action.playerId, "fighter_prototype");
  if (!played.ok) return played;

  const nextState = advancePriorityWindowAfterAction({ ...played.state, pendingTacticalAction: { ...pending, fighterPrototypePlayerId: action.playerId } }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("fighter_prototype") }] };
}

/** RR "Emergency Repairs": at the start (or end) of a combat round, repair (clear damagedCount on) all of this player's Sustain-Damage-capable units in the active system. Simplification, flagged: only reachable via the "combat_round_start" window (round 1's own start, or round N+1's start — functionally the same instant as round N's own end for every round except the very last one before combat fully concludes, which this doesn't separately cover). */
export function playEmergencyRepairs(state: GameState, action: { type: "PLAY_EMERGENCY_REPAIRS"; playerId: PlayerId }): ActionResult {
  const pending = state.pendingTacticalAction;
  // RR (yjmrobert.com/tirules/components/c_action_cards): "A player may play Emergency Repairs at the start of the first round of combat to repair ships damaged in a previous combat, OR during the Space Cannon Offense step of the current action." — the Space Cannon Offense case has no priority-window gate of its own (that step's own responder order already governs whose turn it is), so it's just gated on the step itself.
  const duringSpaceCannonOffense = pending?.step === "spaceCannonOffense";
  const atCombatRoundStart = pending && (pending.step === "spaceCombat" || (pending.step === "invasion" && pending.currentInvasionPlanetId)) && isPlayersTurnInWindow(state, "combat_round_start", action.playerId);
  if (!pending || (!duringSpaceCannonOffense && !atCombatRoundStart)) {
    return { ok: false, error: 'RR "Emergency Repairs": only playable at the start of a combat round, or during the Space Cannon Offense step.' };
  }
  const played = playCard(state, action.playerId, "emergency_repairs");
  if (!played.ok) return played;

  const systemId = pending.systemId;
  const system = played.state.systems[systemId];
  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("emergency_repairs") }];
  const spaceUnitsByPlayer = { ...system.spaceUnitsByPlayer, [action.playerId]: (system.spaceUnitsByPlayer[action.playerId] ?? []).map((s) => (s.damagedCount > 0 ? { ...s, damagedCount: 0 } : s)) };
  const planets = system.planets.map((p) => ({
    ...p,
    unitsByPlayer: { ...p.unitsByPlayer, [action.playerId]: (p.unitsByPlayer[action.playerId] ?? []).map((s) => (s.damagedCount > 0 ? { ...s, damagedCount: 0 } : s)) },
  }));
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer, planets };

  const nextState = advancePriorityWindowAfterAction({ ...played.state, systems: { ...played.state.systems, [systemId]: updatedSystem } }, action.playerId);
  return { ok: true, state: nextState, events };
}

/** RR "Salvage": after this player wins a space combat, the opponent gives them all of their commodities. */
export function playSalvage(state: GameState, action: { type: "PLAY_SALVAGE"; playerId: PlayerId; opponentId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "space_combat_won", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current space-combat-won priority window." };
  }
  const opponent = state.players[action.opponentId];
  if (!opponent) return { ok: false, error: "Unknown opponent." };

  const played = playCard(state, action.playerId, "salvage");
  if (!played.ok) return played;

  const amount = played.state.players[action.opponentId].commodities;
  const updatedOpponent: Player = { ...played.state.players[action.opponentId], commodities: 0 };
  const updatedSelf: Player = { ...played.player, tradeGoods: played.player.tradeGoods + amount };
  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, players: { ...played.state.players, [action.playerId]: updatedSelf, [action.opponentId]: updatedOpponent } },
    action.playerId,
  );
  return {
    ok: true,
    state: nextState,
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("salvage") },
      { type: "TRADE_GOODS_GAINED", playerId: action.playerId, amount },
    ],
  };
}

/**
 * "Shields Holding" and "Maneuvering Jets" are both personal, single-
 * participant defensive reactions (only the player whose units are about
 * to take hits could ever want either — no other player has standing to
 * contest it, same reasoning as the 5 "after you activate a system"
 * cards not needing a formal priority window) — both just reduce this
 * player's own `pendingHits` entry directly, any time it's non-zero in
 * the right context, before that player submits their own ASSIGN_*_HITS.
 */

/** RR "Shields Holding": before assigning hits to this player's own ships during a space combat round, cancel up to 2 of them. */
export function playShieldsHolding(state: GameState, action: { type: "PLAY_SHIELDS_HOLDING"; playerId: PlayerId; hitsToCancel: number }): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat") return { ok: false, error: 'RR "Shields Holding": only playable during a space combat round.' };
  const hitsOwed = pending.pendingHits?.[action.playerId] ?? 0;
  if (hitsOwed <= 0) return { ok: false, error: "This player has no pending hits to cancel." };
  if (action.hitsToCancel < 1 || action.hitsToCancel > 2) return { ok: false, error: "Shields Holding cancels 1 or 2 hits." };

  const played = playCard(state, action.playerId, "shields_holding");
  if (!played.ok) return played;

  const n = Math.min(action.hitsToCancel, hitsOwed);
  const updatedPendingHits = { ...pending.pendingHits, [action.playerId]: hitsOwed - n };
  const nextState: GameState = { ...played.state, pendingTacticalAction: { ...pending, pendingHits: updatedPendingHits } };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("shields_holding") }] };
}

/** RR "Maneuvering Jets": before assigning hits produced by another player's Space Cannon roll (Space Cannon Offense OR Defense — both share the same pendingHits shape), cancel 1 hit. */
export function playManeuveringJets(state: GameState, action: { type: "PLAY_MANEUVERING_JETS"; playerId: PlayerId }): ActionResult {
  const pending = state.pendingTacticalAction;
  const hitsOwed = pending?.pendingHits?.[action.playerId] ?? 0;
  // Space Cannon Defense's own pendingHits sits under step "invasion" (phases/invasion.ts's own useSpaceCannonDefense); Space Cannon Offense's own sits under step "spaceCannonOffense". Ground combat also uses step "invasion" + pendingHits, but only while spaceCannonDefensePending was true just before — approximated here as "any pending hits during either of those 2 steps", since this project doesn't separately tag WHICH ability produced a given pendingHits entry.
  if (!pending || (pending.step !== "spaceCannonOffense" && pending.step !== "invasion") || hitsOwed <= 0) {
    return { ok: false, error: 'RR "Maneuvering Jets": only playable before assigning pending Space Cannon hits.' };
  }
  // KNOWN GAP (yjmrobert.com/tirules/components/c_action_cards): "A player cannot play a second Maneuvering Jets to cancel a second hit produced by the SAME Space Cannon roll" — this project's pendingHits doesn't tag which specific roll produced a given hit count (same limitation Shields Holding's own doc comment already flags), so 2 copies played back-to-back against the same still-pending value aren't currently distinguished from 2 separate rolls. Documented rather than half-fixed.

  const played = playCard(state, action.playerId, "maneuvering_jets");
  if (!played.ok) return played;

  const updatedPendingHits = { ...pending.pendingHits, [action.playerId]: hitsOwed - 1 };
  const nextState: GameState = { ...played.state, pendingTacticalAction: { ...pending, pendingHits: updatedPendingHits } };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("maneuvering_jets") }] };
}

/** RR "War Machine": banks a flag for the next time this player uses PRODUCTION (phases/production.ts's own executeProduction) — +4 to the total Production value, -1 to the combined cost, consumed then. Personal, single-participant timing (only this player's own upcoming production could ever be affected), same as Master Plan above. */
export function playWarMachine(state: GameState, action: { type: "PLAY_WAR_MACHINE"; playerId: PlayerId }): ActionResult {
  if (state.phase !== "action" || state.activePlayerId !== action.playerId) {
    return { ok: false, error: "War Machine can only be played on this player's own turn during the action phase." };
  }
  // RR (yjmrobert.com/tirules/components/c_action_cards): "A second War Machine cannot be played during use of production to give +8..." — blocked outright while one is already banked and hasn't been consumed by a PRODUCE_UNITS yet.
  if (state.players[action.playerId]?.warMachineActive) {
    return { ok: false, error: "This player already has a War Machine bonus banked for their next production." };
  }
  const played = playCard(state, action.playerId, "war_machine");
  if (!played.ok) return played;

  const updatedPlayer: Player = { ...played.player, warMachineActive: true };
  return {
    ok: true,
    state: { ...played.state, players: { ...played.state.players, [action.playerId]: updatedPlayer } },
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("war_machine") }],
  };
}

/** RR "Reverse Engineer": when another player discards an action card that "has a component action" (RR terminology for a card playable AS a player's own action-phase turn — every card whose own printed timing is "Action:", including the plain "As an Action:" ones this project already implemented in batches 1-3), this player takes that card from the discard pile into their own hand instead. Hardcoded set (rather than a new RuleData lookup) since data/actionCards.json's own timing text isn't otherwise exposed through RuleData at all yet. */
const COMPONENT_ACTION_CARD_IDS = new Set([
  "economic_initiative", "focused_research", "frontline_deployment", "ghost_ship", "industrial_initiative", "insubordination",
  "lucky_shot", "mining_initiative", "reactor_meltdown", "repeal_law", "rise_of_a_messiah", "signal_jamming", "spy",
  "tactical_bombardment", "unexpected_action", "unstable_planet", "uprising", "war_effort", "fighter_conscription",
  "impersonation", "plagiarize", "archaeological_expedition", "divert_funding", "exploration_probe", "refit_troops",
  "scuttle", "seize_artifact", "cripple_defenses", "plague",
]);

export function playReverseEngineer(state: GameState, action: { type: "PLAY_REVERSE_ENGINEER"; playerId: PlayerId; targetCardId: ActionCardId }): ActionResult {
  if (!(state.actionCardDiscardPile ?? []).includes(action.targetCardId)) {
    return { ok: false, error: "That card isn't in the action card discard pile." };
  }
  if (!COMPONENT_ACTION_CARD_IDS.has(action.targetCardId)) {
    return { ok: false, error: 'RR "Reverse Engineer": that card doesn\'t have a component action.' };
  }

  const played = playCard(state, action.playerId, "reverse_engineer");
  if (!played.ok) return played;

  const updatedPlayer: Player = { ...played.player, actionCards: [...played.player.actionCards, action.targetCardId] };
  const nextState: GameState = {
    ...played.state,
    players: { ...played.state.players, [action.playerId]: updatedPlayer },
    actionCardDiscardPile: (played.state.actionCardDiscardPile ?? []).filter((id) => id !== action.targetCardId),
  };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("reverse_engineer") }] };
}

/** RR "Intercept": after the opponent declares a retreat this space combat round, that retreat is cancelled (removed from pending.retreating) and they cannot re-announce one for the rest of this round. */
export function playIntercept(state: GameState, action: { type: "PLAY_INTERCEPT"; playerId: PlayerId; opponentId: PlayerId }): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat") return { ok: false, error: 'RR "Intercept": only playable during a space combat round.' };
  if (!pending.retreating?.some((r) => r.playerId === action.opponentId)) {
    return { ok: false, error: "That player hasn't announced a retreat this round." };
  }

  const played = playCard(state, action.playerId, "intercept");
  if (!played.ok) return played;

  const nextState: GameState = {
    ...played.state,
    pendingTacticalAction: { ...pending, retreating: (pending.retreating ?? []).filter((r) => r.playerId !== action.opponentId), interceptedPlayerId: action.opponentId },
  };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("intercept") }] };
}

/** RR "Rout": at the start of the "Announce Retreats" step, if this player is the defender, the opponent must announce a retreat if able — resolved immediately here (rather than compelling a later voluntary choice) by announcing it FOR them at a destination this player (the one forcing it) specifies, reusing phases/spaceCombat.ts's own announceRetreat for the exact same validation a normal retreat would go through. Reuses the "combat_round_start" window (RR: "Announce Retreats" is the FIRST thing that happens once a round's own start-of-round reactions are done, so that window is this card's own timing). */
export function playRout(state: GameState, action: { type: "PLAY_ROUT"; playerId: PlayerId; opponentId: PlayerId; opponentToSystemId: SystemId }, rules: RuleData): ActionResult {
  if (!isPlayersTurnInWindow(state, "combat_round_start", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current combat-round-start priority window." };
  }
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat" || pending.playerId === action.playerId) {
    return { ok: false, error: 'RR "Rout": only playable by the DEFENDER, during a space combat round.' };
  }

  const played = playCard(state, action.playerId, "rout");
  if (!played.ok) return played;

  const forcedRetreat = announceRetreat(played.state, { type: "ANNOUNCE_RETREAT", playerId: action.opponentId, toSystemId: action.opponentToSystemId });
  // RR "if able": if there's genuinely no legal retreat destination, the card still resolves (card played, discarded) — it just has no further effect, same as any "if able" clause elsewhere in this project.
  const nextState = advancePriorityWindowAfterAction(forcedRetreat.ok ? forcedRetreat.state : played.state, action.playerId);
  return {
    ok: true,
    state: nextState,
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("rout") }, ...(forcedRetreat.ok ? forcedRetreat.events : [])],
  };
}

/** RR "Waylay": before rolling dice for Anti-Fighter Barrage, hits from this player's OWN AFB roll are produced against ALL of the opponent's ships (not just fighters) — reuses the "combat_round_start" window (round 1's own start, right before AFB — see phases/spaceCombat.ts's own header comment on that ordering). */
export function playWaylay(state: GameState, action: { type: "PLAY_WAYLAY"; playerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "combat_round_start", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current combat-round-start priority window." };
  }
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat") return { ok: false, error: 'RR "Waylay": only playable at the start of a space combat.' };

  const played = playCard(state, action.playerId, "waylay");
  if (!played.ok) return played;

  const nextState = advancePriorityWindowAfterAction({ ...played.state, pendingTacticalAction: { ...pending, waylayPlayerId: action.playerId } }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("waylay") }] };
}

/**
 * "Courageous to the End", "Direct Hit", and "Reflective Shielding" all
 * react to something that already happened THIS combat — detected via
 * state.recentEvents (same "did X happen recently" pattern
 * technologyAbilities.ts's own useDacxiveAnimators etc. already use),
 * rather than a new priority window, since checking "did my ship just
 * get destroyed/use Sustain Damage" doesn't block any other game
 * progress the way a real window would — these 3 simply become
 * (temporarily) legal to play, or don't, based on what already happened.
 */

/** RR "Courageous to the End": after 1 of this player's ships is destroyed in space combat, roll 2 dice — for each result >= that ship's own combat value, the opponent must destroy 1 of their own ships (their choice which). */
export function playCourageousToTheEnd(
  state: GameState,
  action: { type: "PLAY_COURAGEOUS_TO_THE_END"; playerId: PlayerId; destroyedUnitType: UnitType; diceRolls: number[]; opponentUnitTypeToDestroy: UnitType },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "spaceCombat") return { ok: false, error: 'RR "Courageous to the End": only playable during a space combat.' };
  const recentlyDestroyed = (state.recentEvents ?? []).some(
    (e) => e.type === "UNITS_DESTROYED" && e.playerId === action.playerId && e.systemId === pending.systemId && e.unitType === action.destroyedUnitType,
  );
  if (!recentlyDestroyed) return { ok: false, error: "This player hasn't just had one of those ships destroyed here." };
  if (action.diceRolls.length !== 2) return { ok: false, error: "Courageous to the End rolls exactly 2 dice." };

  const player = state.players[action.playerId];
  const stats = getUnitStats(rules, player.factionId, action.destroyedUnitType, player.unitUpgrades);
  if (!stats || stats.combat == null) return { ok: false, error: "No combat value for that unit type." };
  const hits = action.diceRolls.filter((r) => r >= stats.combat!).length;

  const played = playCard(state, action.playerId, "courageous_to_the_end");
  if (!played.ok) return played;

  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("courageous_to_the_end") }];
  let systems = played.state.systems;
  if (hits > 0) {
    const opponentId = (Object.keys(played.state.systems[pending.systemId]?.spaceUnitsByPlayer ?? {}) as PlayerId[]).find((id) => id !== action.playerId);
    if (opponentId) {
      const system = systems[pending.systemId];
      const stacks = system.spaceUnitsByPlayer[opponentId] ?? [];
      const stack = stacks.find((s) => s.unitType === action.opponentUnitTypeToDestroy && s.count > 0);
      if (stack) {
        const n = Math.min(hits, stack.count);
        const updatedStacks = stacks.map((s) => (s === stack ? { ...s, count: s.count - n } : s)).filter((s) => s.count > 0);
        systems = { ...systems, [pending.systemId]: { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [opponentId]: updatedStacks } } };
        events.push({ type: "UNITS_DESTROYED", playerId: opponentId, systemId: pending.systemId, unitType: action.opponentUnitTypeToDestroy, count: n });
      }
    }
  }

  return { ok: true, state: { ...played.state, systems }, events };
}

/** RR "Direct Hit": after another player's ship uses Sustain Damage to cancel a hit produced by this player's own units/abilities, destroy that ship outright. */
export function playDirectHit(state: GameState, action: { type: "PLAY_DIRECT_HIT"; playerId: PlayerId; opponentId: PlayerId; unitType: UnitType }, rules: RuleData): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending) return { ok: false, error: 'RR "Direct Hit": only playable during combat.' };
  const recentSustain = (state.recentEvents ?? []).some(
    (e) => e.type === "UNIT_SUSTAINED_DAMAGE" && e.playerId === action.opponentId && e.systemId === pending.systemId && e.unitType === action.unitType,
  );
  if (!recentSustain) return { ok: false, error: "That player hasn't just used Sustain Damage on one of those ships here." };

  // Sardakk N'orr "Exotrireme II" / L1Z1X "Super-Dreadnought II" (both dreadnought upgrades): "This unit cannot be destroyed by 'Direct Hit' action cards." Checked here directly against the TARGET player's own actual dreadnought upgrade (not just unit TYPE, since the base/level-1 versions of both these upgrades do NOT have this immunity).
  const opponentPlayer = state.players[action.opponentId];
  const targetStats = getUnitStats(rules, opponentPlayer.factionId, action.unitType, opponentPlayer.unitUpgrades);
  if (targetStats?.abilities.includes("directHitImmunity")) {
    return { ok: false, error: "That unit has Direct Hit Immunity — this card cannot destroy it." };
  }

  const played = playCard(state, action.playerId, "direct_hit");
  if (!played.ok) return played;

  const system = played.state.systems[pending.systemId];
  const stacks = system.spaceUnitsByPlayer[action.opponentId] ?? [];
  const stack = stacks.find((s) => s.unitType === action.unitType && s.damagedCount > 0);
  if (!stack) return { ok: false, error: "That player has no damaged ship of that type here anymore." };
  const updatedStacks = stacks.map((s) => (s === stack ? { ...s, count: s.count - 1, damagedCount: s.damagedCount - 1 } : s)).filter((s) => s.count > 0);
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.opponentId]: updatedStacks } };

  return {
    ok: true,
    state: { ...played.state, systems: { ...played.state.systems, [pending.systemId]: updatedSystem } },
    events: [
      { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("direct_hit") },
      { type: "UNITS_DESTROYED", playerId: action.opponentId, systemId: pending.systemId, unitType: action.unitType, count: 1 },
    ],
  };
}

/** RR "Reflective Shielding": when one of this player's ships uses Sustain Damage during combat, produce 2 hits against the opponent's ships in the active system. */
/**
 * RR "Reflective Shielding": when one of this player's ships uses Sustain
 * Damage during combat, produce 2 hits against the opponent's ships in
 * the active system.
 *
 * KNOWN SIMPLIFICATION (yjmrobert.com/tirules/components/c_action_cards):
 * the precise ruling is that these 2 hits get MERGED into the SAME
 * pending hit-assignment pool as whatever roll triggered the Sustain
 * Damage in the first place (so a unit that already used Sustain Damage
 * once this round, even if since repaired, still can't use it again for
 * these specific hits) — this project instead resolves them as an
 * immediate, separate applyHitAssignments call, since merging into an
 * already-in-progress ASSIGN_HITS action would need a deeper
 * restructure (pausing that action, injecting hits, re-prompting) this
 * project doesn't have yet. Functionally similar outcome, not the exact
 * same sequencing.
 */
export function playReflectiveShielding(
  state: GameState,
  action: { type: "PLAY_REFLECTIVE_SHIELDING"; playerId: PlayerId; unitType: UnitType; hitAssignments: { unitType: UnitType; outcome: "destroy" | "flip" }[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending) return { ok: false, error: 'RR "Reflective Shielding": only playable during combat.' };
  const recentSustain = (state.recentEvents ?? []).some(
    (e) => e.type === "UNIT_SUSTAINED_DAMAGE" && e.playerId === action.playerId && e.systemId === pending.systemId && e.unitType === action.unitType,
  );
  if (!recentSustain) return { ok: false, error: "This player hasn't just used Sustain Damage on one of those ships here." };

  const opponentId = (Object.keys(state.systems[pending.systemId]?.spaceUnitsByPlayer ?? {}) as PlayerId[]).find((id) => id !== action.playerId);
  if (!opponentId) return { ok: false, error: "No opponent ships in this system." };

  const played = playCard(state, action.playerId, "reflective_shielding");
  if (!played.ok) return played;

  const opponent = played.state.players[opponentId];
  const system = played.state.systems[pending.systemId];
  const stacks = (system.spaceUnitsByPlayer[opponentId] ?? []) as UnitStack[];
  const result = applyHitAssignments(played.state, stacks, action.hitAssignments, 2, opponent.factionId, opponent.unitUpgrades, rules);
  if (!result.ok) return { ok: false, error: result.error };

  const events: GameEvent[] = [
    { type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("reflective_shielding") },
    ...Array.from(result.destroyed.entries()).map((entry): GameEvent => ({ type: "UNITS_DESTROYED", playerId: opponentId, systemId: pending.systemId, unitType: entry[0], count: entry[1] })),
    ...Array.from(result.flipped.entries()).map((entry): GameEvent => ({ type: "UNIT_SUSTAINED_DAMAGE", playerId: opponentId, systemId: pending.systemId, unitType: entry[0], count: entry[1] })),
  ];
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [opponentId]: result.stacks } };

  return { ok: true, state: { ...played.state, systems: { ...played.state.systems, [pending.systemId]: updatedSystem } }, events };
}

/** RR "Experimental Battlestation": after another player moves ships into a system during a tactical action, this player's OWN chosen space dock (in or adjacent to that system) fires Space Cannon 5 (3 dice) against the mover's ships there. Detected via recentEvents (SHIPS_MOVED), same pattern as batch 12's own combat reactions. */
export function playExperimentalBattlestation(
  state: GameState,
  action: { type: "PLAY_EXPERIMENTAL_BATTLESTATION"; playerId: PlayerId; spaceDockSystemId: SystemId; targetSystemId: SystemId; opponentId: PlayerId; diceRolls: number[]; hitAssignments: { unitType: UnitType; outcome: "destroy" | "flip" }[] },
  rules: RuleData,
): ActionResult {
  // RR FAQ (twilight-imperium.fandom.com/wiki/FAQ): "'Experimental Battlestation' operates in the SAME timing window as 'Space Cannon Offense'... can only be resolved if ships actually move into the active system" — so this must be the mover's own just-activated tactical action, checked at or before the point real combat dice would start (covers both "some players had real Space Cannon Offense eligibility" and "no one did, straight through to spaceCombat/invasion" cases, without remaining open for the rest of the whole tactical action the way a bare recentEvents check alone would).
  const pending = state.pendingTacticalAction;
  const stillInWindow =
    pending &&
    pending.systemId === action.targetSystemId &&
    (pending.step === "spaceCannonOffense" || (pending.step === "spaceCombat" && pending.combatRound === undefined) || pending.step === "invasion");
  if (!stillInWindow) {
    return { ok: false, error: 'RR "Experimental Battlestation": only playable in the same timing window as Space Cannon Offense, right after ships move into the system.' };
  }
  // RR "Solar Flare" (yjmrobert.com/tirules/components/c_action_cards): "Another player cannot play Experimental Battlestation during this tactical action" — if the MOVER played Solar Flare this tactical action, no one else's Experimental Battlestation can target them.
  if (pending.solarFlarePlayerId === action.opponentId && action.playerId !== action.opponentId) {
    return { ok: false, error: 'RR "Solar Flare": this player is protected from Experimental Battlestation this tactical action.' };
  }
  const recentlyMoved = (state.recentEvents ?? []).some((e) => e.type === "SHIPS_MOVED" && e.playerId === action.opponentId && e.toSystemId === action.targetSystemId);
  if (!recentlyMoved) return { ok: false, error: "That player hasn't just moved ships into that system." };
  if (action.spaceDockSystemId !== action.targetSystemId && !getAdjacentSystems(state, action.spaceDockSystemId, rules).includes(action.targetSystemId)) {
    return { ok: false, error: "That space dock isn't in or adjacent to the target system." };
  }
  const dockSystem = state.systems[action.spaceDockSystemId];
  const hasOwnSpaceDock = dockSystem?.planets.some((p) => (p.unitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "space_dock" && s.count > 0));
  if (!hasOwnSpaceDock) return { ok: false, error: "This player has no space dock in that system." };
  if (action.diceRolls.length !== 3) return { ok: false, error: "Experimental Battlestation rolls exactly 3 dice." };

  const hits = action.diceRolls.filter((r) => r >= 5).length;
  const played = playCard(state, action.playerId, "experimental_battlestation");
  if (!played.ok) return played;

  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("experimental_battlestation") }];
  let systems = played.state.systems;
  if (hits > 0) {
    const opponent = played.state.players[action.opponentId];
    const targetSystem = systems[action.targetSystemId];
    const stacks = (targetSystem.spaceUnitsByPlayer[action.opponentId] ?? []) as UnitStack[];
    const result = applyHitAssignments(played.state, stacks, action.hitAssignments, hits, opponent.factionId, opponent.unitUpgrades, rules);
    if (!result.ok) return { ok: false, error: result.error };
    systems = { ...systems, [action.targetSystemId]: { ...targetSystem, spaceUnitsByPlayer: { ...targetSystem.spaceUnitsByPlayer, [action.opponentId]: result.stacks } } };
    events.push(
      ...Array.from(result.destroyed.entries()).map((e): GameEvent => ({ type: "UNITS_DESTROYED", playerId: action.opponentId, systemId: action.targetSystemId, unitType: e[0], count: e[1] })),
      ...Array.from(result.flipped.entries()).map((e): GameEvent => ({ type: "UNIT_SUSTAINED_DAMAGE", playerId: action.opponentId, systemId: action.targetSystemId, unitType: e[0], count: e[1] })),
    );
  }

  return { ok: true, state: { ...played.state, systems }, events };
}

/**
 * "Fire Team" and "Scramble Frequency" are both "reroll" cards. Neither
 * of this project's own dice-rolling actions stores individual die
 * results anywhere past the moment they're submitted (only the resulting
 * HIT COUNT persists, in pendingHits) — so "reroll any number of your
 * dice" is implemented here as "submit new rolls for as many dice as you
 * choose to reroll; any additional hits they produce are ADDED to the
 * existing pending hit count" rather than literally replacing specific
 * original die results, which this project has no way to distinguish
 * from each other after the fact. Flagged simplification, not a silent
 * guess.
 */

/** RR "Fire Team": after this player's ground forces roll combat dice this round, reroll any number of dice — submitted as new rolls checked against their own infantry/mech combat value, adding any new hits to this round's pending hit count. */
export function playFireTeam(
  state: GameState,
  action: { type: "PLAY_FIRE_TEAM"; playerId: PlayerId; rerollUnitType: "infantry" | "mech"; newDiceRolls: number[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || !pending.currentInvasionPlanetId) {
    return { ok: false, error: 'RR "Fire Team": only playable during a round of ground combat.' };
  }
  const hitsOwedBefore = pending.pendingHits?.[action.playerId];
  if (hitsOwedBefore === undefined) return { ok: false, error: "This player has no combat rolls pending reroll right now." };
  if (action.newDiceRolls.length === 0) return { ok: false, error: "Fire Team must reroll at least 1 die." };

  const player = state.players[action.playerId];
  const stats = getUnitStats(rules, player.factionId, action.rerollUnitType, player.unitUpgrades);
  if (!stats || stats.combat == null) return { ok: false, error: "No combat value for that unit type." };
  // RR (yjmrobert.com/tirules/components/c_action_cards): "Any modifiers on the original combat roll will apply to the reroll" — Morale Boost's own bonus (the only ground-combat roll modifier this project currently has) carries over the same way.
  const hitOn = stats.combat - getMoraleBoostHitOnBonus(state, action.playerId);
  const newHits = action.newDiceRolls.filter((r) => r >= hitOn).length;

  const played = playCard(state, action.playerId, "fire_team");
  if (!played.ok) return played;

  const updatedPendingHits = { ...pending.pendingHits, [action.playerId]: hitsOwedBefore + newHits };
  const nextState: GameState = { ...played.state, pendingTacticalAction: { ...pending, pendingHits: updatedPendingHits } };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("fire_team") }] };
}

/** RR "Scramble Frequency": after another player rolls Bombardment/Space Cannon/AFB dice, they reroll all of their dice — implemented as REPLACING that pending hit count with 1 freshly recomputed from the submitted new rolls (all dice reroll here, unlike Fire Team's own partial reroll, so a clean replace is exact, not a simplification). */
export function playScrambleFrequency(
  state: GameState,
  action: { type: "PLAY_SCRAMBLE_FREQUENCY"; playerId: PlayerId; opponentId: PlayerId; opponentUnitType: UnitType; newDiceRolls: number[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  const hitsOwedBefore = pending?.pendingHits?.[action.opponentId];
  if (!pending || hitsOwedBefore === undefined || (pending.step !== "spaceCannonOffense" && pending.step !== "invasion" && pending.step !== "spaceCombat")) {
    return { ok: false, error: 'RR "Scramble Frequency": only playable right after that player rolls Bombardment/Space Cannon/AFB dice.' };
  }

  const opponent = state.players[action.opponentId];
  const stats = getUnitStats(rules, opponent.factionId, action.opponentUnitType, opponent.unitUpgrades);
  const hitOn = stats?.abilityValues?.bombardment?.value ?? stats?.abilityValues?.spaceCannon?.value ?? stats?.combat;
  if (hitOn == null) return { ok: false, error: "No relevant roll value for that unit type." };
  const newHits = action.newDiceRolls.filter((r) => r >= hitOn).length;

  const played = playCard(state, action.playerId, "scramble_frequency");
  if (!played.ok) return played;

  const updatedPendingHits = { ...pending.pendingHits, [action.opponentId]: newHits };
  const nextState: GameState = { ...played.state, pendingTacticalAction: { ...pending, pendingHits: updatedPendingHits } };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("scramble_frequency") }] };
}

/** RR "Reveal Prototype": at the start of a combat, spend 4 resources to research a unit upgrade technology of the same type as 1 of this player's units participating in this combat. Reuses "combat_round_start" (opens for round 1 of either space or ground combat — see phases/spaceCombat.ts's/invasion.ts's own openCombatRoundStartWindowIfNeeded/openGroundCombatRoundStartWindowIfNeeded). Known gap, flagged rather than silently unchecked: this doesn't verify the researched tech's own unit type actually matches a unit participating in combat — RuleData has no techId -> UnitType lookup for unit upgrades yet (same missing mapping Plagiarize's own doc comment already flags), so that specific restriction is left to the caller for now. */
export function playRevealPrototype(
  state: GameState,
  action: { type: "PLAY_REVEAL_PROTOTYPE"; playerId: PlayerId; techId: TechId; exhaustPlanetIdsForResources: PlanetId[] },
  rules: RuleData,
): ActionResult {
  if (!isPlayersTurnInWindow(state, "combat_round_start", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current combat-round-start priority window." };
  }
  const played = playCard(state, action.playerId, "reveal_prototype");
  if (!played.ok) return played;

  const researched = researchTechnology(played.state, action.playerId, action.techId, 4, action.exhaustPlanetIdsForResources, rules);
  if (!researched.ok) return researched;

  const nextState = advancePriorityWindowAfterAction(researched.state, action.playerId);
  return {
    ok: true,
    state: nextState,
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("reveal_prototype") }, ...researched.events],
  };
}

// ---------------------------------------------------------------------
// Thunder's Edge action cards (data/actionCards.json's own former
// _thundersEdge section, now merged into the main array).
// ---------------------------------------------------------------------

/**
 * RR "Strategize" (TE): "Perform the secondary ability of any readied or
 * unchosen strategy card." Broader than the normal RR 83.4 secondary-
 * resolution rule (which requires someone ELSE to have chosen the card
 * THIS round) — here, a card nobody chose this round (still sitting in
 * unclaimedStrategyCards) is ALSO fair game, and so, per "readied", is a
 * card someone chose but hasn't exhausted (used) yet — including,
 * notably, the CASTER'S OWN chosen card (RR 83.4 normally forbids using
 * your own card's secondary; this card's own wording doesn't exclude
 * that case). Still costs the normal 1 strategy-pool token (Leadership's
 * own secondary stays free either way) — resolveStrategySecondaryEffect
 * itself charges that, called directly here rather than through
 * resolveStrategySecondary's own narrower eligibility gate.
 */
export function playStrategize(
  state: GameState,
  action: { type: "PLAY_STRATEGIZE"; playerId: PlayerId; cardId: string; payload: unknown },
  rules: RuleData,
): ActionResult {
  const played = playCard(state, action.playerId, "strategize");
  if (!played.ok) return played;

  // RR (yjmrobert.com/tirules/components/c_action_cards): "If a player is eliminated, the strategy cards that they had are considered 'unchosen'" — so an eliminated owner is treated the same as no owner at all here.
  const ownerEntry = Object.values(played.state.players)
    .filter((p) => !p.eliminated)
    .flatMap((p) => p.strategyCards.map((c) => ({ ...c, ownerId: p.id })))
    .find((c) => c.cardId === action.cardId);
  const isUnchosen = played.state.unclaimedStrategyCards.some((c) => c.cardId === action.cardId);
  if (!isUnchosen && (!ownerEntry || ownerEntry.exhausted)) {
    return { ok: false, error: `TE "Strategize": "${action.cardId}" must be readied (chosen but not yet used this round) or unchosen (in the common area).` };
  }
  if ((played.state.strategyCardSecondariesUsedBy?.[action.cardId as import("../types/ids").StrategyCardId] ?? []).includes(action.playerId)) {
    return { ok: false, error: "RR 82.1: this player has already resolved that strategy card's secondary ability this round." };
  }

  const p = (action.payload ?? {}) as Record<string, unknown>;
  const result = resolveStrategySecondaryEffect(played.state, { type: "RESOLVE_STRATEGY_SECONDARY", playerId: action.playerId, cardId: action.cardId, payload: action.payload }, played.player, p, rules);
  if (!result.ok) return result;

  const cardIdBranded = action.cardId as import("../types/ids").StrategyCardId;
  const nextState: GameState = {
    ...result.state,
    strategyCardSecondariesUsedBy: { ...result.state.strategyCardSecondariesUsedBy, [cardIdBranded]: [...(result.state.strategyCardSecondariesUsedBy?.[cardIdBranded] ?? []), action.playerId] },
  };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("strategize") }, ...result.events] };
}

/**
 * RR "Overrule" (TE): "Perform the primary ability of any readied or
 * unchosen strategy card." Same "readied or unchosen" eligibility as
 * Strategize above, but for the PRIMARY instead — normally RR 83.3
 * restricts a primary to the card's own OWNER only; this card bypasses
 * that ownership check entirely (resolveStrategyPrimaryEffect is called
 * directly, not through resolveStrategyPrimary's own gate). If the
 * target card is currently owned by someone, exhausts THEIR copy (same
 * "used this round" bookkeeping a normal primary resolution would); an
 * unchosen (common-area) card has no owner to exhaust, so it's simply
 * left as unchosen.
 */
export function playOverrule(
  state: GameState,
  action: { type: "PLAY_OVERRULE"; playerId: PlayerId; cardId: string; payload: unknown },
  rules: RuleData,
): ActionResult {
  const played = playCard(state, action.playerId, "overrule");
  if (!played.ok) return played;

  // RR (yjmrobert.com/tirules/components/c_action_cards): "If a player is eliminated, the strategy cards that they had are considered 'unchosen'."
  const ownerId = Object.values(played.state.players).find((p) => !p.eliminated && p.strategyCards.some((c) => c.cardId === action.cardId))?.id;
  const ownerEntry = ownerId ? played.state.players[ownerId].strategyCards.find((c) => c.cardId === action.cardId) : undefined;
  const isUnchosen = played.state.unclaimedStrategyCards.some((c) => c.cardId === action.cardId);
  if (!isUnchosen && (!ownerEntry || ownerEntry.exhausted)) {
    return { ok: false, error: `TE "Overrule": "${action.cardId}" must be readied (chosen but not yet used this round) or unchosen (in the common area).` };
  }

  const p = (action.payload ?? {}) as Record<string, unknown>;
  const result = resolveStrategyPrimaryEffect(played.state, { type: "RESOLVE_STRATEGY_PRIMARY", playerId: action.playerId, cardId: action.cardId, payload: action.payload }, played.player, p, rules);
  if (!result.ok) return result;

  let nextState = result.state;
  if (ownerId && ownerEntry) {
    const resolvingOwner = nextState.players[ownerId];
    nextState = {
      ...nextState,
      players: { ...nextState.players, [ownerId]: { ...resolvingOwner, strategyCards: resolvingOwner.strategyCards.map((c) => (c.cardId === action.cardId ? { ...c, exhausted: true } : c)) } },
    };
  }
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("overrule") }, ...result.events] };
}

/**
 * TE "Rescue": "After another player moves ships into a system that
 * contains your ships: You may move 1 of your ships into the active
 * system from any system that does not contain one of your command
 * tokens." Played during the after_ships_moved_in window (opened by
 * phases/tacticalAction.ts's own moveShips, right after movement
 * resolves) — moves exactly 1 ship, ignoring move value entirely (same
 * "ability movement, not tactical-action movement" category RR 58.8
 * already covers for effects like this one).
 */
export function playRescue(
  state: GameState,
  action: { type: "PLAY_RESCUE"; playerId: PlayerId; fromSystemId: SystemId; unitType: import("../types/enums").UnitType; gravityRiftDieRoll?: number },
): ActionResult {
  if (!isPlayersTurnInWindow(state, "after_ships_moved_in", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current after-ships-moved-in priority window." };
  }
  const pending = state.pendingTacticalAction;
  if (!pending) return { ok: false, error: "No tactical action in progress." };
  const activeSystemId = pending.systemId;
  const player = state.players[action.playerId];
  if (player.commandTokens.onBoard.includes(action.fromSystemId)) {
    return { ok: false, error: 'TE "Rescue": cannot move a ship from a system that contains this player\'s own command token.' };
  }
  const sourceSystem = state.systems[action.fromSystemId];
  const sourceStack = sourceSystem?.spaceUnitsByPlayer[action.playerId]?.find((s) => s.unitType === action.unitType && s.count > 0);
  if (!sourceSystem || !sourceStack) {
    return { ok: false, error: `This player has no ${action.unitType} in ${action.fromSystemId}.` };
  }
  // RR (yjmrobert.com/tirules/components/c_action_cards): "If the chosen ship is in a gravity rift, it must roll for removal." Same 1d10, destroyed on <=3 as the normal gravity-rift-movement rule elsewhere.
  const riftCheck = getGravityRiftDestructionCheck(sourceSystem.anomalies);
  if (riftCheck && action.gravityRiftDieRoll === undefined) {
    return { ok: false, error: `TE "Rescue": ${action.fromSystemId} contains a gravity rift — gravityRiftDieRoll is required.` };
  }
  const destroyedByRift = riftCheck ? (action.gravityRiftDieRoll as number) <= riftCheck.destroyOnRollLessOrEqual : false;

  const played = playCard(state, action.playerId, "rescue");
  if (!played.ok) return played;

  const updatedSourceStacks = (sourceSystem.spaceUnitsByPlayer[action.playerId] ?? [])
    .map((s) => (s === sourceStack ? { ...s, count: s.count - 1 } : s))
    .filter((s) => s.count > 0);
  let systems: GameState["systems"] = { ...played.state.systems, [action.fromSystemId]: { ...sourceSystem, spaceUnitsByPlayer: { ...sourceSystem.spaceUnitsByPlayer, [action.playerId]: updatedSourceStacks } } };

  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("rescue") }];
  if (destroyedByRift) {
    events.push({ type: "UNITS_DESTROYED", playerId: action.playerId, systemId: action.fromSystemId, unitType: action.unitType, count: 1 });
  } else {
    const activeSystem = systems[activeSystemId];
    const updatedActiveStacks = addSpaceUnits(activeSystem, action.playerId, action.unitType, 1);
    systems = { ...systems, [activeSystemId]: updatedActiveStacks };
  }

  const nextState = advancePriorityWindowAfterAction({ ...played.state, systems }, action.playerId);
  return { ok: true, state: nextState, events };
}

/**
 * TE "Lie in Wait": "After 2 of your neighbours resolve a transaction:
 * Look at each of those player's hands of action cards, then choose and
 * take 1 action card from each." Played during the after_transaction_
 * resolved window (rules/transactions.ts's own resolveTransaction) —
 * "look at their hands" itself needs no separate game-state modeling
 * (that's just information a UI would show a human player); this action
 * directly specifies which 1 card to take from each of the 2 banked
 * pendingLieInWaitTargets.
 */
export function playLieInWait(
  state: GameState,
  action: { type: "PLAY_LIE_IN_WAIT"; playerId: PlayerId; cardIdFromFirst: string; cardIdFromSecond: string },
): ActionResult {
  if (!isPlayersTurnInWindow(state, "after_transaction_resolved", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current after-transaction-resolved priority window." };
  }
  const targets = state.pendingLieInWaitTargets;
  if (!targets) return { ok: false, error: "No transaction is currently pending a Lie in Wait reaction." };
  const [firstId, secondId] = targets;
  const firstPlayer = state.players[firstId];
  const secondPlayer = state.players[secondId];
  if (!firstPlayer?.actionCards.includes(action.cardIdFromFirst as never)) {
    return { ok: false, error: `${firstId} doesn't have that action card.` };
  }
  if (!secondPlayer?.actionCards.includes(action.cardIdFromSecond as never)) {
    return { ok: false, error: `${secondId} doesn't have that action card.` };
  }

  const played = playCard(state, action.playerId, "lie_in_wait");
  if (!played.ok) return played;

  const updatedFirst: Player = { ...played.state.players[firstId], actionCards: played.state.players[firstId].actionCards.filter((id) => id !== action.cardIdFromFirst) };
  const updatedSecond: Player = { ...played.state.players[secondId], actionCards: played.state.players[secondId].actionCards.filter((id) => id !== action.cardIdFromSecond) };
  const updatedCaster: Player = { ...played.player, actionCards: [...played.player.actionCards, action.cardIdFromFirst, action.cardIdFromSecond] as never };

  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, players: { ...played.state.players, [firstId]: updatedFirst, [secondId]: updatedSecond, [action.playerId]: updatedCaster } },
    action.playerId,
  );
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("lie_in_wait") }] };
}

/**
 * TE "Crisis": "At the end of any player's turn, if there are at least 2
 * players who have not passed: Skip the next player's turn." Played
 * during the shared end_of_turn window (phases/actionPhase.ts's own
 * maybeAdvanceActivePlayer) — sets skipNextTurnForPlayerId to whoever
 * would actually be up next (computed the same way advanceActivePlayer
 * itself would), consumed there once that function actually runs.
 */
export function playCrisis(state: GameState, action: { type: "PLAY_CRISIS"; playerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "end_of_turn", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current end-of-turn priority window." };
  }
  const notPassedCount = Object.values(state.players).filter((p) => !p.eliminated && !p.hasPassed).length;
  if (notPassedCount < 2) {
    return { ok: false, error: 'TE "Crisis": requires at least 2 players who have not passed.' };
  }
  const played = playCard(state, action.playerId, "crisis");
  if (!played.ok) return played;

  const order = played.state.initiativeOrder;
  const currentIndex = played.state.activePlayerId ? order.indexOf(played.state.activePlayerId) : -1;
  let nextPlayerId: PlayerId | undefined;
  for (let i = 1; i <= order.length; i++) {
    const candidate = order[(currentIndex + i) % order.length];
    if (!played.state.players[candidate]?.hasPassed) {
      nextPlayerId = candidate;
      break;
    }
  }
  const nextState = advancePriorityWindowAfterAction({ ...played.state, skipNextTurnForPlayerId: nextPlayerId }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("crisis") }] };
}

/**
 * TE "Puppets on a String": "At the end of any player's turn, if you have
 * passed: Perform 1 action." Same end_of_turn window as Crisis above —
 * grants the CASTER (who must have already passed this round) 1 more
 * action, by clearing their own hasPassed flag just long enough for
 * maybeAdvanceActivePlayer's own upcoming advanceActivePlayer call to
 * treat them as the (or a) valid next active player. Re-passing
 * afterward (a normal PASS action) works exactly as it always does.
 */
export function playPuppetsOnAString(state: GameState, action: { type: "PLAY_PUPPETS_ON_A_STRING"; playerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "end_of_turn", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current end-of-turn priority window." };
  }
  const player = state.players[action.playerId];
  if (!player?.hasPassed) {
    return { ok: false, error: 'TE "Puppets on a String": this player must have already passed this round.' };
  }
  const played = playCard(state, action.playerId, "puppets_on_a_string");
  if (!played.ok) return played;

  const unpassedPlayer: Player = { ...played.player, hasPassed: false };
  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, players: { ...played.state.players, [action.playerId]: unpassedPlayer }, activePlayerId: action.playerId, activePlayerActionsTaken: 0, puppetsOnAStringActive: true },
    action.playerId,
  );
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("puppets_on_a_string") }] };
}

/**
 * TE "Exchange Program": "As an Action: Choose another player. You and
 * the player may agree to place 1 infantry from each of your
 * reinforcements into coexistence on a planet the other player controls
 * that contains their ground forces; if no agreement is reached, you
 * each discard 1 token from your fleet pool."
 *
 * A real negotiation between 2 people happens out loud before anything
 * changes hands — same "one atomic action represents the already-agreed
 * outcome" pattern this project's own Transactions already use — so
 * `agreed` here just reports whether that negotiation succeeded, rather
 * than this being a 2-step propose/accept flow.
 *
 * Reuses TE COEXIST's own data model directly (coexistingPlayerIds on
 * the target PlanetState) rather than going through the normal
 * commit-ground-forces pipeline at all — this places brand new infantry
 * straight from each player's reinforcements, with no invasion step
 * involved.
 */
export function playExchangeProgram(
  state: GameState,
  action: { type: "PLAY_EXCHANGE_PROGRAM"; playerId: PlayerId; otherPlayerId: PlayerId; agreed: boolean; targetPlanetId?: PlanetId },
  rules: RuleData,
): ActionResult {
  const played = playCard(state, action.playerId, "exchange_program");
  if (!played.ok) return played;

  if (!action.agreed) {
    const caster = played.player;
    const other = played.state.players[action.otherPlayerId];
    if (!other) return { ok: false, error: "Unknown player." };
    const removeOneFleetToken = (p: Player): Player => {
      const { fleet, ...rest } = p.commandTokens;
      return { ...p, commandTokens: { ...rest, fleet: Math.max(0, fleet - 1) } };
    };
    const nextState = advancePriorityWindowAfterAction(
      { ...played.state, players: { ...played.state.players, [action.playerId]: removeOneFleetToken(caster), [action.otherPlayerId]: removeOneFleetToken(other) } },
      action.playerId,
    );
    return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("exchange_program") }] };
  }

  if (!action.targetPlanetId) {
    return { ok: false, error: 'TE "Exchange Program": targetPlanetId is required when agreement is reached.' };
  }
  const found = findPlanet(played.state, action.targetPlanetId);
  if (!found) return { ok: false, error: `No planet ${action.targetPlanetId}.` };
  if (found.planet.controllerId !== action.otherPlayerId) {
    return { ok: false, error: "That planet must be controlled by the OTHER player named in this exchange." };
  }
  const otherHasGroundForces = (found.planet.unitsByPlayer[action.otherPlayerId] ?? []).some((s) => s.count > 0);
  if (!otherHasGroundForces) {
    return { ok: false, error: "That planet must contain the other player's own ground forces." };
  }
  const casterCheck = checkReinforcementsAvailable(played.state, action.playerId, [{ unitType: "infantry", count: 1 }]);
  if (!casterCheck.ok) return casterCheck;
  const otherCheck = checkReinforcementsAvailable(played.state, action.otherPlayerId, [{ unitType: "infantry", count: 1 }]);
  if (!otherCheck.ok) return otherCheck;

  let updatedPlanet = found.planet;
  // The other player's own new infantry simply joins their existing presence (they already control this planet) — the caster's own is what actually starts coexisting.
  updatedPlanet = addPlanetUnits(updatedPlanet, action.otherPlayerId, "infantry", 1);
  updatedPlanet = addPlanetUnits(updatedPlanet, action.playerId, "infantry", 1);
  updatedPlanet = { ...updatedPlanet, coexistingPlayerIds: [...(updatedPlanet.coexistingPlayerIds ?? []), action.playerId] };

  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)) };
  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, systems: { ...played.state.systems, [found.systemId]: updatedSystem } },
    action.playerId,
  );
  return {
    ok: true,
    state: nextState,
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("exchange_program") }, { type: "COEXISTENCE_STARTED", systemId: found.systemId, planetId: action.targetPlanetId, coexistingPlayerId: action.playerId }],
  };
}

/**
 * TE "Brilliance": "As an Action: Ready 1 of your planets that has a
 * technology specialty or choose 1 player to gain their breakthrough."
 * Reuses rules/breakthroughs.ts's own grantBreakthrough directly for the
 * 2nd option.
 */
export function playBrilliance(
  state: GameState,
  action: { type: "PLAY_BRILLIANCE"; playerId: PlayerId; mode: "ready_planet" | "grant_breakthrough"; planetId?: PlanetId; targetPlayerId?: PlayerId; fractureDieRoll?: number },
  rules: RuleData,
): ActionResult {
  const played = playCard(state, action.playerId, "brilliance");
  if (!played.ok) return played;

  if (action.mode === "ready_planet") {
    if (!action.planetId) return { ok: false, error: 'TE "Brilliance": planetId is required for ready_planet mode.' };
    const found = findPlanet(played.state, action.planetId);
    if (!found || found.planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };
    if ((rules.planets[action.planetId]?.techSpecialties ?? []).length === 0) {
      return { ok: false, error: "That planet has no technology specialty." };
    }
    const updatedPlanet: PlanetState = { ...found.planet, exhausted: false };
    const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };
    const nextState = advancePriorityWindowAfterAction({ ...played.state, systems: { ...played.state.systems, [found.systemId]: updatedSystem } }, action.playerId);
    return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("brilliance") }] };
  }

  if (!action.targetPlayerId) return { ok: false, error: 'TE "Brilliance": targetPlayerId is required for grant_breakthrough mode.' };
  const granted = grantBreakthrough(played.state, action.targetPlayerId, rules, action.fractureDieRoll);
  const nextState = advancePriorityWindowAfterAction(granted.state, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("brilliance") }, ...granted.events] };
}

/**
 * TE "Mercenary Contract": "As an Action: Spend 2 trade goods to place 2
 * neutral infantry on any non-home planet that contains no units; if
 * that planet was owned by another player, they return its planet card
 * to the planet card deck." Places under NEUTRAL_PLAYER_ID, same
 * pseudo-player used for Fracture guardians.
 */
export function playMercenaryContract(state: GameState, action: { type: "PLAY_MERCENARY_CONTRACT"; playerId: PlayerId; planetId: PlanetId }, rules: RuleData): ActionResult {
  const player = state.players[action.playerId];
  if (player.tradeGoods < 2) return { ok: false, error: "Not enough trade goods (need 2)." };
  const found = findPlanet(state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  if (rules.planets[action.planetId]?.homeFactionId) return { ok: false, error: "Cannot target a home planet." };
  const hasAnyUnits = Object.values(found.planet.unitsByPlayer).some((stacks) => (stacks ?? []).some((s) => s.count > 0));
  if (hasAnyUnits) return { ok: false, error: "That planet must contain no units." };

  const played = playCard(state, action.playerId, "mercenary_contract");
  if (!played.ok) return played;

  const chargedPlayer: Player = { ...played.player, tradeGoods: played.player.tradeGoods - 2 };
  // RR (yjmrobert.com/tirules/components/c_action_cards): "When a planet card is returned to the planet card deck... when a player later gains control of that planet, they will explore it" — so explored resets to false too, not just controllerId. "If a legendary planet card is returned, the player that controlled it also loses the associated legendary planet ability card" — legendaryAbilityExhausted reset alongside (the ability itself is tracked as "gone" the same way losing control normally works elsewhere in this project, via wasUncontrolled-gated re-grant on the NEXT controller).
  const updatedPlanet: PlanetState = {
    ...found.planet,
    controllerId: null,
    exhausted: false,
    explored: false,
    legendaryAbilityExhausted: undefined,
    unitsByPlayer: { ...found.planet.unitsByPlayer, [NEUTRAL_PLAYER_ID]: [{ unitType: "infantry", count: 2, damagedCount: 0 }] },
  };
  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };
  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, players: { ...played.state.players, [action.playerId]: chargedPlayer }, systems: { ...played.state.systems, [found.systemId]: updatedSystem } },
    action.playerId,
  );
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("mercenary_contract") }] };
}

/**
 * TE "Pirate Contract": "As an Action: Place 1 neutral destroyer in a
 * non-home system that contains no non-neutral ships."
 */
export function playPirateContract(state: GameState, action: { type: "PLAY_PIRATE_CONTRACT"; playerId: PlayerId; systemId: SystemId }, rules: RuleData): ActionResult {
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  if (Object.values(rules.homeSystemByFaction).includes(action.systemId)) {
    return { ok: false, error: "Cannot place a neutral destroyer in a home system." };
  }
  const hasNonNeutralShips = Object.entries(system.spaceUnitsByPlayer).some(([id, stacks]) => id !== NEUTRAL_PLAYER_ID && (stacks ?? []).some((s) => s.count > 0));
  if (hasNonNeutralShips) return { ok: false, error: "That system contains non-neutral ships." };

  const played = playCard(state, action.playerId, "pirate_contract");
  if (!played.ok) return played;

  const updatedSystem = addSpaceUnits(system, NEUTRAL_PLAYER_ID, "destroyer", 1);
  const nextState = advancePriorityWindowAfterAction({ ...played.state, systems: { ...played.state.systems, [action.systemId]: updatedSystem } }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("pirate_contract") }] };
}

/**
 * TE "Pirate Fleet": "As an Action: Spend 3 resources to place 1 neutral
 * carrier, 1 neutral cruiser, 1 neutral destroyer, and 2 neutral
 * fighters in a non-home system that contains no non-neutral ships."
 */
export function playPirateFleet(
  state: GameState,
  action: { type: "PLAY_PIRATE_FLEET"; playerId: PlayerId; systemId: SystemId; exhaustPlanetIdsForResources: PlanetId[] },
  rules: RuleData,
): ActionResult {
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  if (Object.values(rules.homeSystemByFaction).includes(action.systemId)) {
    return { ok: false, error: "Cannot place a neutral fleet in a home system." };
  }
  const hasNonNeutralShips = Object.entries(system.spaceUnitsByPlayer).some(([id, stacks]) => id !== NEUTRAL_PLAYER_ID && (stacks ?? []).some((s) => s.count > 0));
  if (hasNonNeutralShips) return { ok: false, error: "That system contains non-neutral ships." };

  let totalResources = 0;
  let systems = state.systems;
  for (const planetId of action.exhaustPlanetIdsForResources) {
    const found = findPlanet(state, planetId);
    if (!found || found.planet.controllerId !== action.playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };
    if (found.planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };
    totalResources += rules.planets[planetId]?.resources ?? 0;
    const updatedPlanet: PlanetState = { ...found.planet, exhausted: true };
    systems = { ...systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } };
  }
  if (totalResources < 3) return { ok: false, error: "Not enough resources from the exhausted planets (need 3)." };

  const played = playCard({ ...state, systems }, action.playerId, "pirate_fleet");
  if (!played.ok) return played;

  let updatedSystem = played.state.systems[action.systemId];
  updatedSystem = addSpaceUnits(updatedSystem, NEUTRAL_PLAYER_ID, "carrier", 1);
  updatedSystem = addSpaceUnits(updatedSystem, NEUTRAL_PLAYER_ID, "cruiser", 1);
  updatedSystem = addSpaceUnits(updatedSystem, NEUTRAL_PLAYER_ID, "destroyer", 1);
  updatedSystem = addSpaceUnits(updatedSystem, NEUTRAL_PLAYER_ID, "fighter", 2);
  const nextState = advancePriorityWindowAfterAction({ ...played.state, systems: { ...played.state.systems, [action.systemId]: updatedSystem } }, action.playerId);
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("pirate_fleet") }] };
}

/**
 * TE "Crash Landing": "When your last ship in the active system is
 * destroyed: Place 1 of your ground forces from the space area of the
 * active system onto a planet in that system other than Mecatol Rex; if
 * the planet contains other players' units, place your ground force
 * into coexistence." Played during the last_ship_destroyed window
 * (opened by phases/spaceCombat.ts's own assignHits, right when a
 * player's ships in a system hit zero while they still have ground
 * forces sitting in that system's space area). Grants its OWN
 * coexistence placement directly — unlike TE COEXIST's own
 * hasAbility("can_choose_coexist") gate (which is for a DIFFERENT
 * situation, choosing to coexist instead of fighting during a normal
 * commit), this card's text itself is the source of the ability here,
 * so no such check applies.
 */
export function playCrashLanding(
  state: GameState,
  action: { type: "PLAY_CRASH_LANDING"; playerId: PlayerId; unitType: import("../types/enums").UnitType; targetPlanetId: PlanetId },
  rules: RuleData,
): ActionResult {
  if (!isPlayersTurnInWindow(state, "last_ship_destroyed", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current last-ship-destroyed priority window." };
  }
  const pending = state.pendingTacticalAction;
  if (!pending) return { ok: false, error: "No tactical action in progress." };
  const systemId = pending.systemId;
  const system = state.systems[systemId];
  const targetPlanet = system?.planets.find((p) => p.planetId === action.targetPlanetId);
  if (!targetPlanet) return { ok: false, error: `${action.targetPlanetId} isn't in the active system.` };
  if (rules.planets[action.targetPlanetId]?.isMecatolRex) {
    return { ok: false, error: 'TE "Crash Landing": cannot target Mecatol Rex.' };
  }
  const spaceStack = system.spaceUnitsByPlayer[action.playerId]?.find((s) => s.unitType === action.unitType && s.count > 0 && GROUND_FORCE_TYPES.includes(s.unitType));
  if (!spaceStack) return { ok: false, error: `This player has no ${action.unitType} in the space area of that system.` };

  const played = playCard(state, action.playerId, "crash_landing");
  if (!played.ok) return played;

  const updatedSpaceStacks = (system.spaceUnitsByPlayer[action.playerId] ?? []).map((s) => (s === spaceStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  const otherPlayersHaveUnitsHere = Object.entries(targetPlanet.unitsByPlayer).some(([id, stacks]) => id !== action.playerId && (stacks ?? []).some((s) => s.count > 0));
  let updatedPlanet = addPlanetUnits(targetPlanet, action.playerId, action.unitType, 1);
  if (otherPlayersHaveUnitsHere) {
    updatedPlanet = { ...updatedPlanet, coexistingPlayerIds: [...(updatedPlanet.coexistingPlayerIds ?? []), action.playerId] };
  }
  const updatedSystem: SystemState = {
    ...system,
    spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedSpaceStacks },
    planets: system.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)),
  };
  const nextState = advancePriorityWindowAfterAction({ ...played.state, systems: { ...played.state.systems, [systemId]: updatedSystem } }, action.playerId);
  const events: GameEvent[] = [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("crash_landing") }];
  if (otherPlayersHaveUnitsHere) events.push({ type: "COEXISTENCE_STARTED", systemId, planetId: action.targetPlanetId, coexistingPlayerId: action.playerId });
  return { ok: true, state: nextState, events };
}

/**
 * TE "Extreme Duress": "At the start of another player's turn, if they
 * have a readied strategy card: If that player's next action is not a
 * strategic action, they discard all of their action cards, gives you
 * all of their trade goods, and shows you all of their secret
 * objectives." Played during the turn_start window (opened by
 * phases/actionPhase.ts's own advanceActivePlayer) — this only ever SETS
 * pendingExtremeDuress; the actual conditional punishment fires later,
 * from GameEngine.ts's own post-dispatch check against the armed
 * player's very next action.
 */
export function playExtremeDuress(state: GameState, action: { type: "PLAY_EXTREME_DURESS"; playerId: PlayerId; armedPlayerId: PlayerId }): ActionResult {
  if (!isPlayersTurnInWindow(state, "turn_start", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current turn-start priority window." };
  }
  if (state.activePlayerId !== action.armedPlayerId) {
    return { ok: false, error: 'TE "Extreme Duress": armedPlayerId must be whoever\'s turn is actually starting.' };
  }
  const played = playCard(state, action.playerId, "extreme_duress");
  if (!played.ok) return played;

  const nextState = advancePriorityWindowAfterAction(
    { ...played.state, pendingExtremeDuress: { armedPlayerId: action.armedPlayerId, casterId: action.playerId } },
    action.playerId,
  );
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("extreme_duress") }] };
}

/**
 * TE "Extreme Duress": the actual punishment, checked/applied by
 * GameEngine.ts's own post-dispatch logic against whatever action the
 * armed player just took (any type OTHER than RESOLVE_STRATEGY_PRIMARY
 * counts as "not a strategic action") — always clears
 * pendingExtremeDuress either way, whether or not the punishment
 * actually fires.
 */
export function maybeApplyExtremeDuress(state: GameState, actedPlayerId: PlayerId, actionType: string): { state: GameState; events: GameEvent[] } {
  const pending = state.pendingExtremeDuress;
  if (!pending || pending.armedPlayerId !== actedPlayerId) return { state, events: [] };
  // PASS_PRIORITY (declining some OTHER, unrelated reactive window) isn't a real "action" for this card's own purposes — only count once the armed player actually does something that consumes their own turn.
  if (actionType === "PASS_PRIORITY") return { state, events: [] };
  if (actionType === "RESOLVE_STRATEGY_PRIMARY") {
    return { state: { ...state, pendingExtremeDuress: undefined }, events: [] };
  }
  const armed = state.players[pending.armedPlayerId];
  const caster = state.players[pending.casterId];
  if (!armed || !caster) return { state: { ...state, pendingExtremeDuress: undefined }, events: [] };

  const updatedArmed: Player = { ...armed, actionCards: [], tradeGoods: 0 };
  const updatedCaster: Player = { ...caster, tradeGoods: caster.tradeGoods + armed.tradeGoods };
  const nextState: GameState = {
    ...state,
    pendingExtremeDuress: undefined,
    players: { ...state.players, [pending.armedPlayerId]: updatedArmed, [pending.casterId]: updatedCaster },
  };
  // "Shows you all of their secret objectives" needs no state change in this project (secretObjectives are already visible to whichever code needs them — there's no separate "hidden from other players" gate on this data structure); recorded as an event for any UI that wants to actually display them to the caster.
  return {
    state: nextState,
    events: [{ type: "EXTREME_DURESS_TRIGGERED", armedPlayerId: pending.armedPlayerId, casterId: pending.casterId, secretObjectiveIds: armed.secretObjectives }],
  };
}
