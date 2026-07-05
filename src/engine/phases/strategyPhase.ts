import { GameState, Player } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, StrategyCardId } from "../types/ids";
import { computeInitiativeOrder } from "../rules/initiative";

/**
 * RR 73 STRATEGY PHASE.
 * STEP 1: starting with the speaker and proceeding clockwise, each player
 *         chooses one strategy card from the common play area. In 3-4p
 *         games this repeats so everyone ends up with two cards
 *         (RR "Three– and Four–Player Games").
 * STEP 2: once every card is claimed, the speaker places 1 trade good on
 *         each strategy card that was NOT chosen — handled inline below,
 *         the moment the last card is claimed, rather than as a separate
 *         action, since it has no decision attached to it (RR 73.2).
 */
export function chooseStrategyCard(
  state: GameState,
  action: { type: "CHOOSE_STRATEGY_CARD"; playerId: PlayerId; cardId: StrategyCardId },
): ActionResult {
  if (state.phase !== "strategy") {
    return { ok: false, error: "RR 73: strategy cards can only be chosen during the strategy phase." };
  }

  const player = state.players[action.playerId];
  const cardsNeeded = Object.keys(state.players).length <= 4 ? 2 : 1;

  if (player.strategyCards.length >= cardsNeeded) {
    return { ok: false, error: `RR 73.1: ${action.playerId} already holds their strategy card(s) for this round.` };
  }

  const entry = state.unclaimedStrategyCards.find((c) => c.cardId === action.cardId);
  if (!entry) {
    return { ok: false, error: `RR 73.1: strategy card ${action.cardId} is not available — already chosen this round.` };
  }

  if (!isPlayersStrategyTurnInternal(state, action.playerId)) {
    return { ok: false, error: "RR 73.1: it's not this player's turn to choose a strategy card." };
  }

  // Gain any trade goods sitting on the card (RR 73.1 bullet, carried over from a previous round's step 2).
  const tradeGoodsGained = entry.tradeGoods;

  const updatedPlayer: Player = {
    ...player,
    strategyCards: [...player.strategyCards, { cardId: action.cardId, exhausted: false }],
    tradeGoods: player.tradeGoods + tradeGoodsGained,
  };

  let nextState: GameState = {
    ...state,
    players: { ...state.players, [player.id]: updatedPlayer },
    unclaimedStrategyCards: state.unclaimedStrategyCards.filter((c) => c.cardId !== action.cardId),
  };

  const events: GameEvent[] = [{ type: "STRATEGY_CARD_CHOSEN", playerId: player.id, cardId: action.cardId }];

  // RR 73.2: once every player holds their strategy card(s) for the round,
  // place 1 trade good on every card that ended up unchosen (a no-op in 4p,
  // where every card is always claimed — RR 73.2 bullet), then move on to
  // the action phase (RR 43: initiative order comes from the chosen cards).
  if (everyoneHasEnoughCards(nextState)) {
    nextState = {
      ...nextState,
      unclaimedStrategyCards: nextState.unclaimedStrategyCards.map((c) => ({ ...c, tradeGoods: c.tradeGoods + 1 })),
      phase: "action",
    };
    const initiativeOrder = computeInitiativeOrder(nextState);
    nextState = { ...nextState, initiativeOrder, activePlayerId: initiativeOrder[0] ?? null };
    events.push({ type: "PHASE_CHANGED", from: "strategy", to: "action", round: nextState.round });
  }

  return { ok: true, state: nextState, events };
}

function everyoneHasEnoughCards(state: GameState): boolean {
  const cardsNeeded = Object.keys(state.players).length <= 4 ? 2 : 1;
  return Object.values(state.players).every((p) => p.strategyCards.length >= cardsNeeded);
}

function isPlayersStrategyTurnInternal(state: GameState, playerId: PlayerId): boolean {
  const cardsNeeded = Object.keys(state.players).length <= 4 ? 2 : 1;
  const speakerId = state.seatOrder.find((id) => state.players[id].isSpeaker) ?? state.seatOrder[0];
  const startIndex = state.seatOrder.indexOf(speakerId);
  const rotated = [...state.seatOrder.slice(startIndex), ...state.seatOrder.slice(0, startIndex)];
  for (const candidateId of rotated) {
    if (state.players[candidateId].strategyCards.length < cardsNeeded) {
      return candidateId === playerId;
    }
  }
  return false;
}
