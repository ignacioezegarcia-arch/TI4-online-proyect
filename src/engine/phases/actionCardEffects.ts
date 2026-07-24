import { GameState, Player, PlanetState, SystemState, UnitStack } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, ActionCardId, AgendaId, TechId, asActionCardId } from "../types/ids";
import { UnitType, SHIP_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { getLawOwner, maybeQueueSecretObjectiveLimit } from "./agendaEffects";
import { researchTechnology } from "./technology";

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

/** RR "Unexpected Action": remove 1 of this player's activated (on-board) command tokens and return it to their tactic reinforcements. RR 5.1: only tactic tokens ever sit on the board, so "reinforcements" here is unambiguous. */
export function playUnexpectedAction(state: GameState, action: { type: "PLAY_UNEXPECTED_ACTION"; playerId: PlayerId; systemId: SystemId }): ActionResult {
  const played = playCard(state, action.playerId, "unexpected_action");
  if (!played.ok) return played;

  if (!played.player.commandTokens.onBoard.includes(action.systemId)) {
    return { ok: false, error: "This player has no command token in that system." };
  }
  const updatedPlayer: Player = {
    ...played.player,
    commandTokens: {
      ...played.player.commandTokens,
      tactic: played.player.commandTokens.tactic + 1,
      onBoard: played.player.commandTokens.onBoard.filter((s) => s !== action.systemId),
    },
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
