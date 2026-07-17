import { GameState, Player } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, ActionCardId } from "../types/ids";
import { fisherYatesShuffle } from "../setup/mapGeneration";

/**
 * RR 2 ACTION CARDS.
 *
 * PLAY_ACTION_CARD here does the MECHANICAL bookkeeping every action card
 * play shares (remove from hand, discard, i.e. RR 2.7's "then, that player
 * discards the card, placing it in the action discard pile") — it does NOT
 * resolve the card's own printed ability text. That's the same deferred-
 * content scope cut as agenda/objective effect text elsewhere in this
 * project (151 unique cards, each free-form) — this just makes sure a
 * played card correctly leaves the hand and enters the discard pile (which
 * matters for RR 2.9's "reshuffle discard pile when the deck empties," and
 * for a future UI to show "N cards left in the deck" accurately) without
 * pretending the card's actual effect happened.
 *
 * DISCARD_ACTION_CARD is the OTHER way a card leaves a hand — voluntary,
 * not tied to playing it (RR 2.4's hand-limit compliance, or discarding on
 * its own for whatever reason a player wants to). This is the one that
 * counts toward "discard N action cards" secret objectives (e.g. Form a
 * Spy Network) — see Player.actionCardsDiscardedCount's own doc comment on
 * why PLAY_ACTION_CARD deliberately does NOT increment that counter.
 */

export function playActionCard(
  state: GameState,
  action: { type: "PLAY_ACTION_CARD"; playerId: PlayerId; cardId: ActionCardId; payload?: unknown },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (!player.actionCards.includes(action.cardId)) {
    return { ok: false, error: "This player doesn't have that action card in hand." };
  }

  const updatedPlayer: Player = { ...player, actionCards: player.actionCards.filter((id) => id !== action.cardId) };
  const nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer },
    actionCardDiscardPile: [...(state.actionCardDiscardPile ?? []), action.cardId],
  };

  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_PLAYED", playerId: action.playerId, cardId: action.cardId }] };
}

export function discardActionCard(
  state: GameState,
  action: { type: "DISCARD_ACTION_CARD"; playerId: PlayerId; cardId: ActionCardId },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (!player.actionCards.includes(action.cardId)) {
    return { ok: false, error: "This player doesn't have that action card in hand." };
  }

  const updatedPlayer: Player = {
    ...player,
    actionCards: player.actionCards.filter((id) => id !== action.cardId),
    actionCardsDiscardedCount: player.actionCardsDiscardedCount + 1,
  };
  const nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer },
    actionCardDiscardPile: [...(state.actionCardDiscardPile ?? []), action.cardId],
  };

  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_DISCARDED", playerId: action.playerId, cardId: action.cardId }] };
}

/**
 * RR 2.9: if the action card deck is ever drawn from while empty, shuffle
 * the discard pile to form a fresh deck first. Shared helper so every draw
 * site (currently just the status phase's own draw, in actionPhase.ts)
 * does this the same way rather than duplicating the reshuffle-check.
 */
export function drawActionCard(
  state: GameState,
  rng: () => number = Math.random,
): { deck: ActionCardId[]; discardPile: ActionCardId[]; drawn: ActionCardId | null } {
  let deck = state.actionCardDeck ?? [];
  let discardPile = state.actionCardDiscardPile ?? [];

  if (deck.length === 0 && discardPile.length > 0) {
    deck = fisherYatesShuffle(discardPile, rng);
    discardPile = [];
  }
  if (deck.length === 0) return { deck, discardPile, drawn: null };

  const [drawn, ...rest] = deck;
  return { deck: rest, discardPile, drawn };
}
