import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, AgendaId } from "../types/ids";
import { UnitType, UnitAbility, SHIP_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { startNewRound } from "./actionPhase";
import { arePlayersNeighbors } from "../rules/adjacency";
import { finalizeAgendaResolution, revealAgenda } from "./agendaPhase";

/**
 * RR 7 AGENDA EFFECTS — the actual per-agenda mechanics, kept separate
 * from phases/agendaPhase.ts (which only handles the generic vote/
 * resolve/law-vs-directive plumbing, deliberately with no effect text —
 * see that file's own scope note). One section per agenda, added
 * incrementally in deck order; each is its own small set of functions
 * rather than a single generic dispatcher, since — same reasoning as
 * this project's Deploy/Capture/legendary-planet infrastructure — every
 * agenda does something different enough that a shared abstraction would
 * just get in the way.
 */

/** Is `agendaId` currently an active law, elected by exactly `outcome`? Laws whose OTHER outcome won, or that were never elected at all, don't count. */
export function isLawActiveWithOutcome(state: GameState, agendaId: AgendaId, outcome: string): boolean {
  return state.agendaDeck.lawsInPlay.some((l) => l.agendaId === agendaId && l.outcome === outcome);
}

/** Is `agendaId` currently an active law at all, regardless of which outcome elected it? For plain (non-For/Against) laws, and For/Against ones where only ONE side's win is even possible to check meaningfully. */
export function isLawActive(state: GameState, agendaId: AgendaId): boolean {
  return state.agendaDeck.lawsInPlay.some((l) => l.agendaId === agendaId);
}

/** The current owner (a real player) of an "elect Player" law, if it's in play — undefined if it isn't, or if it somehow has no real owner (shouldn't happen for an elect-Player agenda, but the type allows "common"). */
export function getLawOwner(state: GameState, agendaId: AgendaId): PlayerId | undefined {
  const law = state.agendaDeck.lawsInPlay.find((l) => l.agendaId === agendaId);
  return law && law.ownerId !== "common" ? law.ownerId : undefined;
}

/**
 * RR 7: one-time resolution side-effects for agendas whose outcome needs
 * NO further player choice at all (fully automatic once the winner is
 * known) — called from phases/agendaPhase.ts's finalizeAgendaResolution
 * right after the generic law/directive bookkeeping. Agendas whose
 * one-time effect DOES need a real player choice (which unit to destroy,
 * which planet to exhaust, etc.) get their own dedicated pending-state +
 * action instead, same pattern as Anti-Intellectual Revolution — this
 * dispatcher is only for the ones that don't need that.
 */
export function applyAgendaResolutionSideEffects(state: GameState, rules: RuleData, agendaId: AgendaId, winner: string | null, votesByOutcome: Record<string, { playerId: PlayerId; votes: number }[]>): GameState {
  let nextState = state;

  // RR "Conventions of War" ("against"): each player who voted Against discards their entire action-card hand.
  if (agendaId === "conventions_of_war" && winner === "against") {
    for (const voter of votesByOutcome["against"] ?? []) {
      const p = nextState.players[voter.playerId];
      if (p) nextState = { ...nextState, players: { ...nextState.players, [voter.playerId]: { ...p, actionCards: [] } } };
    }
  }

  // RR "Fleet Regulations" ("against"): each player places 1 command token from their reinforcements into their fleet pool.
  if (agendaId === "fleet_regulations" && winner === "against") {
    for (const p of Object.values(nextState.players)) {
      nextState = { ...nextState, players: { ...nextState.players, [p.id]: { ...p, commandTokens: { ...p.commandTokens, fleet: p.commandTokens.fleet + 1 } } } };
    }
  }

  // RR "Shared Research" ("against"): each player places a command token from their reinforcements in their home system, if able (i.e. they still have at least 1 tactic-pool token left to spend).
  if (agendaId === "shared_research" && winner === "against") {
    for (const p of Object.values(nextState.players)) {
      const homeSystemId = rules.homeSystemByFaction[p.factionId];
      if (!homeSystemId || p.commandTokens.tactic <= 0) continue;
      nextState = { ...nextState, players: { ...nextState.players, [p.id]: { ...p, commandTokens: { ...p.commandTokens, tactic: p.commandTokens.tactic - 1, onBoard: [...p.commandTokens.onBoard, homeSystemId as SystemId] } } } };
    }
  }

  // RR "Checks and Balances" ("against"): each player readies only 3 of their planets — the player's own choice of WHICH 3 isn't offered here (no dedicated action exists for this yet); as a reasonable default, this readies the first 3 currently-exhausted planets found, flagged as a simplification.
  if (agendaId === "checks_and_balances" && winner === "against") {
    for (const p of Object.values(nextState.players)) {
      let readiedSoFar = 0;
      const systems = { ...nextState.systems };
      for (const [systemId, system] of Object.entries(systems)) {
        if (readiedSoFar >= 3) break;
        const updatedPlanets = system.planets.map((planet) => {
          if (readiedSoFar >= 3 || planet.controllerId !== p.id || !planet.exhausted) return planet;
          readiedSoFar += 1;
          return { ...planet, exhausted: false };
        });
        systems[systemId as SystemId] = { ...system, planets: updatedPlanets };
      }
      nextState = { ...nextState, systems };
    }
  }

  // RR "Articles of War" ("against"): each player who voted For gains 3 trade goods.
  if (agendaId === "articles_of_war" && winner === "against") {
    for (const voter of votesByOutcome["for"] ?? []) {
      const p = nextState.players[voter.playerId];
      if (p) nextState = { ...nextState, players: { ...nextState.players, [voter.playerId]: { ...p, tradeGoods: p.tradeGoods + 3 } } };
    }
  }

  // RR "Nexus Sovereignty" ("against"): place a gamma wormhole token in the Mecatol Rex system.
  if (agendaId === "nexus_sovereignty" && winner === "against") {
    const mecatol = nextState.systems[rules.mecatolSystemId as SystemId];
    if (mecatol && !mecatol.wormholes.includes("gamma")) {
      nextState = { ...nextState, systems: { ...nextState.systems, [rules.mecatolSystemId]: { ...mecatol, wormholes: [...mecatol.wormholes, "gamma"] } } };
    }
  }

  // RR "Publicize Weapon Schematics" ("against"): each player who owns a war sun technology discards their entire action-card hand.
  if (agendaId === "publicize_weapon_schematics" && winner === "against") {
    for (const p of Object.values(nextState.players)) {
      const ownsWarSun = p.unitUpgrades.some((id) => rules.unitUpgrades[id]?.unitType === "war_sun");
      if (ownsWarSun) nextState = { ...nextState, players: { ...nextState.players, [p.id]: { ...p, actionCards: [] } } };
    }
  }

  return nextState;
}

/** RR "Regulated Conscription" ("for"): fighters and infantry are produced only 1 at a time for their cost instead of the normal 2, while this law is active. Every other unit type is unaffected — checked generically by callers (production.ts) instead of baking this into getUnitStats itself, since it's a temporary rule-modifier, not a change to the unit's own printed stats. */
export function getEffectiveProducesQuantity(state: GameState, unitType: UnitType, basePerToken: number): number {
  if ((unitType === "fighter" || unitType === "infantry") && isLawActiveWithOutcome(state, "regulated_conscription" as AgendaId, "for")) {
    return 1;
  }
  return basePerToken;
}

// ---------------------------------------------------------------------
// RR "Committee Formation": the owner's own choice, offered right when an
// agenda that elects a Player is revealed (see phases/agendaPhase.ts's
// revealAgenda) — discard this card to directly elect whoever they want
// (no vote at all for this one agenda), or decline and let the normal
// vote happen as usual.
// ---------------------------------------------------------------------

/** The owner discards Committee Formation to directly elect `chosenPlayerId` — resolves the pending agenda immediately, exactly as if every vote had gone to that player. */
export function useCommitteeFormation(
  state: GameState,
  action: { type: "USE_COMMITTEE_FORMATION"; playerId: PlayerId; chosenPlayerId: PlayerId },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingCommitteeFormationDecision;
  if (!pending || pending.ownerId !== action.playerId) {
    return { ok: false, error: "This player has no pending Committee Formation decision right now." };
  }
  if (!state.players[action.chosenPlayerId]) return { ok: false, error: `Unknown player ${action.chosenPlayerId}.` };

  const stateWithoutCard: GameState = {
    ...state,
    agendaDeck: { ...state.agendaDeck, lawsInPlay: state.agendaDeck.lawsInPlay.filter((l) => l.agendaId !== "committee_formation") },
    pendingCommitteeFormationDecision: undefined,
  };
  const resolved = finalizeAgendaResolution(stateWithoutCard, rules, pending.agendaId, action.chosenPlayerId);
  return { ok: true, state: resolved.state, events: resolved.events };
}

/** The owner declines to use Committee Formation this time — the normal vote for the pending agenda opens as usual. */
export function skipCommitteeFormation(
  state: GameState,
  action: { type: "SKIP_COMMITTEE_FORMATION"; playerId: PlayerId },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingCommitteeFormationDecision;
  if (!pending || pending.ownerId !== action.playerId) {
    return { ok: false, error: "This player has no pending Committee Formation decision right now." };
  }
  const stateWithoutPending: GameState = {
    ...state,
    pendingCommitteeFormationDecision: undefined,
    agendaDeck: { ...state.agendaDeck, deckIds: [pending.agendaId, ...state.agendaDeck.deckIds] },
  };
  const revealed = revealAgenda(stateWithoutPending, rules);
  if (!revealed.ok) return revealed;
  return { ok: true, state: revealed.state, events: revealed.events };
}

// ---------------------------------------------------------------------
// RR "Anti-Intellectual Revolution"
//  - "for" (ongoing law): after a player researches a technology, they
//    must destroy 1 of their own non-fighter ships — checked from
//    phases/technology.ts's researchTechnology right after the tech is
//    added, via maybeQueueAntiIntellectualRevolutionDestruction below.
//  - "against" (one-time, at the start of the next strategy phase): each
//    player chooses and exhausts 1 planet for each technology they own —
//    queued when the agenda resolves (see phases/agendaPhase.ts's
//    resolveAgendaVote), resolved here.
// ---------------------------------------------------------------------

/** Called by researchTechnology right after a tech is successfully added — queues the mandatory (no skip) ship-destruction choice if the "for" law is currently active. */
export function maybeQueueAntiIntellectualRevolutionDestruction(state: GameState, playerId: PlayerId): GameState {
  if (!isLawActiveWithOutcome(state, "anti_intellectual_revolution" as AgendaId, "for")) return state;
  const already = state.pendingAntiIntellectualRevolutionDestruction ?? [];
  if (already.includes(playerId)) return state;
  return { ...state, pendingAntiIntellectualRevolutionDestruction: [...already, playerId] };
}

/** The player's own choice of WHICH non-fighter ship (anywhere on the board) to destroy — mandatory, no skip, same "real choice" pattern as everywhere else in this project. */
export function destroyShipForAntiIntellectualRevolution(
  state: GameState,
  action: { type: "DESTROY_SHIP_FOR_ANTI_INTELLECTUAL_REVOLUTION"; playerId: PlayerId; systemId: SystemId; unitType: UnitType },
): ActionResult {
  if (!(state.pendingAntiIntellectualRevolutionDestruction ?? []).includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Anti-Intellectual Revolution destruction owed right now." };
  }
  if (!SHIP_TYPES.includes(action.unitType) || action.unitType === "fighter") {
    return { ok: false, error: 'RR "Anti-Intellectual Revolution": must destroy a non-fighter ship.' };
  }
  const system = state.systems[action.systemId];
  const stack = (system?.spaceUnitsByPlayer[action.playerId] ?? []).find((s) => s.unitType === action.unitType);
  if (!stack || stack.count <= 0) {
    return { ok: false, error: `This player has no ${action.unitType} in ${action.systemId}.` };
  }

  const updatedStacks = (system.spaceUnitsByPlayer[action.playerId] ?? [])
    .map((s) => (s.unitType === action.unitType ? { ...s, count: s.count - 1 } : s))
    .filter((s) => s.count > 0);
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedStacks } };

  const nextState: GameState = {
    ...state,
    systems: { ...state.systems, [action.systemId]: updatedSystem },
    pendingAntiIntellectualRevolutionDestruction: (state.pendingAntiIntellectualRevolutionDestruction ?? []).filter((id) => id !== action.playerId),
  };
  return { ok: true, state: nextState, events: [{ type: "UNITS_DESTROYED", playerId: action.playerId, systemId: action.systemId, unitType: action.unitType, count: 1 }] };
}

