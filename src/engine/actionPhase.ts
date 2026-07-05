import { GameState, Player } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId } from "../types/ids";

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
 * no-op (returns the state unchanged) — it only does something at the exact
 * moment a phase's exit condition becomes true, so callers never have to
 * remember to check for it themselves.
 *
 * Implemented: RR 3.5 → RR 70 (the fully automatic bookkeeping steps of the
 * status phase: 70.4 remove tokens, 70.5 gain 2 + redistribute, 70.6 ready
 * cards/planets, 70.7 repair units, 70.8 return strategy cards) → RR 36.1
 * (agenda phase only once Mecatol's custodians token is gone, otherwise
 * straight back to a new strategy phase).
 *
 * NOT implemented (deliberately parked, see comments inline): RR 70.1 score
 * objectives and RR 70.2 reveal public objective / 70.3 draw action card —
 * these need player choice (70.1) or an ordered, revealable objective deck
 * (70.2) that isn't modeled yet. Until those land, the engine will happily
 * cycle rounds without anyone scoring — fine for exercising the turn
 * structure, not fine for an actual playthrough yet.
 */
export function autoAdvancePhase(state: GameState): { state: GameState; events: GameEvent[] } {
  if (state.phase !== "action") return { state, events: [] };
  if (state.activePlayerId !== null) return { state, events: [] };
  if (!Object.values(state.players).every((p) => p.hasPassed || p.eliminated)) {
    return { state, events: [] };
  }

  const events: GameEvent[] = [];
  let next = runStatusPhaseBookkeeping(state);
  events.push({ type: "PHASE_CHANGED", from: "action", to: "status", round: state.round });

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

function runStatusPhaseBookkeeping(state: GameState): GameState {
  const players: GameState["players"] = {};
  for (const [id, player] of Object.entries(state.players)) {
    players[id as PlayerId] = {
      ...player,
      // RR 70.4: command tokens on the board return to reinforcements (i.e. just removed; they're re-gained as fresh tokens in 70.5, not literally recycled).
      commandTokens: { ...player.commandTokens, onBoard: [] },
      // RR 70.6: ready all exhausted strategy cards. (Ready state for planets is handled below, per-system.)
      strategyCards: player.strategyCards.map((c) => ({ ...c, exhausted: false })),
    };
    // RR 70.5: gain 2 command tokens. Simplification: auto-placed in the strategy pool;
    // a future UI can offer redistribution as its own action before this runs.
    players[id as PlayerId].commandTokens = {
      ...players[id as PlayerId].commandTokens,
      strategy: players[id as PlayerId].commandTokens.strategy + 2,
    };
  }

  const systems: GameState["systems"] = {};
  for (const [id, system] of Object.entries(state.systems)) {
    systems[id as keyof typeof systems] = {
      ...system,
      planets: system.planets.map((p) => ({
        ...p,
        exhausted: false, // RR 70.6
        units: p.units.map((u) => ({ ...u, damagedCount: 0 })), // RR 70.7
      })),
      spaceUnitsByPlayer: Object.fromEntries(
        Object.entries(system.spaceUnitsByPlayer).map(([pid, stacks]) => [
          pid,
          stacks.map((u) => ({ ...u, damagedCount: 0 })), // RR 70.7
        ]),
      ),
    };
  }

  return { ...state, players, systems };
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
