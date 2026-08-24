import { GameState, Player } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { effectiveCommoditiesMax } from "./spaceStations";

function findHacanPlayerId(state: GameState): PlayerId | undefined {
  return Object.values(state.players).find((p) => p.factionId === ("hacan" as never))?.id;
}

/**
 * Hacan "Trade Convoys" (promissory note): "ACTION: Place this card
 * face-up in your play area. While this card is in your play area, you
 * may negotiate transactions with players who are not your neighbor. If
 * you activate a system that contains 1 or more of the Hacan player's
 * units, return this card to the Hacan player." Confirmed
 * (tirules2.com/F_hacan):
 *  - Doesn't make the holder neighbors with EVERYONE — just bypasses
 *    the neighbor requirement for transactions (rules/transactions.ts's
 *    own canTransact already checks promissoryNotesInPlayArea for this).
 *  - Returned even if the activating player performs no hostile acts.
 *  - Returned even if the activated system contains ONLY Hacan's own
 *    structures (not ships) — checked by rules/hacan.ts's own
 *    maybeReturnTradeConvoys via ANY of Hacan's own units, not
 *    specifically ships.
 *  - NOT returned by some OTHER effect placing a command counter in a
 *    system with Hacan's units outside of an actual tactical-action
 *    system activation (e.g. Diplomacy's own primary ability) — not
 *    applicable here at all, since this is only ever called from
 *    phases/tacticalAction.ts's own activateSystem.
 */
export function useTradeConvoys(state: GameState, action: { type: "USE_TRADE_CONVOYS"; playerId: PlayerId }): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("hacan_promissory" as never)) {
    return { ok: false, error: "This player doesn't have Trade Convoys in hand." };
  }
  const updatedPlayer: Player = {
    ...player,
    promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("hacan_promissory" as never)),
    promissoryNotesInPlayArea: [...player.promissoryNotesInPlayArea, "hacan_promissory" as never],
  };
  return { ok: true, state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } }, events: [] };
}

/**
 * The return half of Trade Convoys — called from phases/tacticalAction.ts's
 * own activateSystem, right alongside E-Res Siphons' own check, for
 * every player currently holding it in their play area.
 */
export function maybeReturnTradeConvoys(state: GameState, activatingPlayerId: PlayerId, activatedSystemHasHacanUnits: boolean): GameState {
  if (!activatedSystemHasHacanUnits) return state;
  const hacanPlayerId = findHacanPlayerId(state);
  if (!hacanPlayerId || activatingPlayerId === hacanPlayerId) return state;

  let players = state.players;
  for (const [holderId, holder] of Object.entries(players)) {
    if (!holder.promissoryNotesInPlayArea.includes("hacan_promissory" as never)) continue;
    const hacanPlayer = players[hacanPlayerId];
    players = {
      ...players,
      [holderId]: { ...holder, promissoryNotesInPlayArea: holder.promissoryNotesInPlayArea.filter((id) => id !== ("hacan_promissory" as never)) },
      [hacanPlayerId]: { ...hacanPlayer, promissoryNotesInHand: [...hacanPlayer.promissoryNotesInHand, "hacan_promissory" as never] },
    };
  }
  return { ...state, players };
}

/**
 * Hacan "Carth of Golden Sands" (agent): "During the action phase: you
 * may exhaust this card to gain 2 commodities or replenish another
 * player's commodities." Confirmed (tirules2.com/F_hacan):
 *  - "Replenish another player's commodities" is the AGENT-BENEFITS-
 *    ANOTHER-PLAYER pattern, same as this project's own fixed Evelyn
 *    DeLouis/Viscount Unlenn (ownerId separate from the beneficiary).
 *  - A player already at their own max commodities can still be
 *    "replenished" (gaining 0) — still triggers any "when this player
 *    replenishes commodities" effect elsewhere (e.g. Trade Agreement),
 *    which isn't built here but this function's own gain-of-0 behavior
 *    doesn't block it from happening downstream.
 *  - Cannot be resolved while another ability is mid-resolution (e.g.
 *    mid-exploration-card-reveal) — a sequencing note this project has
 *    no generic "is something else currently resolving" flag to check
 *    against; the caller is trusted not to submit this action nested
 *    inside another one.
 */
export function useCarthOfGoldenSands(
  state: GameState,
  action: { type: "USE_CARTH_OF_GOLDEN_SANDS"; playerId: PlayerId; choice: "gain_2_for_self" | "replenish_another"; targetPlayerId?: PlayerId },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const agentEntry = player.leaders.find((l) => l.leaderId === ("hacan_agent" as never));
  if (!agentEntry) return { ok: false, error: "This player doesn't have Carth of Golden Sands." };
  if (agentEntry.exhausted) return { ok: false, error: "Carth of Golden Sands is already exhausted." };
  if (state.phase !== "action") return { ok: false, error: "Carth of Golden Sands is only usable during the action phase." };

  const updatedPlayer: Player = { ...player, leaders: player.leaders.map((l) => (l.leaderId === ("hacan_agent" as never) ? { ...l, exhausted: true } : l)) };
  let players = { ...state.players, [action.playerId]: updatedPlayer };

  if (action.choice === "gain_2_for_self") {
    const max = effectiveCommoditiesMax(state, action.playerId, rules.factions[player.factionId]?.commoditiesMax ?? 0);
    players = { ...players, [action.playerId]: { ...updatedPlayer, commodities: Math.min(max, updatedPlayer.commodities + 2) } };
  } else {
    if (!action.targetPlayerId) return { ok: false, error: "This choice needs a targetPlayerId." };
    const target = state.players[action.targetPlayerId];
    if (!target) return { ok: false, error: "Unknown target player." };
    const max = effectiveCommoditiesMax(state, action.targetPlayerId, rules.factions[target.factionId]?.commoditiesMax ?? 0);
    // RR "replenish": sets commodities TO max — a player already there gains 0, but this is still a genuine "replenish" event for whatever downstream effect (e.g. Trade Agreement) might care.
    players = { ...players, [action.targetPlayerId]: { ...target, commodities: max } };
  }

  return { ok: true, state: { ...state, players }, events: [] };
}

