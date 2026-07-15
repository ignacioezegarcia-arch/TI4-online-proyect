import { GameState, Player, PendingAgendaVote } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, AgendaId, PlanetId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { startNewRound } from "./actionPhase";

/**
 * RR 8 AGENDA PHASE. Exactly 2 agendas resolve per phase (fewer if the deck
 * runs dry). Mechanics only — see RuleData.ts's own note on `agendas`: this
 * knows whether a resolved agenda becomes a permanent law or a one-time
 * directive, but not what that law/directive actually DOES to future rules.
 * Same deliberate scope cut as objectives' condition text.
 *
 * SIMPLIFICATIONS, flagged rather than silently wrong:
 *  - Outcome legality isn't checked against the agenda's real candidates
 *    (e.g. an "elect Cultural Planet" agenda doesn't verify the chosen
 *    planet actually has the Cultural trait) — trusts the caller/UI.
 *  - Votes only come from exhausting planets for influence — trade goods
 *    as an influence substitute (RR 82) isn't wired in here (Production's
 *    resource-spend already has an equivalent gap, noted there too).
 *  - Ties: RR 8.5 has the speaker break them. Not modeled as a real choice
 *    yet — falls back to whichever tied outcome was voted for first.
 *  - A resolved law's `ownerId` is always "common" — doesn't determine
 *    whether an agenda's outcome was actually a specific elected player
 *    (e.g. Committee Formation) who should own the card instead.
 */

export function revealAgenda(state: GameState): ActionResult {
  if (state.phase !== "agenda") {
    return { ok: false, error: `RR 8.2: expected phase "agenda", got "${state.phase}".` };
  }
  if (state.pendingAgendaVote) {
    return { ok: false, error: "RR 8.2: an agenda is already being voted on." };
  }
  if ((state.agendaPhaseAgendasResolved ?? 0) >= 2) {
    return { ok: false, error: "RR 8: 2 agendas have already been resolved this phase." };
  }
  if (state.agendaDeck.deckIds.length === 0) {
    return { ok: false, error: "RR 8.2: the agenda deck is empty." };
  }

  const speakerId = state.seatOrder.find((id) => state.players[id]?.isSpeaker);
  if (!speakerId) return { ok: false, error: "No speaker set — can't determine voting order." };
  const speakerIndex = state.seatOrder.indexOf(speakerId);
  const eligibleSeatOrder = state.seatOrder.filter((id) => !state.players[id]?.eliminated);
  // RR 8.2.ii: voting starts to the left of the speaker, ends with the speaker.
  const rotated = [...state.seatOrder.slice(speakerIndex + 1), ...state.seatOrder.slice(0, speakerIndex + 1)];
  const votingOrder = rotated.filter((id) => eligibleSeatOrder.includes(id));

  const [agendaId, ...rest] = state.agendaDeck.deckIds;
  const pendingAgendaVote: PendingAgendaVote = { agendaId, votingOrder, nextVoterIndex: 0, votesByOutcome: {} };

  return {
    ok: true,
    state: { ...state, agendaDeck: { ...state.agendaDeck, deckIds: rest }, pendingAgendaVote },
    events: [{ type: "AGENDA_REVEALED", agendaId }],
  };
}

