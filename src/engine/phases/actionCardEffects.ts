import { GameState, Player, PlanetState, SystemState, UnitStack, PendingAgendaVote, AgendaPredictionReward } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, ActionCardId, AgendaId, TechId, UnitUpgradeId, PromissoryNoteId, asActionCardId } from "../types/ids";
import { UnitType, SHIP_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { getLawOwner, maybeQueueSecretObjectiveLimit } from "./agendaEffects";
import { researchTechnology } from "./technology";
import { getAdjacentSystems, arePlayersNeighbors } from "../rules/adjacency";
import { drawExplorationCard, applyExplorationCard } from "./exploration";
import { revealAgenda } from "./agendaPhase";
import { drawActionCard } from "./actionCards";
import { checkReinforcementsAvailable, commandTokensAvailableInReinforcements, placeCommandTokenFromReinforcements } from "../rules/reinforcements";

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
  let placedAny = false;

  for (const [systemId, system] of Object.entries(played.state.systems)) {
    let changed = false;
    const planets = system.planets.map((p) => {
      if (p.controllerId !== action.playerId) return p;
      changed = true;
      placedAny = true;
      events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: systemId as SystemId, planetId: p.planetId, unitType: "infantry", count: 1, totalCost: 0 });
      return addPlanetUnits(p, action.playerId, "infantry", 1);
    });
    if (changed) systems[systemId as SystemId] = { ...system, planets };
  }
  if (!placedAny) return { ok: false, error: "This player doesn't control any planets." };

  return { ok: true, state: { ...played.state, systems }, events };
}

