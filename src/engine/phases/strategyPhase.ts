import { GameState, Player } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, StrategyCardId, AgendaId } from "../types/ids";
import { computeInitiativeOrder } from "../rules/initiative";
import { isLawActiveWithOutcome } from "./agendaEffects";
import { agendaPhaseWindowOrder } from "../rules/priorityWindow";

/**
 * RR 73.1c/33.9: how many strategy cards each player picks this round — 2
 * in a 3-4 player game, 1 otherwise. RR 33.9's own wrinkle: a game that
 * STARTED with 5 or more players keeps everyone at 1 card even after
 * eliminations bring the CURRENT count down to 4 or fewer — so this reads
 * `startingPlayerCount` (frozen at game creation) instead of the live
 * player count whenever that field is available, falling back to the
 * live count for older/incomplete states that predate this field.
 */
export function getStrategyCardsPerPlayer(state: GameState): number {
  const count = state.startingPlayerCount ?? Object.keys(state.players).length;
  return count <= 4 ? 2 : 1;
}

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
  action: { type: "CHOOSE_STRATEGY_CARD"; playerId: PlayerId; cardId: StrategyCardId; giveToPlayerId?: PlayerId },
): ActionResult {
  if (state.phase !== "strategy") {
    return { ok: false, error: "RR 73: strategy cards can only be chosen during the strategy phase." };
  }

  const player = state.players[action.playerId];
  const cardsNeeded = getStrategyCardsPerPlayer(state);

  if (player.strategyCards.length >= cardsNeeded) {
    return { ok: false, error: `RR 73.1: ${action.playerId} already holds their strategy card(s) for this round.` };
  }

  const entry = state.unclaimedStrategyCards.find((c) => c.cardId === action.cardId);
  if (!entry) {
    return { ok: false, error: `RR 73.1: strategy card ${action.cardId} is not available — already chosen this round.` };
  }
  if (player.excludedStrategyCardIds?.includes(action.cardId)) {
    return { ok: false, error: 'RR "Public Disgrace": this player must choose a different strategy card.' };
  }

  if (!isPlayersStrategyTurnInternal(state, action.playerId)) {
    return { ok: false, error: "RR 73.1: it's not this player's turn to choose a strategy card." };
  }

  // RR "Checks and Balances" ("for"): the chosen card must go to another
  // player who doesn't yet have their full count for the round, if any —
  // the CHOOSING player's own turn/pick of the CARD is unaffected, only
  // who ends up holding it changes.
  const checksAndBalances = isLawActiveWithOutcome(state, "checks_and_balances" as AgendaId, "for");
  const eligibleRecipients = Object.values(state.players).filter((p) => p.id !== action.playerId && p.strategyCards.length < cardsNeeded);
  let recipientId = action.playerId;
  if (checksAndBalances && eligibleRecipients.length > 0) {
    if (!action.giveToPlayerId || !eligibleRecipients.some((p) => p.id === action.giveToPlayerId)) {
      return { ok: false, error: 'RR "Checks and Balances": must give this card to another player who doesn\'t yet have their strategy card(s) for the round.' };
    }
    recipientId = action.giveToPlayerId;
  }

  // Gain any trade goods sitting on the card (RR 73.1 bullet, carried over from a previous round's step 2).
  const tradeGoodsGained = entry.tradeGoods;

  const recipient = state.players[recipientId];
  const updatedRecipient: Player = {
    ...recipient,
    strategyCards: [...recipient.strategyCards, { cardId: action.cardId, exhausted: false }],
    tradeGoods: recipient.tradeGoods + tradeGoodsGained,
  };
  const players: GameState["players"] = { ...state.players, [recipientId]: updatedRecipient };
  // RR "Public Disgrace": the CHOOSER's own exclusion clears once they've successfully picked something (regardless of who, via Checks and Balances, ends up actually holding it).
  if (players[action.playerId]?.excludedStrategyCardIds) {
    players[action.playerId] = { ...players[action.playerId], excludedStrategyCardIds: undefined };
  }

  let nextState: GameState = {
    ...state,
    players,
    unclaimedStrategyCards: state.unclaimedStrategyCards.filter((c) => c.cardId !== action.cardId),
    lastStrategyCardChoice: { playerId: recipientId, cardId: action.cardId, tradeGoodsGained },
  };

  const events: GameEvent[] = [{ type: "STRATEGY_CARD_CHOSEN", playerId: recipientId, cardId: action.cardId }];

  // RR "Public Disgrace": every OTHER player gets a chance to force this pick to be redone before anything else happens (including RR 73.2's own "is everyone done" check below).
  const disgraceOrder = agendaPhaseWindowOrder(nextState).filter((id) => id !== recipientId && !nextState.players[id]?.eliminated);
  if (disgraceOrder.length > 0) {
    nextState = { ...nextState, pendingPriorityWindow: { kind: "strategy_card_chosen", order: disgraceOrder, currentIndex: 0, consecutivePasses: 0 } };
    return { ok: true, state: nextState, events };
  }

  return finishStrategyCardChoiceIfPhaseComplete(nextState, events);
}