/** The player's own choice of WHICH planets to exhaust (must be exactly as many as technologies they currently own) for the one-time "against" effect. Once every listed player has submitted, this hands off to the strategy phase (mirroring the same "agenda phase done" transition resolveAgendaVote itself would have run, had this not been deferred). */
export function exhaustPlanetsForAntiIntellectualRevolution(
  state: GameState,
  action: { type: "EXHAUST_PLANETS_FOR_ANTI_INTELLECTUAL_REVOLUTION"; playerId: PlayerId; planetIds: PlanetId[] },
  rules: RuleData,
): ActionResult {
  if (!(state.pendingAntiIntellectualRevolutionExhaustion ?? []).includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Anti-Intellectual Revolution exhaustion owed right now." };
  }
  const player = state.players[action.playerId];
  const required = player.technologies.length;
  if (action.planetIds.length !== required) {
    return { ok: false, error: `RR "Anti-Intellectual Revolution": must exhaust exactly ${required} planet(s) (1 per technology owned), got ${action.planetIds.length}.` };
  }
  if (new Set(action.planetIds).size !== action.planetIds.length) {
    return { ok: false, error: "Can't exhaust the same planet twice." };
  }

  let nextState: GameState = state;
  for (const planetId of action.planetIds) {
    const entry = Object.entries(nextState.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
    const planet = entry?.[1].planets.find((p) => p.planetId === planetId);
    if (!planet || planet.controllerId !== action.playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };
    if (planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };
    const [systemId, system] = entry!;
    nextState = {
      ...nextState,
      systems: { ...nextState.systems, [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? { ...p, exhausted: true } : p)) } },
    };
  }

  const remaining = (nextState.pendingAntiIntellectualRevolutionExhaustion ?? []).filter((id) => id !== action.playerId);
  nextState = { ...nextState, pendingAntiIntellectualRevolutionExhaustion: remaining };

  const events: GameEvent[] = [];
  if (remaining.length === 0) {
    // Every player's submitted — the agenda phase's own deferred transition (see resolveAgendaVote) can finally happen.
    nextState = startNewRound(nextState, rules);
    events.push({ type: "PHASE_CHANGED", from: "agenda", to: "strategy", round: nextState.round });
    events.push({ type: "ROUND_STARTED", round: nextState.round });
  }

  return { ok: true, state: nextState, events };
}