export function castVotes(
  state: GameState,
  action: { type: "CAST_VOTES"; playerId: PlayerId; outcome: string; exhaustPlanetIds: PlanetId[] },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingAgendaVote;
  if (state.phase !== "agenda" || !pending) {
    return { ok: false, error: "RR 8.3: no agenda currently being voted on." };
  }
  if (pending.votingOrder[pending.nextVoterIndex] !== action.playerId) {
    return { ok: false, error: "RR 8.2.ii: it's not this player's turn to vote." };
  }

  const player = state.players[action.playerId];
  let votes = 0;
  for (const planetId of action.exhaustPlanetIds) {
    const owningSystem = Object.values(state.systems).find((s) => s.planets.some((p) => p.planetId === planetId));
    const planet = owningSystem?.planets.find((p) => p.planetId === planetId);
    if (!planet || planet.controllerId !== action.playerId) {
      return { ok: false, error: `This player doesn't control ${planetId}.` };
    }
    if (planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };
    const planetData = rules.planets[planetId];
    if (!planetData) return { ok: false, error: `No static influence data for ${planetId}.` };
    votes += planetData.influence;
  }

  let nextState: GameState = state;
  for (const planetId of action.exhaustPlanetIds) {
    nextState = exhaustPlanet(nextState, planetId);
  }

  const existingForOutcome = pending.votesByOutcome[action.outcome] ?? [];
  const updatedVote: PendingAgendaVote = {
    ...pending,
    nextVoterIndex: pending.nextVoterIndex + 1,
    votesByOutcome: { ...pending.votesByOutcome, [action.outcome]: [...existingForOutcome, { playerId: action.playerId, votes }] },
  };
  nextState = { ...nextState, pendingAgendaVote: updatedVote };

  const events: GameEvent[] = [{ type: "VOTES_CAST", playerId: action.playerId, outcome: action.outcome, votes }];

  if (updatedVote.nextVoterIndex >= updatedVote.votingOrder.length) {
    const resolved = resolveAgendaVote(nextState, rules);
    return { ok: true, state: resolved.state, events: [...events, ...resolved.events] };
  }

  return { ok: true, state: nextState, events };
}

function exhaustPlanet(state: GameState, planetId: PlanetId): GameState {
  const entry = Object.entries(state.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
  if (!entry) return state;
  const [systemId, system] = entry;
  return {
    ...state,
    systems: {
      ...state.systems,
      [systemId]: {
        ...system,
        planets: system.planets.map((p) => (p.planetId === planetId ? { ...p, exhausted: true } : p)),
      },
    },
  };
}

/** RR 8.4/8.5: tally votes, resolve the winning outcome, then either reveal the next agenda or end the agenda phase (RR 8 always resolves exactly 2, or fewer once the deck runs dry). */
function resolveAgendaVote(state: GameState, rules: RuleData): { state: GameState; events: GameEvent[] } {
  const pending = state.pendingAgendaVote!;
  const totals = Object.entries(pending.votesByOutcome).map(([outcome, votes]) => ({
    outcome,
    total: votes.reduce((sum, v) => sum + v.votes, 0),
  }));
  const maxVotes = Math.max(0, ...totals.map((t) => t.total));
  // RR 8.5 ties are the speaker's call — not modeled as a real choice yet, see this file's own scope note.
  const winner = totals.find((t) => t.total === maxVotes)?.outcome ?? null;

  const agendaId = pending.agendaId;
  const agendaType = rules.agendas[agendaId]?.type ?? "directive";
  const becameLaw = agendaType === "law" && winner !== null;

  let nextState: GameState = {
    ...state,
    pendingAgendaVote: null,
    agendaDeck: becameLaw
      ? { ...state.agendaDeck, lawsInPlay: [...state.agendaDeck.lawsInPlay, { agendaId, ownerId: "common" as const }] }
      : { ...state.agendaDeck, discardIds: [...state.agendaDeck.discardIds, agendaId] },
    agendaPhaseAgendasResolved: (state.agendaPhaseAgendasResolved ?? 0) + 1,
    // For the "elected by an agenda" secret objective (drive_the_debate) — only the most recent resolution matters, so this just overwrites each time.
    lastResolvedAgenda: winner !== null ? { agendaId, outcome: winner } : state.lastResolvedAgenda,
  };

  const events: GameEvent[] = [{ type: "AGENDA_RESOLVED", agendaId, outcome: winner ?? "", becameLaw }];

  if ((nextState.agendaPhaseAgendasResolved ?? 0) < 2 && nextState.agendaDeck.deckIds.length > 0) {
    const revealed = revealAgenda(nextState);
    if (revealed.ok) return { state: revealed.state, events: [...events, ...revealed.events] };
    return { state: nextState, events };
  }

  // Agenda phase done — a new round always starts with a Strategy phase.
  nextState = startNewRound(nextState);
  events.push({ type: "PHASE_CHANGED", from: "agenda", to: "strategy", round: nextState.round });
  events.push({ type: "ROUND_STARTED", round: nextState.round });
  return { state: nextState, events };
}
