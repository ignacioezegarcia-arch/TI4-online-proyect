import { GameState, Player, PendingAgendaVote } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, AgendaId, PlanetId, asTechId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { startNewRound } from "./actionPhase";
import { getElderQanojVoteBonus } from "../rules/xxcha";
import { getTriadResourcesAndInfluence } from "../rules/relics";
import { hasCodex, hasThundersEdge } from "../rules/gameMode";
import { applyAgendaResolutionSideEffects, isLawActiveWithOutcome, maybeQueueSecretObjectiveLimit } from "./agendaEffects";
import { applyDirectiveResolutionSideEffects } from "./directiveEffects";
import { applyAgendaPredictionRewards } from "./actionCardEffects";
import { agendaPhaseWindowOrder } from "../rules/priorityWindow";
import { hasUnlimitedActionCardHand } from "../rules/yssaril";

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
      const order = agendaPhaseWindowOrder(state);
      return {
        ok: true,
        state: {
          ...state,
          agendaDeck: { ...state.agendaDeck, deckIds: rest },
          pendingCommitteeFormationDecision: { agendaId, ownerId: committeeFormationOwner.ownerId as PlayerId },
          pendingPriorityWindow: order.length > 0 ? { kind: "agenda_revealed", order, currentIndex: 0, consecutivePasses: 0 } : null,
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
  // RR 1.20 / FAQ: even a player who CAN'T vote (Political Censure, Public
  // Execution, ...) can still play a rider or other reveal-reaction card
  // — confirmed by the official FAQ ("Can a player who cannot vote... play
  // rider action cards? A: Yes"). So this window's own `order` is every
  // non-eliminated player, NOT filtered down to eligibleSeatOrder above.
  const priorityOrder = agendaPhaseWindowOrder(state);

  return {
    ok: true,
    state: {
      ...state,
      agendaDeck: { ...state.agendaDeck, deckIds: rest },
      pendingAgendaVote,
      pendingPriorityWindow: priorityOrder.length > 0 ? { kind: "agenda_revealed", order: priorityOrder, currentIndex: 0, consecutivePasses: 0 } : null,
      diplomaticPressureUsedThisAgenda: undefined,
      transactionsThisAgenda: undefined,
    },
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
    /** Hacan "Gila the Silvertongue" (commander, passive): spend any number of trade goods, cast 2 additional votes each — see this function's own doc comment for the full ruling. */
    useGilaTradeGoodsSpent?: number;
  },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingAgendaVote;
  if (state.phase !== "agenda" || !pending) {
    return { ok: false, error: "RR 8.3: no agenda currently being voted on." };
  }
  if (state.pendingPriorityWindow?.kind === "agenda_revealed") {
    return { ok: false, error: "RR 1.20: every player must be given (and decline) their chance to play a reveal-reaction card before voting can begin." };
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
    return openAfterYouCastVotesWindow(nextState, action.playerId, events);
  }

  let votes = 0;
  // Confirmed (yjmrobert.com/tirules/rules/r_trade_goods, r_agenda_phase;
  // twilight-imperium.fandom.com/wiki/Trade_Goods_%26_Commodities): "trade
  // goods cannot be spent to cast votes" — the ONE explicit exception to
  // trade goods otherwise substituting for resources/influence anywhere.
  // This function correctly never accepts them for that reason, not
  // because of a gap — a stale comment on this file used to claim
  // otherwise; corrected.
  for (const planetId of action.exhaustPlanetIds) {
    // RR "The Triad" (relic): same "spent as if it were a planet card" sentinel-id special-case as phases/technology.ts's own spendForCost — see that function's own doc comment for the full reasoning.
    if (planetId === ("the_triad" as never)) {
      if (!player.relics.includes("the_triad" as never)) return { ok: false, error: "This player doesn't own The Triad." };
      if ((player.exhaustedRelics ?? []).includes("the_triad" as never)) return { ok: false, error: "The Triad is already exhausted." };
      const triadValue = getTriadResourcesAndInfluence(player);
      votes += triadValue.influence;
      continue;
    }
    const owningSystem = Object.values(state.systems).find((s) => s.planets.some((p) => p.planetId === planetId));
    const planet = owningSystem?.planets.find((p) => p.planetId === planetId);
    if (!planet || planet.controllerId !== action.playerId) {
      return { ok: false, error: `This player doesn't control ${planetId}.` };
    }
    if (planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };
    // TE SPACE STATIONS (rulebook p.10): "they do not count as planets for the purpose of voting" — their influence value can't be spent to cast votes, even though it's spendable for other purposes (Trade, Harness Energy, etc.).
    if (planet.isSpaceStation) return { ok: false, error: "TE SPACE STATIONS: a space station's influence cannot be used to cast votes." };
    const planetData = rules.planets[planetId];
    if (!planetData) return { ok: false, error: `No static influence data for ${planetId}.` };
    // Xxcha "Xxekir Grom — POLITICAL DATA NEXUS Ω": "the resource value of a planet will be added to its influence value when the Xxcha player casts votes." Same unlock/game-mode gating as its own spendForCost version (phases/technology.ts).
    const xxekirGromOmegaActiveForVotes = (() => {
      const p = state.players[action.playerId];
      if (!p || p.factionId !== ("xxcha" as never) || hasThundersEdge(state.mode) || !hasCodex(state.mode)) return false;
      const heroEntry = p.leaders.find((l) => l.leaderId === ("xxcha_hero" as never));
      return !!heroEntry && !heroEntry.locked;
    })();
    votes += planetData.influence + (xxekirGromOmegaActiveForVotes ? planetData.resources : 0);
  }
  // Xxcha "Elder Qanoj" (commander, passive): "each planet you exhaust to cast votes provides 1 additional vote" — confirmed even a 0-influence planet counts.
  votes += getElderQanojVoteBonus(state, action.playerId, action.exhaustPlanetIds.length);

  let nextState: GameState = state;
  for (const planetId of action.exhaustPlanetIds) {
    nextState = planetId === ("the_triad" as never) ? exhaustTriad(nextState, action.playerId) : exhaustPlanet(nextState, planetId);
  }

  let predictiveIntelligenceBonusUsedBy = pending.predictiveIntelligenceBonusUsedBy;
  if (action.usePredictiveIntelligenceBonus) {
    const techId = asTechId("predictive_intelligence");
    if (!player.technologies.includes(techId)) return { ok: false, error: "This player doesn't own Predictive Intelligence." };
    if (player.exhaustedTechnologies.includes(techId)) return { ok: false, error: "Predictive Intelligence is already exhausted." };
    votes += 3;
    predictiveIntelligenceBonusUsedBy = { ...predictiveIntelligenceBonusUsedBy, [action.playerId]: action.outcome };
  }

  // Hacan "Gila the Silvertongue" (commander, passive): "When you cast
  // votes: you may spend any number of trade goods; cast 2 additional
  // votes for each trade good spent." Confirmed (tirules2.com/F_hacan):
  // additional votes must be for the SAME outcome as this player's other
  // votes (automatic here, since this is all one CAST_VOTES call for one
  // outcome) — "if the player abstains or casts 0 votes, they cannot
  // cast additional ones" (checked via votes > 0, using whatever the
  // count is BEFORE this bonus, i.e. real planet-influence votes cast).
  let nextPlayers = state.players;
  if (action.useGilaTradeGoodsSpent && action.useGilaTradeGoodsSpent > 0) {
    const commanderEntry = player.leaders.find((l) => l.leaderId === ("hacan_commander" as never));
    if (!commanderEntry || commanderEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Gila the Silvertongue." };
    if (votes <= 0) return { ok: false, error: "Gila the Silvertongue: cannot cast additional votes when casting 0 votes for this outcome." };
    if (player.tradeGoods < action.useGilaTradeGoodsSpent) return { ok: false, error: "Not enough trade goods." };
    votes += action.useGilaTradeGoodsSpent * 2;
    nextPlayers = { ...nextPlayers, [action.playerId]: { ...player, tradeGoods: player.tradeGoods - action.useGilaTradeGoodsSpent } };
  }

  const existingForOutcome = pending.votesByOutcome[action.outcome] ?? [];
  const updatedVote: PendingAgendaVote = {
    ...pending,
    nextVoterIndex: pending.nextVoterIndex + 1,
    votesByOutcome: { ...pending.votesByOutcome, [action.outcome]: [...existingForOutcome, { playerId: action.playerId, votes }] },
    predictiveIntelligenceBonusUsedBy,
  };
  nextState = { ...nextState, players: nextPlayers, pendingAgendaVote: updatedVote };

  const events: GameEvent[] = [{ type: "VOTES_CAST", playerId: action.playerId, outcome: action.outcome, votes }];
  return openAfterYouCastVotesWindow(nextState, action.playerId, events);
}

/** RR "Distinguished Councilor": every CAST_VOTES opens this single-participant (just the voter) window before checking whether the agenda is now fully voted on — see GameEngine.ts's own applyAction, which resolves the agenda (if this really was the last vote) only once this window closes. */
function openAfterYouCastVotesWindow(state: GameState, playerId: PlayerId, events: GameEvent[]): ActionResult {
  return {
    ok: true,
    state: { ...state, pendingPriorityWindow: { kind: "after_you_cast_votes", order: [playerId], currentIndex: 0, consecutivePasses: 0 } },
    events,
  };
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

/** RR "The Triad" (relic): same sentinel-id special-case as phases/technology.ts's own spendForCost — tracked via player.exhaustedRelics (same mechanism every other relic already uses), not a real planet. */
function exhaustTriad(state: GameState, playerId: PlayerId): GameState {
  const player = state.players[playerId];
  if (!player) return state;
  return { ...state, players: { ...state.players, [playerId]: { ...player, exhaustedRelics: [...(player.exhaustedRelics ?? []), "the_triad" as never] } } };
}

/** RR 8.4/8.5: tally votes, resolve the winning outcome, then either reveal the next agenda or end the agenda phase (RR 8 always resolves exactly 2, or fewer once the deck runs dry). */
export function resolveAgendaVote(state: GameState, rules: RuleData): { state: GameState; events: GameEvent[] } {
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

  // RR (yjmrobert.com/tirules/components/c_action_cards): confirmed twice —
  // "Deadly Plot is played after any effects that change the outcome of an
  // agenda" and "Confusing/Confounding Legal Text is played before Deadly
  // Plot is played" — so its own "outcome_would_be_resolved" window has to
  // open AFTER "elected_as_outcome" has fully resolved, not before. See
  // finalizeAgendaResolution's own doc comment for where it actually opens now.
  return finalizeAgendaResolutionWithPredictions({ ...state, players }, rules, players, pending, winner);
}

/** Split out of resolveAgendaVote only so the "apply rider predictions" step has a clear place to sit between the vote tally (above) and RR 8.4/8.5's own outcome-application (finalizeAgendaResolution) — see phases/actionCardEffects.ts's own applyAgendaPredictionRewards for what the 8 rider cards actually do. */
function finalizeAgendaResolutionWithPredictions(
  state: GameState,
  rules: RuleData,
  playersAfterPredictiveIntelligence: GameState["players"],
  pending: PendingAgendaVote,
  winner: string | null,
): { state: GameState; events: GameEvent[] } {
  const stateBeforeRewards: GameState = { ...state, players: playersAfterPredictiveIntelligence };
  const rewardResult = applyAgendaPredictionRewards(stateBeforeRewards, rules, winner, pending.votesByOutcome);
  const finalized = finalizeAgendaResolution({ ...rewardResult.state, pendingAgendaVote: null }, rules, pending.agendaId, winner, pending.votesByOutcome);
  return { state: finalized.state, events: [...rewardResult.events, ...finalized.events] };
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
  // Yssaril Tribes "CRAFTY" is a confirmed exemption (tirules2.com/
  // F_yssaril: "the effect of the Executive Sanctions law does not affect
  // the Yssaril player") — this was previously documented on
  // rules/yssaril.ts's own hasUnlimitedActionCardHand but never actually
  // wired in here, so Yssaril was silently getting hit by the discard
  // like everyone else.
  if (agendaId === "executive_sanctions" && winner === "against") {
    nextState = {
      ...nextState,
      pendingExecutiveSanctionsRandomDiscard: Object.values(nextState.players)
        .filter((p) => p.actionCards.length > 0 && !hasUnlimitedActionCardHand(p))
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
        diplomaticPressureUsedThisAgenda: undefined,
      transactionsThisAgenda: undefined,
      };
      return { state: nextState, events: [...events, { type: "AGENDA_REVEALED", agendaId: electedLawId }] };
    }
  }

  // RR "Confusing Legal Text"/"Confounding Legal Text": if this agenda's
  // outcome elected a specific player, every player gets 1 chance to
  // redirect who that election actually lands on, before the agenda
  // phase moves on (next agenda revealed, or next round begins).
  // Deliberate timing simplification, flagged rather than a full "before
  // the law is even recorded" intercept (which would need deferring
  // every OTHER side effect above too — Anti-Intellectual Revolution,
  // Homeland Defense Act, etc. — since they all run before this point):
  // the redirect happens after lawOwnerId is already recorded, then gets
  // corrected in place — functionally identical by the time anything
  // downstream actually reads that ownership, just not a literal
  // before-the-fact intercept.
  if (lawOwnerId !== "common" && nextState.lastResolvedAgenda?.agendaId === agendaId && !nextState.electedOutcomeWindowDone) {
    if (!nextState.pendingPriorityWindow) {
      const order = agendaPhaseWindowOrder(nextState).filter((id) => !nextState.players[id]?.eliminated);
      if (order.length > 0) {
        return { state: { ...nextState, pendingPriorityWindow: { kind: "elected_as_outcome", order, currentIndex: 0, consecutivePasses: 0 } }, events };
      }
    } else if (nextState.pendingPriorityWindow.kind === "elected_as_outcome") {
      return { state: nextState, events };
    }
    nextState = { ...nextState, electedOutcomeWindowDone: true };
  }

  // RR (yjmrobert.com/tirules/components/c_action_cards): "Deadly Plot is
  // played after any effects that change the outcome of an agenda" and
  // "Confusing/Confounding Legal Text is played before Deadly Plot" —
  // this window has to come AFTER the elected_as_outcome check above, not
  // before (moved here from resolveAgendaVote, which used to open it too
  // early). Still checked against the ORIGINAL winner/votes/predictions
  // (`pending`, `winner` — this function's own params), since "any
  // prediction... is incorrect" once Deadly Plot fires either way.
  if (!nextState.outcomeWouldBeResolvedWindowDone) {
    if (!nextState.pendingPriorityWindow) {
      const order = agendaPhaseWindowOrder(nextState).filter((id) => !nextState.players[id]?.eliminated);
      if (order.length > 0) {
        return { state: { ...nextState, outcomeWouldBeResolvedWindowDone: true, pendingPriorityWindow: { kind: "outcome_would_be_resolved", order, currentIndex: 0, consecutivePasses: 0 } }, events };
      }
    } else if (nextState.pendingPriorityWindow.kind === "outcome_would_be_resolved") {
      return { state: nextState, events };
    }
    nextState = { ...nextState, outcomeWouldBeResolvedWindowDone: true };
  }

  return continueAgendaPhaseAfterElectionReaction(nextState, rules, events);
}

/**
 * Everything that happens once RR "Confusing/Confounding Legal Text"'s
 * own "elected_as_outcome" window (if it was even needed) has fully
 * closed — split out of finalizeAgendaResolution so GameEngine.ts can
 * call this SAME continuation once that window closes, without
 * re-running everything earlier in finalizeAgendaResolution a second
 * time (which would double-apply side effects like queuing Anti-
 * Intellectual Revolution's own exhaustion).
 */
export function continueAgendaPhaseAfterElectionReaction(state: GameState, rules: RuleData, events: GameEvent[]): { state: GameState; events: GameEvent[] } {
  let nextState = state;
  if ((nextState.agendaPhaseAgendasResolved ?? 0) < 2 && nextState.agendaDeck.deckIds.length > 0) {
    nextState = { ...nextState, electedOutcomeWindowDone: undefined, outcomeWouldBeResolvedWindowDone: undefined };
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