/** RR "Homeland Defense Act" ("against"): the player's own choice of WHICH of their own PDS to destroy — mandatory, no skip, same "real choice" pattern as everywhere else in this project. */
export function destroyPdsForHomelandDefenseAct(
  state: GameState,
  action: { type: "DESTROY_PDS_FOR_HOMELAND_DEFENSE_ACT"; playerId: PlayerId; planetId: PlanetId },
): ActionResult {
  if (!(state.pendingHomelandDefenseActDestruction ?? []).includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Homeland Defense Act destruction owed right now." };
  }
  const entry = Object.entries(state.systems).find(([, s]) => s.planets.some((p) => p.planetId === action.planetId));
  if (!entry) return { ok: false, error: `No planet ${action.planetId}.` };
  const [systemId, system] = entry;
  const planet = system.planets.find((p) => p.planetId === action.planetId)!;
  const stack = (planet.unitsByPlayer[action.playerId] ?? []).find((s) => s.unitType === "pds");
  if (!stack || stack.count <= 0) return { ok: false, error: `This player has no PDS on ${action.planetId}.` };

  const updatedStacks = (planet.unitsByPlayer[action.playerId] ?? []).map((s) => (s.unitType === "pds" ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [action.playerId]: updatedStacks } };
  const updatedSystem: SystemState = { ...system, planets: system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };

  const nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: updatedSystem },
    pendingHomelandDefenseActDestruction: (state.pendingHomelandDefenseActDestruction ?? []).filter((id) => id !== action.playerId),
  };
  return { ok: true, state: nextState, events: [{ type: "UNITS_DESTROYED", playerId: action.playerId, systemId: systemId as SystemId, planetId: action.planetId, unitType: "pds", count: 1 }] };
}