/**
 * Hacan "Production Biomes" (faction tech, exhaustable): "ACTION:
 * Exhaust this card and spend 1 token from your strategy pool to gain 4
 * trade goods and choose 1 other player; that player gains 2 trade
 * goods." No additional confirmed rulings beyond the printed text.
 */
export function useProductionBiomes(
  state: GameState,
  action: { type: "USE_PRODUCTION_BIOMES"; playerId: PlayerId; targetPlayerId: PlayerId },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.technologies.includes("production_biomes" as never)) {
    return { ok: false, error: "This player doesn't have Production Biomes." };
  }
  if (player.exhaustedTechnologies.includes("production_biomes" as never)) {
    return { ok: false, error: "Production Biomes is already exhausted." };
  }
  if (player.commandTokens.strategy <= 0) return { ok: false, error: "No command token in this player's strategy pool to spend." };
  const target = state.players[action.targetPlayerId];
  if (!target) return { ok: false, error: "Unknown target player." };

  const updatedPlayer: Player = {
    ...player,
    exhaustedTechnologies: [...player.exhaustedTechnologies, "production_biomes" as never],
    commandTokens: { ...player.commandTokens, strategy: player.commandTokens.strategy - 1 },
    tradeGoods: player.tradeGoods + 4,
  };
  const updatedTarget: Player = { ...target, tradeGoods: target.tradeGoods + 2 };
  return { ok: true, state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer, [action.targetPlayerId]: updatedTarget } }, events: [] };
}

/**
 * Hacan "Quantum Datahub Node" (faction tech): "At the end of the
 * strategy phase, you may spend 1 token from your strategy pool and
 * give another player 3 of your trade goods. If you do, give 1 of your
 * strategy cards to that player and take 1 of their strategy cards."
 * Confirmed (tirules2.com/F_hacan):
 *  - Trade goods already ON either strategy card stay with whoever
 *    ORIGINALLY chose it — not applicable here directly (this project's
 *    own strategy card model doesn't currently track trade goods
 *    sitting ON a card separately from the player who holds it), noted
 *    rather than silently assumed handled.
 *  - In a 3-4 player game (2 cards per player), Hacan chooses WHICH of
 *    their own and WHICH of the target's cards get swapped — handled by
 *    this action's own cardId/targetCardId parameters (the caller's
 *    choice).
 *  - Must have the 3 trade goods BEFORE spending the command token
 *    (can't use some OTHER effect mid-resolution to reach 3) — a
 *    sequencing note this project's own single-step validation already
 *    satisfies by construction (checked all at once, not staged).
 */
export function useQuantumDatahubNode(
  state: GameState,
  action: { type: "USE_QUANTUM_DATAHUB_NODE"; playerId: PlayerId; targetPlayerId: PlayerId; cardId: string; targetCardId: string },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.technologies.includes("quantum_datahub_node" as never)) {
    return { ok: false, error: "This player doesn't have Quantum Datahub Node." };
  }
  if (state.phase !== "strategy") return { ok: false, error: "Quantum Datahub Node is only usable at the end of the strategy phase." };
  if (player.commandTokens.strategy <= 0) return { ok: false, error: "No command token in this player's strategy pool to spend." };
  if (player.tradeGoods < 3) return { ok: false, error: "This player needs 3 trade goods." };

  const target = state.players[action.targetPlayerId];
  if (!target) return { ok: false, error: "Unknown target player." };
  const ownCard = player.strategyCards.find((c) => c.cardId === action.cardId);
  const targetCard = target.strategyCards.find((c) => c.cardId === action.targetCardId);
  if (!ownCard) return { ok: false, error: "This player doesn't have that strategy card." };
  if (!targetCard) return { ok: false, error: "That target doesn't have that strategy card." };

  const updatedPlayer: Player = {
    ...player,
    commandTokens: { ...player.commandTokens, strategy: player.commandTokens.strategy - 1 },
    tradeGoods: player.tradeGoods - 3,
    strategyCards: [...player.strategyCards.filter((c) => c.cardId !== action.cardId), targetCard],
  };
  const updatedTarget: Player = {
    ...target,
    tradeGoods: target.tradeGoods + 3,
    strategyCards: [...target.strategyCards.filter((c) => c.cardId !== action.targetCardId), ownCard],
  };
  return { ok: true, state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer, [action.targetPlayerId]: updatedTarget } }, events: [] };
}