/** RR "War Effort": place 1 cruiser from reinforcements in a system that contains 1 or more of this player's ships. */
export function playWarEffort(state: GameState, action: { type: "PLAY_WAR_EFFORT"; playerId: PlayerId; systemId: SystemId }): ActionResult {
  const played = playCard(state, action.playerId, "war_effort");
  if (!played.ok) return played;

  const system = played.state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  const hasOwnShip = (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => SHIP_TYPES.includes(s.unitType) && s.count > 0);
  if (!hasOwnShip) return { ok: false, error: "This player has no ships in that system." };
  const reinforcementsCheck = checkReinforcementsAvailable(played.state, action.playerId, [{ unitType: "cruiser", count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const updatedSystem = addSpaceUnits(system, action.playerId, "cruiser", 1);
  const nextState: GameState = { ...played.state, systems: { ...played.state.systems, [action.systemId]: updatedSystem } };
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
export function playGhostShip(state: GameState, action: { type: "PLAY_GHOST_SHIP"; playerId: PlayerId; systemId: SystemId }, rules: RuleData): ActionResult {
  const played = playCard(state, action.playerId, "ghost_ship");
  if (!played.ok) return played;

  const system = played.state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  const isHomeSystem = system.planets.some((p) => rules.planets[p.planetId]?.homeFactionId != null);
  if (isHomeSystem) return { ok: false, error: "Ghost Ship cannot target a home system." };
  if (system.wormholes.length === 0) return { ok: false, error: "That system doesn't contain a wormhole." };
  const hasOtherShips = Object.entries(system.spaceUnitsByPlayer).some(([pid, stacks]) => pid !== action.playerId && (stacks ?? []).some((s) => s.count > 0));
  if (hasOtherShips) return { ok: false, error: "That system contains another player's ships." };
  const reinforcementsCheck = checkReinforcementsAvailable(played.state, action.playerId, [{ unitType: "destroyer", count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const updatedSystem = addSpaceUnits(system, action.playerId, "destroyer", 1);
  const nextState: GameState = { ...played.state, systems: { ...played.state.systems, [action.systemId]: updatedSystem } };
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
  action: { type: "PLAY_UNSTABLE_PLANET"; playerId: PlayerId; planetId: PlanetId; targetPlayerId?: PlayerId; destroyCount?: number },
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

  const destroyCount = Math.min(3, Math.max(0, action.destroyCount ?? 0));
  if (destroyCount > 0 && action.targetPlayerId) {
    const stacks = updatedPlanet.unitsByPlayer[action.targetPlayerId] ?? [];
    const infantry = stacks.find((s) => s.unitType === "infantry");
    const n = Math.min(destroyCount, infantry?.count ?? 0);
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
  action: { type: "PLAY_ARCHAEOLOGICAL_EXPEDITION"; playerId: PlayerId; planetId: PlanetId },
  rules: RuleData,
): ActionResult {
  const played = playCard(state, action.playerId, "archaeological_expedition");
  if (!played.ok) return played;

  const found = findPlanet(played.state, action.planetId);
  if (!found) return { ok: false, error: `No planet ${action.planetId}.` };
  if (found.planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };
  const trait = rules.planets[action.planetId]?.traits[0] as "cultural" | "industrial" | "hazardous" | undefined;
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
export function playExplorationProbe(state: GameState, action: { type: "PLAY_EXPLORATION_PROBE"; playerId: PlayerId; systemId: SystemId }, rules: RuleData): ActionResult {
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
    const result = applyExplorationCard(nextState, action.playerId, action.systemId, null, cardId, rules);
    nextState = result.state;
    events.push(...result.events, { type: "EXPLORATION_CARD_DRAWN", playerId: action.playerId, cardId, deck: "frontier" });
    const card = rules.explorationCards[cardId];
    const goesToDiscard = !card?.isRelicFragment && !card?.attach && !card?.keepInPlayArea;
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
  if (pending.predictions?.some((p) => p.playerId === playerId)) {
    return { ok: false, error: "This player has already predicted on this agenda." };
  }
  const withPrediction: PendingAgendaVote = { ...pending, predictions: [...(pending.predictions ?? []), { playerId, cardId, predictedOutcome, reward }] };
  return { ok: true, state: { ...state, pendingAgendaVote: removeFromVotingOrder(withPrediction, playerId) } };
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
  const played = playCard(state, action.playerId, "assassinate_representative");
  if (!played.ok) return played;
  const pending = played.state.pendingAgendaVote;
  if (!pending) return { ok: false, error: "No agenda is currently being voted on." };
  if (!pending.votingOrder.includes(action.targetPlayerId)) {
    return { ok: false, error: "That player isn't currently eligible to vote on this agenda." };
  }
  const nextState: GameState = { ...played.state, pendingAgendaVote: removeFromVotingOrder(pending, action.targetPlayerId) };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("assassinate_representative") }] };
}

/** RR "Veto": discard the just-revealed agenda and reveal the next one instead — reuses agendaPhase.ts's own revealAgenda for the actual reveal (including all of ITS OWN reveal-time checks, e.g. Classified Document Leaks/Committee Formation) rather than duplicating any of that. */
export function playVeto(state: GameState, action: { type: "PLAY_VETO"; playerId: PlayerId }, rules: RuleData): ActionResult {
  const played = playCard(state, action.playerId, "veto");
  if (!played.ok) return played;
  const pending = played.state.pendingAgendaVote;
  if (!pending) return { ok: false, error: "No agenda is currently being voted on." };

  const vetoedState: GameState = {
    ...played.state,
    pendingAgendaVote: null,
    agendaDeck: { ...played.state.agendaDeck, discardIds: [...played.state.agendaDeck.discardIds, pending.agendaId] },
  };
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
  const played = playCard(state, action.playerId, "hack_election");
  if (!played.ok) return played;
  const pending = played.state.pendingAgendaVote;
  if (!pending) return { ok: false, error: "No agenda is currently being voted on." };
  const speakerId = played.state.seatOrder.find((id) => played.state.players[id]?.isSpeaker);
  if (!speakerId) return { ok: false, error: "No speaker set — can't determine voting order." };

  const reversedSeatOrder = [...played.state.seatOrder].reverse();
  const reversedSpeakerIndex = reversedSeatOrder.indexOf(speakerId);
  const newOrder = [...reversedSeatOrder.slice(reversedSpeakerIndex + 1), ...reversedSeatOrder.slice(0, reversedSpeakerIndex + 1)];
  const stillEligible = new Set(pending.votingOrder);
  const reorderedVotingOrder = newOrder.filter((id) => stillEligible.has(id));

  const updatedPending: PendingAgendaVote = { ...pending, votingOrder: reorderedVotingOrder, nextVoterIndex: 0 };
  return {
    ok: true,
    state: { ...played.state, pendingAgendaVote: updatedPending },
    events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("hack_election") }],
  };
}

/** RR "Insider Information": look at the top card of the agenda deck. Pure information, no state change beyond the mechanical discard — this engine already doesn't model hiding a not-yet-revealed agenda's identity from specific players (same scope cut as Committee Formation/Covert Legislation's own comments in agendaPhase.ts), so `state.agendaDeck.deckIds[0]` already IS that information for whoever's allowed to look. */
export function playInsiderInformation(state: GameState, action: { type: "PLAY_INSIDER_INFORMATION"; playerId: PlayerId }): ActionResult {
  const played = playCard(state, action.playerId, "insider_information");
  if (!played.ok) return played;
  return { ok: true, state: played.state, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: asActionCardId("insider_information") }] };
}

/** RR "Diplomatic Pressure": another player must give this player 1 promissory note of their hand (the specific note is the target's own choice — the client resolves that choice before submitting `promissoryNoteId`). */
export function playDiplomaticPressure(
  state: GameState,
  action: { type: "PLAY_DIPLOMATIC_PRESSURE"; playerId: PlayerId; targetPlayerId: PlayerId; promissoryNoteId: PromissoryNoteId },
): ActionResult {
  const played = playCard(state, action.playerId, "diplomatic_pressure");
  if (!played.ok) return played;
  if (action.targetPlayerId === action.playerId) return { ok: false, error: "Diplomatic Pressure must target another player." };
  const target = played.state.players[action.targetPlayerId];
  if (!target?.promissoryNotesInHand.includes(action.promissoryNoteId)) {
    return { ok: false, error: "That player doesn't have that promissory note." };
  }

  const updatedTarget: Player = { ...target, promissoryNotesInHand: target.promissoryNotesInHand.filter((id) => id !== action.promissoryNoteId) };
  const updatedActingPlayer: Player = { ...played.player, promissoryNotesInHand: [...played.player.promissoryNotesInHand, action.promissoryNoteId] };
  const nextState: GameState = {
    ...played.state,
    players: { ...played.state.players, [action.targetPlayerId]: updatedTarget, [action.playerId]: updatedActingPlayer },
  };
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
export function playTechnologyRider(state: GameState, action: { type: "PLAY_TECHNOLOGY_RIDER"; playerId: PlayerId; predictedOutcome: string; techId: TechId }): ActionResult {
  if (state.players[action.playerId]?.technologies.includes(action.techId)) {
    return { ok: false, error: "This player already owns that technology." };
  }
  return playRiderCard(state, action.playerId, "technology_rider", action.predictedOutcome, { kind: "technology", techId: action.techId });
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
        // Re-checked here (not just at play time) since resolution can happen slightly later — silently skipped if this player no longer controls that planet OR has hit their 3-space-dock reinforcement cap, rather than failing the whole resolution over 1 rider's now-stale target.
        const found = findPlanet(nextState, reward.planetId);
        if (found && found.planet.controllerId === prediction.playerId && checkReinforcementsAvailable(nextState, prediction.playerId, [{ unitType: "space_dock", count: 1 }]).ok) {
          const updatedPlanet = addPlanetUnits(found.planet, prediction.playerId, "space_dock", 1);
          const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === reward.planetId ? updatedPlanet : p)) };
          nextState = { ...nextState, systems: { ...nextState.systems, [found.systemId]: updatedSystem } };
          events.push({ type: "UNITS_PRODUCED", playerId: prediction.playerId, systemId: found.systemId, planetId: reward.planetId, unitType: "space_dock", count: 1, totalCost: 0 });
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
        let hand = player.actionCards;
        for (let i = 0; i < 3; i++) {
          const drawResult = drawActionCard(nextState);
          nextState = { ...nextState, actionCardDeck: drawResult.deck, actionCardDiscardPile: drawResult.discardPile };
          if (!drawResult.drawn) break;
          hand = [...hand, drawResult.drawn];
        }
        const previousSpeakerId = nextState.seatOrder.find((id) => nextState.players[id]?.isSpeaker);
        let players: GameState["players"] = { ...nextState.players, [prediction.playerId]: { ...nextState.players[prediction.playerId], actionCards: hand } };
        if (previousSpeakerId && previousSpeakerId !== prediction.playerId) {
          players = { ...players, [previousSpeakerId]: { ...players[previousSpeakerId], isSpeaker: false } };
        }
        players = { ...players, [prediction.playerId]: { ...players[prediction.playerId], isSpeaker: true } };
        nextState = { ...nextState, players };
        events.push({ type: "SPEAKER_CHANGED", playerId: prediction.playerId });
        break;
      }
      case "technology": {
        const researched = researchTechnology(nextState, prediction.playerId, reward.techId, 0, [], rules);
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