/** RR "Executive Sanctions" ("against"): discards 1 action card from this player's hand — WHICH card is supplied by the caller (the trusted context's own random pick, same convention as pre-rolled dice elsewhere in this project), not a genuine player choice. */
export function discardRandomActionCardForExecutiveSanctions(
  state: GameState,
  action: { type: "RANDOM_DISCARD_FOR_EXECUTIVE_SANCTIONS"; playerId: PlayerId; cardId: import("../types/ids").ActionCardId },
): ActionResult {
  if (!(state.pendingExecutiveSanctionsRandomDiscard ?? []).includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Executive Sanctions discard owed right now." };
  }
  const player = state.players[action.playerId];
  if (!player.actionCards.includes(action.cardId)) return { ok: false, error: "This player doesn't hold that action card." };

  const updatedPlayer: Player = { ...player, actionCards: player.actionCards.filter((c) => c !== action.cardId) };
  const nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer },
    actionCardDiscardPile: [...(state.actionCardDiscardPile ?? []), action.cardId],
    pendingExecutiveSanctionsRandomDiscard: (state.pendingExecutiveSanctionsRandomDiscard ?? []).filter((id) => id !== action.playerId),
  };
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_DISCARDED", playerId: action.playerId, cardId: action.cardId }] };
}

/**
 * RR "Articles of War" ("for") + RR "Publicize Weapon Schematics" ("for"):
 * both strip a specific ability from a specific unit type while active —
 * mechs lose everything except Sustain Damage; war suns lose Sustain
 * Damage specifically — so this one wrapper around getUnitStats' own
 * `abilities` handles both, since they touch the exact same underlying
 * data. Every caller that reads a unit's CURRENT abilities (not its
 * cost/combat/move/capacity, which neither agenda touches) should go
 * through this instead of reading getUnitStats(...).abilities directly.
 */
