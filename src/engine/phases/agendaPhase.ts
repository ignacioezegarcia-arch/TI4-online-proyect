import { GameState, Player, PendingAgendaVote } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, AgendaId, PlanetId, asTechId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { startNewRound } from "./actionPhase";
import { applyAgendaResolutionSideEffects, isLawActiveWithOutcome, maybeQueueSecretObjectiveLimit } from "./agendaEffects";
import { applyDirectiveResolutionSideEffects } from "./directiveEffects";

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

export function revealAgenda(state: GameState, rules: RuleData): ActionResult {
  // RR "Covert Legislation": purely a table-visibility mechanic (the
  // speaker draws the next agenda without revealing it, reads only the
  // eligible outcomes aloud) — the actual reveal/vote/resolve mechanics
  // below are IDENTICAL either way; this engine has no concept of hiding
  // an agenda's identity from some players but not others (same "not a
  // UI-layer concern this engine models" scope cut as Search Warrant's own
  // "plays with secret objectives revealed" clause). No code path needed
  // here beyond this note.
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

  const [agendaId, ...rest] = state.agendaDeck.deckIds;

  // RR "Classified Document Leaks": confirmed, this agenda's own reveal
  // text is checked BEFORE any vote even opens — if no player has scored
  // ANY secret objective anywhere in the game yet, this card is discarded
  // outright and the next agenda is revealed instead, recursively (in the
  // rare case that next one has the same problem, or itself needs the
  // same treatment for some other reason down the line).
  if (agendaId === "classified_document_leaks" && !hasAnyScoredSecretObjective(state, rules)) {
    const stateAfterDiscard: GameState = {
      ...state,
      agendaDeck: { ...state.agendaDeck, deckIds: rest, discardIds: [...state.agendaDeck.discardIds, agendaId] },
    };
    return revealAgenda(stateAfterDiscard, rules);
  }

  // RR "Judicial Abolishment" / "Miscount Disclosed" / "New Constitution":
  // all 3 share the exact same reveal-time check — if there are currently
  // no laws in play at all, discard this card outright and reveal the next
  // agenda instead (recursively, same pattern as Classified Document
  // Leaks' own check just above).
  if ((agendaId === "judicial_abolishment" || agendaId === "miscount_disclosed" || agendaId === "new_constitution") && state.agendaDeck.lawsInPlay.length === 0) {
    const stateAfterDiscard: GameState = {
      ...state,
      agendaDeck: { ...state.agendaDeck, deckIds: rest, discardIds: [...state.agendaDeck.discardIds, agendaId] },
    };
    return revealAgenda(stateAfterDiscard, rules);
  }

  // RR "Committee Formation": confirmed, checked here — BEFORE any vote
  // opens — for every agenda whose own outcome elects a player. If
  // someone currently owns Committee Formation, they get first refusal
  // (see phases/agendaEffects.ts's useCommitteeFormation/
  // skipCommitteeFormation) instead of a normal vote opening immediately.
  if (rules.agendas[agendaId]?.elect === "Player") {
    const committeeFormationOwner = state.agendaDeck.lawsInPlay.find((l) => l.agendaId === "committee_formation" && l.ownerId !== "common");
    if (committeeFormationOwner) {
      return {
        ok: true,
        state: {
          ...state,
          agendaDeck: { ...state.agendaDeck, deckIds: rest },
          pendingCommitteeFormationDecision: { agendaId, ownerId: committeeFormationOwner.ownerId as PlayerId },
        },
        events: [{ type: "AGENDA_REVEALED", agendaId }],
      };
    }
  }

  const speakerId = state.seatOrder.find((id) => state.players[id]?.isSpeaker);
  if (!speakerId) return { ok: false, error: "No speaker set — can't determine voting order." };
  const speakerIndex = state.seatOrder.indexOf(speakerId);
  // RR "Public Execution": the elected player is barred from voting for
  // the rest of THIS agenda phase — filtered out here alongside eliminated
  // players, same shape either way.
  const bannedFromVoting = state.agendaPhaseBannedFromVoting ?? [];
  const eligibleSeatOrder = state.seatOrder.filter((id) => !state.players[id]?.eliminated && !bannedFromVoting.includes(id));
  // RR 8.2.ii: voting starts to the left of the speaker, ends with the speaker.
  const rotated = [...state.seatOrder.slice(speakerIndex + 1), ...state.seatOrder.slice(0, speakerIndex + 1)];
  const votingOrder = rotated.filter((id) => eligibleSeatOrder.includes(id));

  const pendingAgendaVote: PendingAgendaVote = { agendaId, votingOrder, nextVoterIndex: 0, votesByOutcome: {} };

  return {
    ok: true,
    state: { ...state, agendaDeck: { ...state.agendaDeck, deckIds: rest }, pendingAgendaVote },
    events: [{ type: "AGENDA_REVEALED", agendaId }],
  };
}

