import { GameState, Player } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, ObjectiveId } from "../types/ids";
import { ObjectiveKind } from "../types/enums";

/**
 * RR 3.2-3.5 PASS.
 * A player cannot pass until their strategy card(s) are exhausted, i.e.
 * they've resolved their strategic action for the round (RR 3.4, and the
 * 3-4p "both cards" variant). Passing does not end the action phase by
 * itself — see autoAdvancePhase, which is what actually notices "everyone's
 * done" and moves things along.
 */
export function pass(state: GameState, action: { type: "PASS"; playerId: PlayerId }): ActionResult {
  if (state.phase !== "action") {
    return { ok: false, error: "RR 3: passing only applies during the action phase." };
  }
  if (state.activePlayerId !== action.playerId) {
    return { ok: false, error: "RR 4: it is not this player's turn." };
  }
  const player = state.players[action.playerId];
  if (player.hasPassed) {
    return { ok: false, error: "This player has already passed." };
  }
  if (state.pendingTacticalAction) {
    return { ok: false, error: "Cannot pass with a tactical action in progress." };
  }
  if (player.strategyCards.length === 0 || player.strategyCards.some((c) => !c.exhausted)) {
    return { ok: false, error: "RR 3.4: a player cannot pass until his strategy card(s) are exhausted." };
  }

  const updatedPlayer: Player = { ...player, hasPassed: true };
  const nextState = advanceActivePlayer({
    ...state,
    players: { ...state.players, [player.id]: updatedPlayer },
  });

  return { ok: true, state: nextState, events: [{ type: "PLAYER_PASSED", playerId: action.playerId }] };
}

/**
 * RR 4.2/4.3: after a turn, the next player in initiative order who hasn't
 * passed becomes active, wrapping around and skipping passed players. If
 * everyone has passed, there's no active player — autoAdvancePhase (below)
 * picks that up and moves to the status phase.
 */
export function advanceActivePlayer(state: GameState): GameState {
  const order = state.initiativeOrder;
  if (order.length === 0 || order.every((id) => state.players[id].hasPassed)) {
    return { ...state, activePlayerId: null };
  }
  const currentIndex = state.activePlayerId ? order.indexOf(state.activePlayerId) : -1;
  for (let i = 1; i <= order.length; i++) {
    const candidate = order[(currentIndex + i) % order.length];
    if (!state.players[candidate].hasPassed) {
      return { ...state, activePlayerId: candidate };
    }
  }
  return { ...state, activePlayerId: null };
}

/**
 * Call after every successfully-applied action. Most of the time this is a
 * no-op — it only does something at the exact moment a phase's exit
 * condition becomes true, so callers never have to remember to check for it.
 *
 * Two triggers now, not one:
 *  1. Action phase ends (everyone passed/eliminated) → phase becomes
 *     "status", scoring tracking resets. Nothing else yet — RR 70.1
 *     (scoring) needs each player's explicit choice first (SCORE_OBJECTIVE,
 *     then FINISH_STATUS_PHASE_SCORING).
 *  2. Every non-eliminated player has called FINISH_STATUS_PHASE_SCORING →
 *     the rest of RR 70 runs automatically (70.2 reveal public objective,
 *     70.3 draw action card, 70.4-70.8 tokens/ready/repair/cards), then RR
 *     36.1 (agenda phase if Mecatol's custodians are gone, else a new
 *     strategy phase).
 */
export function autoAdvancePhase(state: GameState): { state: GameState; events: GameEvent[] } {
  if (state.phase === "action") {
    if (state.activePlayerId !== null) return { state, events: [] };
    if (!Object.values(state.players).every((p) => p.hasPassed || p.eliminated)) {
      return { state, events: [] };
    }
    const next: GameState = { ...state, phase: "status", statusPhaseScoring: {} };
    return { state: next, events: [{ type: "PHASE_CHANGED", from: "action", to: "status", round: state.round }] };
  }

  if (state.phase === "status") {
    const allDone = Object.values(state.players).every(
      (p) => p.eliminated || state.statusPhaseScoring?.[p.id]?.done,
    );
    if (!allDone) return { state, events: [] };

    const bookkeeping = runStatusPhaseBookkeeping(state);
    let next = bookkeeping.state;
    const events = [...bookkeeping.events];

    if (state.mecatolCustodiansRemoved) {
      next = { ...next, phase: "agenda" };
      events.push({ type: "PHASE_CHANGED", from: "status", to: "agenda", round: next.round });
    } else {
      next = startNewRound(next);
      events.push({ type: "PHASE_CHANGED", from: "status", to: "strategy", round: next.round });
      events.push({ type: "ROUND_STARTED", round: next.round });
    }
    return { state: next, events };
  }

  return { state, events: [] };
}