export function getEffectiveUnitAbilities(
  state: GameState,
  rules: RuleData,
  factionId: import("../types/ids").FactionId,
  unitType: UnitType,
  ownedUpgradeIds: import("../types/ids").UnitUpgradeId[],
): UnitAbility[] {
  const stats = getUnitStats(rules, factionId, unitType, ownedUpgradeIds);
  let abilities = stats?.abilities ?? [];

  if (unitType === "mech" && isLawActiveWithOutcome(state, "articles_of_war" as AgendaId, "for")) {
    abilities = abilities.filter((a) => a === "sustainDamage");
  }
  if (unitType === "war_sun" && isLawActiveWithOutcome(state, "publicize_weapon_schematics" as AgendaId, "for")) {
    abilities = abilities.filter((a) => a !== "sustainDamage");
  }

  return abilities;
}

/** RR "Minister of Commerce": after `replenishedPlayerId` replenishes their commodities (Trade strategy card, primary or secondary), if they own this card, they gain 1 trade good per player who's currently their neighbor. A no-op if nobody owns the card, or the replenished player isn't its owner. */
export function maybeApplyMinisterOfCommerce(state: GameState, rules: RuleData, replenishedPlayerId: PlayerId): GameState {
  const ownerId = getLawOwner(state, "minister_of_commerce" as AgendaId);
  if (ownerId !== replenishedPlayerId) return state;
  const neighborCount = Object.keys(state.players).filter((id) => id !== ownerId && arePlayersNeighbors(state, ownerId, id as PlayerId)).length;
  if (neighborCount === 0) return state;
  const owner = state.players[ownerId];
  return { ...state, players: { ...state.players, [ownerId]: { ...owner, tradeGoods: owner.tradeGoods + neighborCount } } };
}
