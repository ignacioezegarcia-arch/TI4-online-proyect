import { GameState, Player, PlanetState, SystemState, PendingTacticalAction } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, AgendaId, ObjectiveId } from "../types/ids";
import { UnitType, UnitAbility, SHIP_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { startNewRound, maybeAdvanceActivePlayer } from "./actionPhase";
import { arePlayersNeighbors } from "../rules/adjacency";
import { placeGenericGammaWormholeToken } from "../rules/wormholeTokens";
import { buildGroundCombatEntries, buildSpaceCombatEntries } from "../rules/combat";
import { fisherYatesShuffle } from "../setup/mapGeneration";
import { finalizeAgendaResolution, revealAgenda } from "./agendaPhase";
import { commandTokensAvailableInReinforcements, placeCommandTokenFromReinforcements } from "../rules/reinforcements";

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

  // RR "Fleet Regulations" ("against"): each player gains 1 command token from their reinforcements into their fleet pool — skipped (not an error) for anyone who's already at their 16-token total supply cap (rules/reinforcements.ts).
  if (agendaId === "fleet_regulations" && winner === "against") {
    for (const p of Object.values(nextState.players)) {
      if (commandTokensAvailableInReinforcements(p) < 1) continue;
      nextState = { ...nextState, players: { ...nextState.players, [p.id]: { ...p, commandTokens: { ...p.commandTokens, fleet: p.commandTokens.fleet + 1 } } } };
    }
  }

  // RR "Shared Research" ("against"): each player places a command token from their reinforcements in their home system. Sourced from reinforcements, falling back to an existing pool if those are exhausted (rules/reinforcements.ts's own placeCommandTokenFromReinforcements — the official ruling on what happens then) — NOT gated on the tactic pool specifically, which was this file's own earlier (incorrect) assumption before reinforcements were tracked for real. Skipped only if this player truly has 0 tokens anywhere, or already has one in their home system (RR 3.3-style).
  if (agendaId === "shared_research" && winner === "against") {
    for (const p of Object.values(nextState.players)) {
      const homeSystemId = rules.homeSystemByFaction[p.factionId] as SystemId | undefined;
      if (!homeSystemId || p.commandTokens.onBoard.includes(homeSystemId)) continue;
      const placed = placeCommandTokenFromReinforcements(p, homeSystemId);
      if (placed.ok) nextState = { ...nextState, players: { ...nextState.players, [p.id]: placed.player } };
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

  // RR "Nexus Sovereignty" ("against"): place a gamma wormhole token in the Mecatol Rex system. Uses ONE of the 3 shared generic gamma tokens — see rules/wormholeTokens.ts's own placeGenericGammaWormholeToken.
  if (agendaId === "nexus_sovereignty" && winner === "against") {
    const placed = placeGenericGammaWormholeToken(nextState, rules.mecatolSystemId as SystemId);
    if (placed.ok) nextState = placed.state;
  }

  // RR "Publicize Weapon Schematics" ("against"): each player who owns a war sun technology discards their entire action-card hand.
  if (agendaId === "publicize_weapon_schematics" && winner === "against") {
    for (const p of Object.values(nextState.players)) {
      const ownsWarSun = p.unitUpgrades.some((id) => rules.unitUpgrades[id]?.unitType === "war_sun");
      if (ownsWarSun) nextState = { ...nextState, players: { ...nextState.players, [p.id]: { ...p, actionCards: [] } } };
    }
  }

  // RR "attach" agendas (Core Mining, Demilitarized Zone, Holy Planet of
  // Ixth, the 4 Research Team, Senate Sanctuary, Terraforming Initiative):
  // confirmed via data/agendas.json's own `isAttachment` flag — ALL 8
  // share the exact same first step (attach this card to whichever planet
  // was elected), checked generically here instead of listing every id.
  // Each one's own FURTHER one-time effect (if any) still needs its own
  // specific handling below, since those genuinely differ card to card —
  // numeric resource/influence bonuses are read back out in
  // rules/planetStats.ts's getEffectivePlanetStats; Research Team's own
  // ongoing "ignore 1 prerequisite" ability is checked generically in
  // phases/technology.ts via this same agenda's own `attachTechColor`.
  if (rules.agendas[agendaId]?.isAttachment && winner) {
    const planetId = winner as PlanetId;
    const entry = Object.entries(nextState.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
    if (entry) {
      const [systemId, system] = entry;
      const planet = system.planets.find((p) => p.planetId === planetId)!;
      let updatedPlanet: PlanetState = { ...planet, attachmentIds: [...planet.attachmentIds, agendaId] };

      // RR "Core Mining": destroy 1 infantry on the planet (any owner's — the card's own text doesn't specify whose, if more than one player somehow has infantry there, this takes the first found).
      if (agendaId === "core_mining") {
        const infantryOwnerId = Object.entries(updatedPlanet.unitsByPlayer).find(([, stacks]) => (stacks ?? []).some((s) => s.unitType === "infantry" && s.count > 0))?.[0] as PlayerId | undefined;
        if (infantryOwnerId) {
          const stacks = (updatedPlanet.unitsByPlayer[infantryOwnerId] ?? []).map((s) => (s.unitType === "infantry" ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
          updatedPlanet = { ...updatedPlanet, unitsByPlayer: { ...updatedPlanet.unitsByPlayer, [infantryOwnerId]: stacks } };
        }
      }

      // RR "Demilitarized Zone": destroy EVERY unit (any player's) currently there. Its OWN ongoing restriction ("units cannot land, be produced, or be placed on this planet") is enforced separately — see phases/invasion.ts's commitGroundForces, phases/production.ts's executeProduction, and phases/technologyAbilities.ts's useTransitDiodes (this project's own 3 "place a ground force on a planet" call sites).
      if (agendaId === "demilitarized_zone") {
        updatedPlanet = { ...updatedPlanet, unitsByPlayer: {} };
      }

      nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } } };

      // RR "Holy Planet of Ixth": the planet's OWNER (controller, if any — it might be uncontrolled/contested at election time) gains 1 VP right away, in addition to its own ongoing "gain/lose 1 VP on control change" rule (see phases/invasion.ts's setPlanetController).
      if (agendaId === "holy_planet_of_ixth" && updatedPlanet.controllerId) {
        const owner = nextState.players[updatedPlanet.controllerId];
        if (owner) {
          nextState = { ...nextState, players: { ...nextState.players, [updatedPlanet.controllerId]: { ...owner, victoryPoints: { ...owner.victoryPoints, current: owner.victoryPoints.current + 1 } } } };
        }
      }
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

/** RR "Demilitarized Zone": is this planet currently under this agenda's own permanent restriction (units cannot land, be produced, or be placed there)? Checked at every "place a unit on a planet" call site this project has. */
export function isDemilitarizedZone(planet: { attachmentIds: string[] }): boolean {
  // 2 SEPARATE sources of this same restriction, with 2 DIFFERENT
  // underlying ids: the agenda "Demilitarized Zone" (data/agendas.json's
  // own id, "demilitarized_zone") and the CULTURAL exploration card of
  // the same name (data/explorationCards.json's own id,
  // "demilitarized_zone_explore" — deliberately suffixed to avoid
  // colliding with the agenda's own id when both exist as separate
  // entries in rules.explorationCards/rules lookups). Previously only
  // the agenda's own id was checked here — a planet that got this
  // restriction via the EXPLORATION CARD specifically was silently never
  // actually restricted at all.
  return planet.attachmentIds.includes("demilitarized_zone") || planet.attachmentIds.includes("demilitarized_zone_explore");
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
  if (state.pendingPriorityWindow?.kind === "agenda_revealed") {
    return { ok: false, error: "RR 1.20: every player must be given (and decline) their chance to play a reveal-reaction card before this decision can be made." };
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
  if (state.pendingPriorityWindow?.kind === "agenda_revealed") {
    return { ok: false, error: "RR 1.20: every player must be given (and decline) their chance to play a reveal-reaction card before this decision can be made." };
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

/**
 * RR 45.4/61.21: a player can have at most 3 TOTAL secret objectives —
 * counting both unscored (in hand) and already-scored ones together.
 * Call this right after ANY action grants a player a new secret objective
 * (Imperial's primary/secondary, Search Warrant, Archived Secret) — if
 * they're now over the limit, queues their own choice of which UNSCORED
 * one to return to the deck (see returnSecretObjective below). Shared
 * here (not duplicated per grant site) since all 4 current sources of
 * secret objectives already import from this file.
 */
export function maybeQueueSecretObjectiveLimit(state: GameState, rules: RuleData, playerId: PlayerId): GameState {
  const player = state.players[playerId];
  if (!player) return state;
  const scoredSecretCount = player.victoryPoints.scoredObjectiveIds.filter((id) => rules.objectives[id]?.kind === "secret").length;
  const total = player.secretObjectives.length + scoredSecretCount;
  if (total <= 3) return state;
  const already = state.pendingSecretObjectiveReturn ?? [];
  if (already.includes(playerId)) return state;
  return { ...state, pendingSecretObjectiveReturn: [...already, playerId] };
}

/** RR 45.4: the player's own choice of which UNSCORED secret objective to return to the deck (shuffled back in), now that they're over the 3-total limit. */
export function returnSecretObjective(
  state: GameState,
  action: { type: "RETURN_SECRET_OBJECTIVE"; playerId: PlayerId; objectiveId: ObjectiveId },
): ActionResult {
  if (!(state.pendingSecretObjectiveReturn ?? []).includes(action.playerId)) {
    return { ok: false, error: "This player has no pending secret-objective-limit return owed right now." };
  }
  const player = state.players[action.playerId];
  if (!player.secretObjectives.includes(action.objectiveId)) {
    return { ok: false, error: "This player doesn't hold that secret objective unscored." };
  }
  const updatedPlayer: Player = { ...player, secretObjectives: player.secretObjectives.filter((id) => id !== action.objectiveId) };
  const nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer },
    secretObjectiveDeck: fisherYatesShuffle([...(state.secretObjectiveDeck ?? []), action.objectiveId], Math.random),
    pendingSecretObjectiveReturn: (state.pendingSecretObjectiveReturn ?? []).filter((id) => id !== action.playerId),
  };
  return { ok: true, state: nextState, events: [] };
}

/** RR "Minister of Commerce": after `replenishedPlayerId` replenishes their commodities (Trade strategy card, primary or secondary), if they own this card, they gain 1 trade good per player who's currently their neighbor. A no-op if nobody owns the card, or the replenished player isn't its owner. */
export function maybeApplyMinisterOfCommerce(state: GameState, rules: RuleData, replenishedPlayerId: PlayerId): GameState {
  const ownerId = getLawOwner(state, "minister_of_commerce" as AgendaId);
  if (ownerId !== replenishedPlayerId) return state;
  const neighborCount = Object.keys(state.players).filter((id) => id !== ownerId && arePlayersNeighbors(state, ownerId, id as PlayerId, rules)).length;
  if (neighborCount === 0) return state;
  const owner = state.players[ownerId];
  return { ...state, players: { ...state.players, [ownerId]: { ...owner, tradeGoods: owner.tradeGoods + neighborCount } } };
}

/** RR "Imperial Arbiter": the owner's own choice, offered once the strategy phase ends — discard this card to swap one of THEIR strategy cards with one of another player's. */
export function useImperialArbiter(
  state: GameState,
  action: { type: "USE_IMPERIAL_ARBITER"; playerId: PlayerId; ownCardId: import("../types/ids").StrategyCardId; otherPlayerId: PlayerId; otherCardId: import("../types/ids").StrategyCardId },
): ActionResult {
  const ownerId = getLawOwner(state, "imperial_arbiter" as AgendaId);
  if (ownerId !== action.playerId) return { ok: false, error: "This player doesn't own Imperial Arbiter." };
  if (action.otherPlayerId === action.playerId) return { ok: false, error: "RR \"Imperial Arbiter\": must swap with ANOTHER player." };

  const owner = state.players[action.playerId];
  const other = state.players[action.otherPlayerId];
  if (!other) return { ok: false, error: `Unknown player ${action.otherPlayerId}.` };
  const ownEntry = owner.strategyCards.find((c) => c.cardId === action.ownCardId);
  const otherEntry = other.strategyCards.find((c) => c.cardId === action.otherCardId);
  if (!ownEntry) return { ok: false, error: "This player doesn't hold that strategy card." };
  if (!otherEntry) return { ok: false, error: "The other player doesn't hold that strategy card." };

  const updatedOwner: Player = { ...owner, strategyCards: owner.strategyCards.map((c) => (c.cardId === action.ownCardId ? otherEntry : c)) };
  const updatedOther: Player = { ...other, strategyCards: other.strategyCards.map((c) => (c.cardId === action.otherCardId ? ownEntry : c)) };

  const nextState: GameState = {
    ...state,
    agendaDeck: { ...state.agendaDeck, lawsInPlay: state.agendaDeck.lawsInPlay.filter((l) => l.agendaId !== "imperial_arbiter") },
    players: { ...state.players, [action.playerId]: updatedOwner, [action.otherPlayerId]: updatedOther },
  };
  return { ok: true, state: nextState, events: [] };
}

/**
 * RR "Minister of Peace": the owner's own choice, offered right after the
 * active player activates a system containing 1+ of ANY other player's
 * units (not necessarily the owner's own) — discard this card to
 * immediately end the active player's turn. Simplification, flagged: only
 * offered before any combat/invasion has actually started this tactical
 * action (i.e. still at "activation" or "movement") — ending a turn
 * cleanly mid-combat, with hits already partially resolved, is a much
 * messier state to unwind safely, and RR's own text ("immediately end the
 * active player's turn") is most naturally read as reacting right when
 * the system is activated anyway, not deep into an already-unfolding fight.
 */
export function useMinisterOfPeace(
  state: GameState,
  action: { type: "USE_MINISTER_OF_PEACE"; playerId: PlayerId },
): ActionResult {
  const ownerId = getLawOwner(state, "minister_of_peace" as AgendaId);
  if (ownerId !== action.playerId) return { ok: false, error: "This player doesn't own Minister of Peace." };

  const pending = state.pendingTacticalAction;
  if (!pending || (pending.step !== "activation" && pending.step !== "movement")) {
    return { ok: false, error: 'RR "Minister of Peace": no eligible tactical action to end right now.' };
  }
  const system = state.systems[pending.systemId];
  const hasOtherPlayerUnits =
    Object.entries(system?.spaceUnitsByPlayer ?? {}).some(([pid, stacks]) => pid !== pending.playerId && (stacks ?? []).some((s) => s.count > 0)) ||
    (system?.planets ?? []).some((p) => Object.entries(p.unitsByPlayer).some(([pid, stacks]) => pid !== pending.playerId && (stacks ?? []).some((s) => s.count > 0)));
  if (!hasOtherPlayerUnits) {
    return { ok: false, error: 'RR "Minister of Peace": the activated system has no other player\'s units in it.' };
  }

  const stateWithoutCard: GameState = {
    ...state,
    agendaDeck: { ...state.agendaDeck, lawsInPlay: state.agendaDeck.lawsInPlay.filter((l) => l.agendaId !== "minister_of_peace") },
    pendingTacticalAction: null,
  };
  const nextState = maybeAdvanceActivePlayer(stateWithoutCard, pending.playerId);
  return { ok: true, state: nextState, events: [] };
}

/** RR "Minister of War": the owner's own choice, after performing an action — discard this card to remove 1 of their own command tokens from the board back into their tactic pool (the pool spent by RR 78's own "activate a system"), then take 1 additional action (they stay the active player, same as Fleet Logistics's own extra-action allowance). */
export function useMinisterOfWar(
  state: GameState,
  action: { type: "USE_MINISTER_OF_WAR"; playerId: PlayerId; systemId: SystemId },
): ActionResult {
  const ownerId = getLawOwner(state, "minister_of_war" as AgendaId);
  if (ownerId !== action.playerId) return { ok: false, error: "This player doesn't own Minister of War." };
  if (state.phase !== "action" || state.activePlayerId !== action.playerId) {
    return { ok: false, error: 'RR "Minister of War": only usable on this player\'s own turn during the action phase.' };
  }
  const player = state.players[action.playerId];
  if (!player.commandTokens.onBoard.includes(action.systemId)) {
    return { ok: false, error: "This player has no command token in that system." };
  }

  const updatedPlayer: Player = {
    ...player,
    commandTokens: { ...player.commandTokens, tactic: player.commandTokens.tactic + 1, onBoard: player.commandTokens.onBoard.filter((id) => id !== action.systemId) },
  };
  const nextState: GameState = {
    ...state,
    agendaDeck: { ...state.agendaDeck, lawsInPlay: state.agendaDeck.lawsInPlay.filter((l) => l.agendaId !== "minister_of_war") },
    players: { ...state.players, [action.playerId]: updatedPlayer },
    // Stays the active player, free to take 1 more action — same "extra action" shape as Fleet Logistics elsewhere in this project.
    activePlayerActionsTaken: 0,
  };
  return { ok: true, state: nextState, events: [] };
}

/**
 * RR "The Crown of Thalnos": the owner's own choice of how many of THEIR OWN missed dice, per unit type, to reroll — whichever of the supplied `newRolls` still miss destroys that many units of that type, mandatory. Only rerolling a subset (or none at all, via skipCrownOfThalnosReroll) is fully legal — the owner never has to risk a unit they'd rather leave alone.
 *
 * KNOWN SIMPLIFICATION (yjmrobert.com/tirules/components/c_relics):
 * "If a unit rolls multiple combat dice, it will not be destroyed if it
 * produces at least one hit from its original roll... roll those
 * unit's dice separately from any other combat dice." This project's own
 * missed-dice tracking is aggregated per UNIT TYPE (a flat count), not
 * per individual physical unit — for unit types that only ever roll 1
 * die each (the overwhelming majority), this distinction never matters
 * (1 missed die = 1 unit at risk, exactly as here). For a multi-die unit
 * type (Destroyer II/III, War Sun, some upgraded Dreadnoughts), this
 * project's own count of "still-missed rerolled dice" could destroy MORE
 * units than the real rule would if 2 misses actually belonged to the
 * SAME physical unit (which only needs ONE hit across all its own dice
 * to survive) rather than 2 different ones — properly fixing this needs
 * per-individual-unit dice tracking through the whole combat-round
 * pipeline (buildGroundCombatEntries/buildSpaceCombatEntries currently
 * only ever build ONE entry per (player, unit type) pair), which is a
 * deeper architectural change than this pass makes. Flagged rather than
 * silently assumed correct.
 */
export function useCrownOfThalnosReroll(
  state: GameState,
  action: { type: "USE_CROWN_OF_THALNOS_REROLL"; playerId: PlayerId; rerolls: { unitType: UnitType; newRolls: number[] }[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || !(pending.crownOfThalnosPendingPlayers ?? []).includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Crown of Thalnos reroll decision right now." };
  }
  const missedByType = pending.crownOfThalnosMissedDiceByPlayer?.[action.playerId] ?? {};
  const player = state.players[action.playerId];

  // Recompute this player's OWN current hitOn per type, from the SAME
  // entry-building logic the original round used — a reroll still has to
  // beat the unit's normal (post-modifier) threshold, nothing about
  // Crown of Thalnos changes what counts as a hit.
  const isGroundCombat = pending.step === "invasion";
  const systemOrPlanetEntries = isGroundCombat
    ? buildGroundCombatEntries(state, rules, state.systems[pending.systemId].planets.find((p) => p.planetId === pending.currentInvasionPlanetId)!, pending.groundCombatAttackerBlockedThisRound ? pending.playerId : undefined)
    : buildSpaceCombatEntries(state, rules, pending.systemId, pending.playerId);
  const hitOnByType = new Map<UnitType, number>();
  for (const e of systemOrPlanetEntries) {
    if (e.playerId === action.playerId && e.unitType) hitOnByType.set(e.unitType, e.hitOn);
  }

  let unitsToDestroy: { unitType: UnitType; count: number }[] = [];
  for (const { unitType, newRolls } of action.rerolls) {
    const availableMisses = missedByType[unitType] ?? 0;
    if (newRolls.length > availableMisses) {
      return { ok: false, error: `RR "The Crown of Thalnos": tried to reroll ${newRolls.length} ${unitType} dice, only ${availableMisses} missed this round.` };
    }
    const hitOn = hitOnByType.get(unitType);
    if (hitOn === undefined) return { ok: false, error: `This player has no ${unitType} in this combat.` };
    const stillMissed = newRolls.filter((r) => r < hitOn).length;
    if (stillMissed > 0) unitsToDestroy.push({ unitType, count: stillMissed });
  }

  const systemId = pending.systemId;
  const events: GameEvent[] = [];
  let nextState = state;

  if (isGroundCombat) {
    const planetId = pending.currentInvasionPlanetId!;
    const planet = nextState.systems[systemId].planets.find((p) => p.planetId === planetId)!;
    let stacks = (planet.unitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
    for (const { unitType, count } of unitsToDestroy) {
      const stack = stacks.find((s) => s.unitType === unitType);
      if (stack) {
        const removed = Math.min(count, stack.count);
        stack.count -= removed;
        if (stack.damagedCount > stack.count) stack.damagedCount = stack.count;
        events.push({ type: "UNITS_DESTROYED", playerId: action.playerId, systemId, planetId, unitType, count: removed });
      }
    }
    stacks = stacks.filter((s) => s.count > 0);
    const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [action.playerId]: stacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...nextState.systems[systemId], planets: nextState.systems[systemId].planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } } };
  } else {
    const system = nextState.systems[systemId];
    let stacks = (system.spaceUnitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
    for (const { unitType, count } of unitsToDestroy) {
      const stack = stacks.find((s) => s.unitType === unitType);
      if (stack) {
        const removed = Math.min(count, stack.count);
        stack.count -= removed;
        if (stack.damagedCount > stack.count) stack.damagedCount = stack.count;
        events.push({ type: "UNITS_DESTROYED", playerId: action.playerId, systemId, unitType, count: removed });
      }
    }
    stacks = stacks.filter((s) => s.count > 0);
    nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: stacks } } } };
  }

  const remainingPending = (pending.crownOfThalnosPendingPlayers ?? []).filter((id) => id !== action.playerId);
  const remainingMissed = { ...nextState.pendingTacticalAction?.crownOfThalnosMissedDiceByPlayer };
  delete remainingMissed[action.playerId];
  nextState = {
    ...nextState,
    players: { ...nextState.players, [action.playerId]: player },
    pendingTacticalAction: { ...nextState.pendingTacticalAction!, crownOfThalnosPendingPlayers: remainingPending, crownOfThalnosMissedDiceByPlayer: remainingMissed },
  };

  return { ok: true, state: nextState, events };
}

/** RR "The Crown of Thalnos": the owner declines to reroll anything this round. */
export function skipCrownOfThalnosReroll(state: GameState, action: { type: "SKIP_CROWN_OF_THALNOS_REROLL"; playerId: PlayerId }): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || !(pending.crownOfThalnosPendingPlayers ?? []).includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Crown of Thalnos reroll decision right now." };
  }
  const remainingPending = pending.crownOfThalnosPendingPlayers!.filter((id) => id !== action.playerId);
  const remainingMissed = { ...pending.crownOfThalnosMissedDiceByPlayer };
  delete remainingMissed[action.playerId];
  return {
    ok: true,
    state: { ...state, pendingTacticalAction: { ...pending, crownOfThalnosPendingPlayers: remainingPending, crownOfThalnosMissedDiceByPlayer: remainingMissed } },
    events: [],
  };
}