/** RR 73.2: once every player holds their strategy card(s) for the round (and, if applicable, RR "Public Disgrace"'s own reactive window on this pick has fully closed with no redo forced), place 1 trade good on every unchosen card and move to the action phase. Split out so both the no-Sabotage-eligible-responders shortcut above and PASS_PRIORITY's own window-closing path (GameEngine.ts) can reach it. */
export function finishStrategyCardChoiceIfPhaseComplete(state: GameState, events: GameEvent[]): ActionResult {
  if (!everyoneHasEnoughCards(state)) {
    return { ok: true, state, events };
  }
  const clearedSkips: GameState["players"] = {};
  for (const [id, p] of Object.entries(state.players)) {
    clearedSkips[id as PlayerId] = p.skipsNextStrategyPick ? { ...p, skipsNextStrategyPick: false } : p;
  }
  const nextState: GameState = {
    ...state,
    players: clearedSkips,
    unclaimedStrategyCards: state.unclaimedStrategyCards.map((c) => ({ ...c, tradeGoods: c.tradeGoods + 1 })),
    phase: "action",
  };
  const initiativeOrder = computeInitiativeOrder(nextState);
  const finalState: GameState = { ...nextState, initiativeOrder, activePlayerId: initiativeOrder[0] ?? null };
  return { ok: true, state: finalState, events: [...events, { type: "PHASE_CHANGED", from: "strategy", to: "action", round: finalState.round }] };
}

function everyoneHasEnoughCards(state: GameState): boolean {
  const cardsNeeded = getStrategyCardsPerPlayer(state);
  // RR "Political Stability": a skipping player never reaches cardsNeeded — treated as already satisfied instead of blocking the phase forever.
  return Object.values(state.players).every((p) => p.skipsNextStrategyPick || p.strategyCards.length >= cardsNeeded);
}

function isPlayersStrategyTurnInternal(state: GameState, playerId: PlayerId): boolean {
  const cardsNeeded = getStrategyCardsPerPlayer(state);
  const speakerId = state.seatOrder.find((id) => state.players[id].isSpeaker) ?? state.seatOrder[0];
  const startIndex = state.seatOrder.indexOf(speakerId);
  const rotated = [...state.seatOrder.slice(startIndex), ...state.seatOrder.slice(0, startIndex)];
  for (const candidateId of rotated) {
    // RR "Political Stability": this player sat out picking a card this round entirely — treated the same as already having their full count, for ordering purposes only.
    if (state.players[candidateId].skipsNextStrategyPick) continue;
    if (state.players[candidateId].strategyCards.length < cardsNeeded) {
      return candidateId === playerId;
    }
  }
  return false;
}
