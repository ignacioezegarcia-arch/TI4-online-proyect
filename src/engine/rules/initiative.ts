import { GameState } from "../types/GameState";
import { PlayerId } from "../types/ids";
import { STRATEGY_CARDS, BaseStrategyCard } from "../types/enums";

/**
 * RR 43.2/43.3: a player's initiative is their LOWEST-numbered chosen
 * strategy card (relevant in 3-4p games, where each player holds two).
 * Assumes cardId strings match the base card keys (leadership, diplomacy,
 * politics, construction, trade, warfare, technology, imperial) — PoK's
 * Keleres and other renamed/replacement cards should still resolve to one
 * of these eight underlying initiative slots; if a future faction card uses
 * a different id, extend the lookup table below rather than this function.
 */
export function computeInitiativeOrder(state: GameState): PlayerId[] {
  const playersWithCards = Object.values(state.players).filter((p) => p.strategyCards.length > 0);
  return playersWithCards
    .map((p) => ({
      playerId: p.id,
      initiative: Math.min(...p.strategyCards.map((c) => getInitiativeNumber(c.cardId))),
    }))
    .sort((a, b) => a.initiative - b.initiative)
    .map((entry) => entry.playerId);
}

function getInitiativeNumber(cardId: string): number {
  const known = STRATEGY_CARDS[cardId as BaseStrategyCard];
  if (known !== undefined) return known;
  // TODO: PoK Keleres / any Thunder's Edge renamed strategy card variants —
  // map them to their underlying initiative slot here once faction data
  // for those is loaded.
  return 99;
}