/** RR 70.1: score a public (revealed) or secret (held) objective — max 1 of each per status phase, never twice ever. Does NOT verify the objective's actual condition text (see this project's own scope note on data/objectives.json) — trusts the caller for now. */
export function scoreObjective(
  state: GameState,
  action: { type: "SCORE_OBJECTIVE"; playerId: PlayerId; objectiveId: ObjectiveId },
): ActionResult {
  if (state.phase !== "status") {
    return { ok: false, error: "RR 70.1: objectives can only be scored during the status phase." };
  }
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (player.victoryPoints.scoredObjectiveIds.includes(action.objectiveId)) {
    return { ok: false, error: "RR 52.8: this objective has already been scored by this player." };
  }

  const publicMatch = state.objectives.find((o) => o.objectiveId === action.objectiveId && o.revealed);
  const isSecret = player.secretObjectives.includes(action.objectiveId);
  const kind: ObjectiveKind | null = publicMatch ? publicMatch.kind : isSecret ? "secret" : null;
  if (!kind) {
    return { ok: false, error: "Objective isn't revealed (public) or held (secret) by this player." };
  }

  const scoring = state.statusPhaseScoring?.[action.playerId] ?? { scoredPublic: false, scoredSecret: false, done: false };
  if (scoring.done) return { ok: false, error: "This player already finished scoring this status phase." };
  if (kind !== "secret" && scoring.scoredPublic) {
    return { ok: false, error: "RR 70.1: max 1 public objective per player per status phase." };
  }
  if (kind === "secret" && scoring.scoredSecret) {
    return { ok: false, error: "RR 70.1: max 1 secret objective per player per status phase." };
  }

  const points = kind === "publicII" ? 2 : 1;
  const updatedPlayer: Player = {
    ...player,
    victoryPoints: {
      current: player.victoryPoints.current + points,
      scoredObjectiveIds: [...player.victoryPoints.scoredObjectiveIds, action.objectiveId],
    },
  };

  let nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer },
    statusPhaseScoring: {
      ...state.statusPhaseScoring,
      [action.playerId]: {
        ...scoring,
        scoredPublic: scoring.scoredPublic || kind !== "secret",
        scoredSecret: scoring.scoredSecret || kind === "secret",
      },
    },
  };

  const events: GameEvent[] = [{ type: "OBJECTIVE_SCORED", playerId: action.playerId, objectiveId: action.objectiveId, points }];

  // RR 87: first to the target wins outright — doesn't yet handle the tie-break rule for two players crossing in the same status phase (RR 87.3-ish), flagged rather than guessed.
  if (!nextState.winnerId && updatedPlayer.victoryPoints.current >= state.victoryPointTarget) {
    nextState = { ...nextState, winnerId: action.playerId };
    events.push({ type: "GAME_ENDED", winnerId: action.playerId });
  }

  return { ok: true, state: nextState, events };
}

/** RR 70.1: a player signals they're done scoring for this status phase (0, 1, or 2 objectives). Once every non-eliminated player has, the rest of the status phase runs automatically — see autoAdvancePhase. */
export function finishStatusPhaseScoring(
  state: GameState,
  action: { type: "FINISH_STATUS_PHASE_SCORING"; playerId: PlayerId },
): ActionResult {
  if (state.phase !== "status") {
    return { ok: false, error: "RR 70.1: not currently in the status phase." };
  }
  const scoring = state.statusPhaseScoring?.[action.playerId] ?? { scoredPublic: false, scoredSecret: false, done: false };
  if (scoring.done) return { ok: false, error: "Already finished scoring this status phase." };

  const nextState: GameState = {
    ...state,
    statusPhaseScoring: { ...state.statusPhaseScoring, [action.playerId]: { ...scoring, done: true } },
  };
  return { ok: true, state: nextState, events: [] };
}

