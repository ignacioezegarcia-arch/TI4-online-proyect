import { GameState, Player, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, AgendaId } from "../types/ids";
import { UnitType, SHIP_TYPES } from "../types/enums";
import { startNewRound } from "./actionPhase";

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
    nextState = startNewRound(nextState);
    events.push({ type: "PHASE_CHANGED", from: "agenda", to: "strategy", round: nextState.round });
    events.push({ type: "ROUND_STARTED", round: nextState.round });
  }

  return { ok: true, state: nextState, events };
}