/** RR "Classified Document Leaks": is there at least 1 secret objective, scored by ANY player, anywhere in the current game? (Game-wide — not scoped to whoever's speaker or about to vote.) */
function hasAnyScoredSecretObjective(state: GameState, rules: RuleData): boolean {
  return Object.values(state.players).some((p) => p.victoryPoints.scoredObjectiveIds.some((id) => rules.objectives[id]?.kind === "secret"));
}

export function castVotes(
  state: GameState,
  action: {
    type: "CAST_VOTES";
    playerId: PlayerId;
    outcome: string;
    exhaustPlanetIds: PlanetId[];
    /** RR "Predictive Intelligence": exhaust that tech (if owned and readied) to cast 3 additional votes for this outcome — conditionally exhausted for real once the agenda resolves (see resolveAgendaVote), only if this outcome doesn't end up winning. */
    usePredictiveIntelligenceBonus?: boolean;
  },
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
  // RR "Representative Government" (either version, "for"): confirmed,
  // while this law is active, planets are never exhausted for votes at
  // all — every player simply casts exactly 1 vote per agenda. The PoK
  // version's own text explicitly rules out "additional votes" too (e.g.
  // Predictive Intelligence's own +3 bonus); the base version doesn't
  // restate that, but the same underlying rule (votes = 1, full stop, no
  // exhausting anything to change that) applies either way here.
  const representativeGovernment =
    isLawActiveWithOutcome(state, "representative_government" as AgendaId, "for") ||
    isLawActiveWithOutcome(state, "representative_government_pok" as AgendaId, "for");

  if (representativeGovernment) {
    if (action.exhaustPlanetIds.length > 0) {
      return { ok: false, error: 'RR "Representative Government": planets cannot be exhausted to cast votes while this law is active.' };
    }
    if (action.usePredictiveIntelligenceBonus) {
      return { ok: false, error: 'RR "Representative Government": additional votes (e.g. Predictive Intelligence\'s bonus) cannot be cast while this law is active.' };
    }
    const updatedVote: PendingAgendaVote = {
      ...pending,
      nextVoterIndex: pending.nextVoterIndex + 1,
      votesByOutcome: { ...pending.votesByOutcome, [action.outcome]: [...(pending.votesByOutcome[action.outcome] ?? []), { playerId: action.playerId, votes: 1 }] },
    };
    const nextState: GameState = { ...state, pendingAgendaVote: updatedVote };
    const events: GameEvent[] = [{ type: "VOTES_CAST", playerId: action.playerId, outcome: action.outcome, votes: 1 }];
    if (updatedVote.nextVoterIndex >= updatedVote.votingOrder.length) {
      const resolved = resolveAgendaVote(nextState, rules);
      return { ok: true, state: resolved.state, events: [...events, ...resolved.events] };
    }
    return { ok: true, state: nextState, events };
  }

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

  let predictiveIntelligenceBonusUsedBy = pending.predictiveIntelligenceBonusUsedBy;
  if (action.usePredictiveIntelligenceBonus) {
    const techId = asTechId("predictive_intelligence");
    if (!player.technologies.includes(techId)) return { ok: false, error: "This player doesn't own Predictive Intelligence." };
    if (player.exhaustedTechnologies.includes(techId)) return { ok: false, error: "Predictive Intelligence is already exhausted." };
    votes += 3;
    predictiveIntelligenceBonusUsedBy = { ...predictiveIntelligenceBonusUsedBy, [action.playerId]: action.outcome };
  }

  const existingForOutcome = pending.votesByOutcome[action.outcome] ?? [];
  const updatedVote: PendingAgendaVote = {
    ...pending,
    nextVoterIndex: pending.nextVoterIndex + 1,
    votesByOutcome: { ...pending.votesByOutcome, [action.outcome]: [...existingForOutcome, { playerId: action.playerId, votes }] },
    predictiveIntelligenceBonusUsedBy,
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

  // RR "Predictive Intelligence": conditionally exhaust for whoever used
  // its +3-votes bonus this agenda — only if THEIR outcome did NOT win
  // (RR: "if you do, and the outcome you voted for is not resolved,
  // exhaust this card" — winning means it stays readied).
  let players = state.players;
  for (const [playerId, votedOutcome] of Object.entries(pending.predictiveIntelligenceBonusUsedBy ?? {})) {
    if (votedOutcome === winner) continue; // their outcome won — stays readied
    const p = players[playerId as PlayerId];
    const techId = asTechId("predictive_intelligence");
    if (p && !p.exhaustedTechnologies.includes(techId)) {
      players = { ...players, [playerId]: { ...p, exhaustedTechnologies: [...p.exhaustedTechnologies, techId] } };
    }
  }

  return finalizeAgendaResolution({ ...state, players, pendingAgendaVote: null }, rules, pending.agendaId, winner, pending.votesByOutcome);
}

/**
 * RR 8.4/8.5's own "given the winning outcome, apply it" tail — split out
 * from resolveAgendaVote so RR "Committee Formation"'s own direct-elect
 * (no vote at all) can share the exact same resolution logic instead of
 * faking a completed vote just to reuse it.
 */
export function finalizeAgendaResolution(
  state: GameState,
  rules: RuleData,
  agendaId: AgendaId,
  winner: string | null,
  /** Empty for a Committee-Formation-direct-elect resolution (no real vote happened) — only ever needed by side-effects that care WHO specifically voted which way (e.g. Conventions of War's "against" discards only THOSE voters' hands). */
  votesByOutcome: Record<string, { playerId: PlayerId; votes: number }[]> = {},
): { state: GameState; events: GameEvent[] } {
  const agendaType = rules.agendas[agendaId]?.type ?? "directive";
  const becameLaw = agendaType === "law" && winner !== null;
  // RR: an "elect Player" agenda's own winning outcome IS the elected
  // player's id (see Actions.ts's own note on CAST_VOTES's `outcome`
  // field) — so THAT player, not "common", owns the resulting law. Every
  // other elect type (a planet, a strategy card, etc.) still uses
  // "common", same as a plain For/Against law always has.
  const lawOwnerId = rules.agendas[agendaId]?.elect === "Player" && winner ? (winner as PlayerId) : ("common" as const);

  let nextState: GameState = {
    ...state,
    // RR "Miscount Disclosed" can re-vote a law that's ALREADY in play
    // (see this file's own note on that card) — replace its existing
    // lawsInPlay entry in that case instead of appending a duplicate one
    // for the same agendaId.
    agendaDeck: becameLaw
      ? {
          ...state.agendaDeck,
          lawsInPlay: state.agendaDeck.lawsInPlay.some((l) => l.agendaId === agendaId)
            ? state.agendaDeck.lawsInPlay.map((l) => (l.agendaId === agendaId ? { agendaId, ownerId: lawOwnerId, outcome: winner ?? undefined } : l))
            : [...state.agendaDeck.lawsInPlay, { agendaId, ownerId: lawOwnerId, outcome: winner ?? undefined }],
        }
      : { ...state.agendaDeck, discardIds: [...state.agendaDeck.discardIds, agendaId] },
    agendaPhaseAgendasResolved: (state.agendaPhaseAgendasResolved ?? 0) + 1,
    // For the "elected by an agenda" secret objective (drive_the_debate) — only the most recent resolution matters, so this just overwrites each time.
    lastResolvedAgenda: winner !== null ? { agendaId, outcome: winner } : state.lastResolvedAgenda,
  };

  // RR "Anti-Intellectual Revolution": if "against" won, queue its
  // one-time "at the start of the next strategy phase" effect — applied
  // in startAgendaPhaseFollowupEffects, right before this agenda phase
  // actually hands off to the next strategy phase (see below).
  if (agendaId === "anti_intellectual_revolution" && winner === "against") {
    nextState = {
      ...nextState,
      pendingAntiIntellectualRevolutionExhaustion: Object.keys(nextState.players) as PlayerId[],
    };
  }

  // RR "Homeland Defense Act" ("against"): queues the mandatory (no skip)
  // PDS-destruction choice for every player, resolved via
  // destroyPdsForHomelandDefenseAct — see phases/agendaEffects.ts.
  if (agendaId === "homeland_defense_act" && winner === "against") {
    nextState = {
      ...nextState,
      pendingHomelandDefenseActDestruction: Object.keys(nextState.players) as PlayerId[],
    };
  }

  // RR "Executive Sanctions" ("against"): queues the mandatory random
  // discard for every player — see phases/agendaEffects.ts's own note on
  // why this still needs a pending+action pair despite being "random".
  if (agendaId === "executive_sanctions" && winner === "against") {
    nextState = {
      ...nextState,
      pendingExecutiveSanctionsRandomDiscard: Object.values(nextState.players)
        .filter((p) => p.actionCards.length > 0)
        .map((p) => p.id),
    };
  }

  // RR "Representative Government" (either version, "against"): queues
  // those specific "against" voters' cultural-planet exhaustion for the
  // start of the next strategy phase — see phases/actionPhase.ts's
  // startNewRound for where this actually applies.
  if ((agendaId === "representative_government" || agendaId === "representative_government_pok") && winner === "against") {
    const againstVoterIds = (votesByOutcome["against"] ?? []).map((v) => v.playerId);
    nextState = {
      ...nextState,
      pendingRepresentativeGovernmentAgainstVoters: [...(nextState.pendingRepresentativeGovernmentAgainstVoters ?? []), ...againstVoterIds],
    };
  }

  // RR "Arms Reduction" ("against"): queues the "at the start of the next
  // strategy phase" tech-specialty-planet exhaustion — see
  // phases/actionPhase.ts's startNewRound for where this actually applies.
  if (agendaId === "arms_reduction" && winner === "against") {
    nextState = { ...nextState, pendingArmsReductionExhaustTechSpecialty: true };
  }

  // RR "New Constitution": if no laws are in play when revealed, this card
  // is discarded and never actually voted on (checked in revealAgenda,
  // before any vote opens) — so reaching here always means it DID resolve
  // with a real vote. "for" discards every law currently in play, then
  // queues each player's own home-system-planet exhaustion for the start
  // of the next strategy phase.
  if (agendaId === "new_constitution" && winner === "for") {
    nextState = {
      ...nextState,
      agendaDeck: { ...nextState.agendaDeck, lawsInPlay: [], discardIds: [...nextState.agendaDeck.discardIds, ...nextState.agendaDeck.lawsInPlay.map((l) => l.agendaId)] },
      pendingNewConstitutionExhaustHomeSystem: true,
    };
  }

  // RR "Classified Document Leaks": the elected outcome IS the id of the
  // scored secret objective players chose — it becomes a public objective
  // from here on, alongside the ones drawn from the normal stage I/II
  // decks. Modeling choice, flagged rather than silently assumed: it
  // doesn't slot into either predetermined stage, so it's tagged with its
  // own distinct kind ("convertedFromSecret") rather than "publicI" or
  // "publicII" — it's still just as scoreable by anyone (scoreObjective's
  // own check only cares whether an entry here is `revealed`, not which
  // kind), this only matters for anything downstream that specifically
  // counts stage I/II objectives.
  if (agendaId === "classified_document_leaks" && winner) {
    nextState = {
      ...nextState,
      objectives: [...nextState.objectives, { kind: "convertedFromSecret", objectiveId: winner as never, revealed: true }],
    };
  }

  // Every other agenda's own fully-automatic (no player choice needed) one-time resolution effect — see phases/agendaEffects.ts's own header note on why this dispatcher only covers THOSE, not ones needing a real choice.
  nextState = applyAgendaResolutionSideEffects(nextState, rules, agendaId, winner, votesByOutcome);
  // Same idea, but for DIRECTIVES specifically — see phases/directiveEffects.ts's own header note on why these live in a separate file from laws.
  nextState = applyDirectiveResolutionSideEffects(nextState, rules, agendaId, winner, votesByOutcome);

  // RR "Search Warrant": the elected player draws 2 secret objectives —
  // one-time, right when this agenda resolves. Its OTHER clause ("plays
  // with their secret objectives revealed") is a table-visibility rule,
  // not something this engine enforces anywhere (GameState doesn't model
  // per-player hidden information at all — that's a UI-layer concern, if
  // this project ever adds one).
  if (agendaId === "search_warrant" && winner) {
    const electedId = winner as PlayerId;
    const elected = nextState.players[electedId];
    if (elected) {
      const deck = nextState.secretObjectiveDeck ?? [];
      const drawn = deck.slice(0, 2);
      nextState = {
        ...nextState,
        secretObjectiveDeck: deck.slice(drawn.length),
        players: { ...nextState.players, [electedId]: { ...elected, secretObjectives: [...elected.secretObjectives, ...drawn] } },
      };
      nextState = maybeQueueSecretObjectiveLimit(nextState, rules, electedId);
    }
  }

  // RR "Political Censure": the elected player gains 1 VP right when this
  // agenda resolves. Its own "if the owner of this card LOSES this card,
  // they lose 1 VP" clause has no transfer mechanism to hook into yet —
  // nothing in this engine currently takes an "elect Player" law away
  // from its owner once resolved — flagged rather than silently assumed
  // handled.
  if (agendaId === "political_censure" && winner) {
    const electedId = winner as PlayerId;
    const elected = nextState.players[electedId];
    if (elected) {
      nextState = { ...nextState, players: { ...nextState.players, [electedId]: { ...elected, victoryPoints: { ...elected.victoryPoints, current: elected.victoryPoints.current + 1 } } } };
    }
  }

  const events: GameEvent[] = [{ type: "AGENDA_RESOLVED", agendaId, outcome: winner ?? "", becameLaw }];

  // RR "Miscount Disclosed": "vote on the elected law as if it were just
  // revealed from the top of the deck" — opens a FRESH vote on that same
  // agenda id directly (not popping the deck, since it's not actually
  // coming from there), using the exact same voting-order construction
  // revealAgenda itself uses. This re-vote's own eventual resolution
  // shares Miscount Disclosed's OWN slot for this agenda phase (RR 8's 2-
  // per-phase budget) rather than consuming a second one — pre-
  // decremented here so the inner resolution's own increment nets out to
  // "used exactly 1 slot" overall, matching how re-voting on an existing
  // law isn't "revealing a new agenda from the deck".
  if (agendaId === "miscount_disclosed" && winner) {
    const electedLawId = winner as AgendaId;
    const speakerId = nextState.seatOrder.find((id) => nextState.players[id]?.isSpeaker);
    if (speakerId) {
      const speakerIndex = nextState.seatOrder.indexOf(speakerId);
      const eligibleSeatOrder = nextState.seatOrder.filter((id) => !nextState.players[id]?.eliminated && !(nextState.agendaPhaseBannedFromVoting ?? []).includes(id));
      const rotated = [...nextState.seatOrder.slice(speakerIndex + 1), ...nextState.seatOrder.slice(0, speakerIndex + 1)];
      const votingOrder = rotated.filter((id) => eligibleSeatOrder.includes(id));
      nextState = {
        ...nextState,
        agendaPhaseAgendasResolved: Math.max(0, (nextState.agendaPhaseAgendasResolved ?? 0) - 1),
        pendingAgendaVote: { agendaId: electedLawId, votingOrder, nextVoterIndex: 0, votesByOutcome: {} },
      };
      return { state: nextState, events: [...events, { type: "AGENDA_REVEALED", agendaId: electedLawId }] };
    }
  }

  if ((nextState.agendaPhaseAgendasResolved ?? 0) < 2 && nextState.agendaDeck.deckIds.length > 0) {
    const revealed = revealAgenda(nextState, rules);
    if (revealed.ok) return { state: revealed.state, events: [...events, ...revealed.events] };
    return { state: nextState, events };
  }

  // RR "Anti-Intellectual Revolution" ("against"): its one-time "at the
  // start of the next strategy phase" effect must resolve BEFORE that
  // phase actually starts — so if any player still owes their exhaustion
  // choice, the phase transition below is deliberately deferred until
  // FINISH_ANTI_INTELLECTUAL_REVOLUTION_EXHAUSTION clears it (see
  // phases/agendaEffects.ts).
  if ((nextState.pendingAntiIntellectualRevolutionExhaustion ?? []).length > 0) {
    return { state: nextState, events };
  }

  // Agenda phase done — a new round always starts with a Strategy phase.
  // RR 8.4 "Ready Planets": every player readies EACH of their exhausted
  // planets right here, before the new round starts — confirmed, this is
  // unconditional (not just planets exhausted for voting this phase).
  // Previously missing entirely: planets exhausted to cast votes stayed
  // exhausted straight into the next strategy phase.
  nextState = {
    ...nextState,
    systems: Object.fromEntries(
      Object.entries(nextState.systems).map(([systemId, system]) => [
        systemId,
        { ...system, planets: system.planets.map((p) => (p.exhausted ? { ...p, exhausted: false } : p)) },
      ]),
    ),
  };
  nextState = startNewRound(nextState, rules);
  events.push({ type: "PHASE_CHANGED", from: "agenda", to: "strategy", round: nextState.round });
  events.push({ type: "ROUND_STARTED", round: nextState.round });
  return { state: nextState, events };
}