function runStatusPhaseBookkeeping(state: GameState): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];

  // RR 70.2: reveal 1 public objective — Stage I deck first, then Stage II
  // once Stage I is exhausted. No-ops (doesn't error) if both decks are
  // empty, e.g. before game setup has seeded them.
  let objectives = state.objectives;
  const deck = state.publicObjectiveDeck;
  let nextDeck = deck;
  if (deck) {
    if (deck.stageI.length > 0) {
      const [objectiveId, ...rest] = deck.stageI;
      objectives = [...objectives, { kind: "publicI", objectiveId, revealed: true }];
      nextDeck = { ...deck, stageI: rest };
      events.push({ type: "PUBLIC_OBJECTIVE_REVEALED", objectiveId, kind: "publicI" });
    } else if (deck.stageII.length > 0) {
      const [objectiveId, ...rest] = deck.stageII;
      objectives = [...objectives, { kind: "publicII", objectiveId, revealed: true }];
      nextDeck = { ...deck, stageII: rest };
      events.push({ type: "PUBLIC_OBJECTIVE_REVEALED", objectiveId, kind: "publicII" });
    }
  }

  // RR 70.3: each non-eliminated player draws 1 action card. No-ops per
  // player once the deck is empty, rather than erroring.
  let actionCardDeck = state.actionCardDeck ? [...state.actionCardDeck] : undefined;
  const players: GameState["players"] = {};
  for (const [id, player] of Object.entries(state.players)) {
    let updatedPlayer: Player = {
      ...player,
      // RR 70.4: command tokens on the board return to reinforcements (i.e. just removed; they're re-gained as fresh tokens in 70.5, not literally recycled).
      commandTokens: { ...player.commandTokens, onBoard: [] },
      // RR 70.6: ready all exhausted strategy cards. (Ready state for planets is handled below, per-system.)
      strategyCards: player.strategyCards.map((c) => ({ ...c, exhausted: false })),
    };
    // RR 70.5: gain 2 command tokens. Simplification: auto-placed in the strategy pool;
    // a future UI can offer redistribution as its own action before this runs.
    updatedPlayer.commandTokens = { ...updatedPlayer.commandTokens, strategy: updatedPlayer.commandTokens.strategy + 2 };

    if (!player.eliminated && actionCardDeck && actionCardDeck.length > 0) {
      const [cardId, ...rest] = actionCardDeck;
      actionCardDeck = rest;
      updatedPlayer = { ...updatedPlayer, actionCards: [...updatedPlayer.actionCards, cardId] };
      events.push({ type: "ACTION_CARD_DRAWN", playerId: player.id, cardId });
    }

    players[id as PlayerId] = updatedPlayer;
  }

  const systems: GameState["systems"] = {};
  for (const [id, system] of Object.entries(state.systems)) {
    systems[id as keyof typeof systems] = {
      ...system,
      planets: system.planets.map((p) => ({
        ...p,
        exhausted: false, // RR 70.6
        unitsByPlayer: Object.fromEntries(
          Object.entries(p.unitsByPlayer).map(([pid, stacks]) => [
            pid,
            (stacks ?? []).map((u) => ({ ...u, damagedCount: 0 })), // RR 70.7
          ]),
        ),
      })),
      spaceUnitsByPlayer: Object.fromEntries(
        Object.entries(system.spaceUnitsByPlayer).map(([pid, stacks]) => [
          pid,
          (stacks ?? []).map((u) => ({ ...u, damagedCount: 0 })), // RR 70.7
        ]),
      ),
    };
  }

  return {
    state: { ...state, players, systems, objectives, publicObjectiveDeck: nextDeck, actionCardDeck },
    events,
  };
}

function startNewRound(state: GameState): GameState {
  const players: GameState["players"] = {};
  for (const [id, player] of Object.entries(state.players)) {
    players[id as PlayerId] = { ...player, hasPassed: false, strategyCards: [] };
  }

  // RR 70.8: strategy cards return to the common play area (RR 73.2's trade
  // goods only accrue on cards that go unchosen for a full round — cards
  // that were just used carry no residual trade goods forward).
  const unclaimedStrategyCards = state.unclaimedStrategyCards.length
    ? state.unclaimedStrategyCards
    : Object.values(state.players)
        .flatMap((p) => p.strategyCards)
        .map((c) => ({ cardId: c.cardId, tradeGoods: 0 }));

  return {
    ...state,
    players,
    phase: "strategy",
    round: state.round + 1,
    activePlayerId: null,
    initiativeOrder: [],
    unclaimedStrategyCards,
  };
}
