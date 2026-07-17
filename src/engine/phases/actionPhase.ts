import { GameState, Player, PlanetState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, ObjectiveId, PlanetId, SystemId, asTechId } from "../types/ids";
import { ObjectiveKind } from "../types/enums";
import { RuleData } from "../types/RuleData";
import { OBJECTIVE_CHECKS, SPEND_CHECK_TYPES } from "../rules/objectiveChecks";
import { revealAgenda } from "./agendaPhase";
import { drawActionCard } from "./actionCards";

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
    lastPlayerToPass: action.playerId,
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
      next = { ...next, phase: "agenda", agendaPhaseAgendasResolved: 0 };
      events.push({ type: "PHASE_CHANGED", from: "status", to: "agenda", round: next.round });
      const revealed = revealAgenda(next);
      if (revealed.ok) {
        next = revealed.state;
        events.push(...revealed.events);
      }
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
  action: {
    type: "SCORE_OBJECTIVE";
    playerId: PlayerId;
    objectiveId: ObjectiveId;
    spend?: {
      exhaustPlanetIdsForResources?: PlanetId[];
      exhaustPlanetIdsForInfluence?: PlanetId[];
      tradeGoods?: number;
      commandTokens?: { tactic?: number; strategy?: number };
      relicFragments?: { cultural?: number; industrial?: number; hazardous?: number; unknown?: number };
    };
  },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };

  const objectiveData = rules.objectives[action.objectiveId];
  if (!objectiveData) return { ok: false, error: `No rule data for objective ${action.objectiveId}.` };

  // RR 52.3: most objectives (all public ones, most secrets) can only be
  // scored during the status phase — but several secrets score
  // opportunistically during the action or agenda phase instead, per their
  // own `timing`. Previously this was hardcoded to "status" for everything,
  // which silently made those secrets unscoreable.
  const expectedPhase = objectiveData.timing === "actionPhase" ? "action" : objectiveData.timing === "agendaPhase" ? "agenda" : "status";
  if (state.phase !== expectedPhase) {
    return {
      ok: false,
      error: `RR 52.3: this objective can only be scored during the ${objectiveData.timing} (currently in "${state.phase}").`,
    };
  }

  const publicMatch = state.objectives.find((o) => o.objectiveId === action.objectiveId && o.revealed);
  const isSecret = player.secretObjectives.includes(action.objectiveId);
  const kind: ObjectiveKind | null = publicMatch ? publicMatch.kind : isSecret ? "secret" : null;
  if (!kind) {
    return { ok: false, error: "Objective isn't revealed (public) or held (secret) by this player." };
  }

  // RR 70.1's "max 1 public + 1 secret per status phase" limit only applies
  // to the status-phase scoring window — actionPhase/agendaPhase-timed
  // secrets are opportunistic, no such cap on them.
  const scoring = state.statusPhaseScoring?.[action.playerId] ?? { scoredPublic: false, scoredSecret: false, done: false };
  if (objectiveData.timing === "statusPhase") {
    if (scoring.done) return { ok: false, error: "This player already finished scoring this status phase." };
    if (kind !== "secret" && scoring.scoredPublic) {
      return { ok: false, error: "RR 70.1: max 1 public objective per player per status phase." };
    }
    if (kind === "secret" && scoring.scoredSecret) {
      return { ok: false, error: "RR 70.1: max 1 secret objective per player per status phase." };
    }
  }

  const core = scoreObjectiveCore(state, action.playerId, action.objectiveId, action.spend, rules);
  if (!core.ok) return core;

  let nextState: GameState = core.state;
  if (objectiveData.timing === "statusPhase") {
    nextState = {
      ...nextState,
      statusPhaseScoring: {
        ...nextState.statusPhaseScoring,
        [action.playerId]: {
          ...scoring,
          scoredPublic: scoring.scoredPublic || kind !== "secret",
          scoredSecret: scoring.scoredSecret || kind === "secret",
        },
      },
    };
  }

  return { ok: true, state: nextState, events: core.events };
}

/**
 * The actual RR 52 scoring mechanics (validate condition, spend if needed,
 * award points, check for a win) with NO phase restriction and NO RR
 * 70.1 "max 1 public + 1 secret per status phase" bookkeeping — those are
 * specific to the normal status-phase scoring window (see scoreObjective
 * above, which wraps this). The Imperial strategy card's primary ability
 * scores a public objective during the STRATEGY phase, completely outside
 * that window and its once-per-status-phase limit, so it calls this
 * directly instead (see phases/strategyCardAbilities.ts).
 */
export function scoreObjectiveCore(
  state: GameState,
  playerId: PlayerId,
  objectiveId: ObjectiveId,
  spend:
    | {
        exhaustPlanetIdsForResources?: PlanetId[];
        exhaustPlanetIdsForInfluence?: PlanetId[];
        tradeGoods?: number;
        commandTokens?: { tactic?: number; strategy?: number };
        relicFragments?: { cultural?: number; industrial?: number; hazardous?: number; unknown?: number };
      }
    | undefined,
  rules: RuleData,
): ActionResult {
  const player = state.players[playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (player.victoryPoints.scoredObjectiveIds.includes(objectiveId)) {
    return { ok: false, error: "RR 52.8: this objective has already been scored by this player." };
  }

  const objectiveData = rules.objectives[objectiveId];
  if (!objectiveData) return { ok: false, error: `No rule data for objective ${objectiveId}.` };

  let workingState = state;
  if (objectiveData.checkType === "manual") {
    // Trusts the caller — see data/objectives.json's own note on why this objective isn't validated yet.
  } else if (SPEND_CHECK_TYPES.has(objectiveData.checkType)) {
    const spendResult = executeObjectiveSpend(workingState, playerId, spend ?? {}, rules);
    if (!spendResult.ok) return spendResult;
    workingState = spendResult.state;
    const met = checkSpendRequirement(objectiveData.checkType, objectiveData.checkParams, spendResult.spent);
    if (!met.met) return { ok: false, error: `RR 52: ${met.reason}` };
  } else {
    const checkFn = OBJECTIVE_CHECKS[objectiveData.checkType];
    if (!checkFn) return { ok: false, error: `No checker registered for checkType "${objectiveData.checkType}".` };
    const result = checkFn({ state: workingState, rules, playerId }, objectiveData.checkParams);
    if (!result.met) return { ok: false, error: `RR 52: condition not met — ${result.reason ?? "requirement not satisfied."}` };
  }

  const points = objectiveData.points;
  const scoringPlayer = workingState.players[playerId];
  const updatedPlayer: Player = {
    ...scoringPlayer,
    victoryPoints: {
      current: scoringPlayer.victoryPoints.current + points,
      scoredObjectiveIds: [...scoringPlayer.victoryPoints.scoredObjectiveIds, objectiveId],
    },
  };

  let nextState: GameState = { ...workingState, players: { ...workingState.players, [playerId]: updatedPlayer } };
  const events: GameEvent[] = [{ type: "OBJECTIVE_SCORED", playerId, objectiveId, points }];

  // RR 87: first to the target wins outright — doesn't yet handle the tie-break rule for two players crossing in the same status phase (RR 87.3-ish), flagged rather than guessed.
  if (!nextState.winnerId && updatedPlayer.victoryPoints.current >= state.victoryPointTarget) {
    nextState = { ...nextState, winnerId: playerId };
    events.push({ type: "GAME_ENDED", winnerId: playerId });
  }

  return { ok: true, state: nextState, events };
}

interface SpentAmounts {
  resources: number;
  influence: number;
  tradeGoods: number;
  commandTokens: number;
  relicFragments: number;
}

function checkSpendRequirement(
  checkType: string,
  params: Record<string, unknown>,
  spent: SpentAmounts,
): { met: boolean; reason?: string } {
  switch (checkType) {
    case "spend_resources":
      return spent.resources >= (params.amount as number)
        ? { met: true }
        : { met: false, reason: `Spent ${spent.resources}/${params.amount} resources.` };
    case "spend_influence":
      return spent.influence >= (params.amount as number)
        ? { met: true }
        : { met: false, reason: `Spent ${spent.influence}/${params.amount} influence.` };
    case "spend_trade_goods":
      return spent.tradeGoods >= (params.amount as number)
        ? { met: true }
        : { met: false, reason: `Spent ${spent.tradeGoods}/${params.amount} trade goods.` };
    case "spend_command_tokens":
      return spent.commandTokens >= (params.amount as number)
        ? { met: true }
        : { met: false, reason: `Spent ${spent.commandTokens}/${params.amount} command tokens.` };
    case "spend_relic_fragments":
      return spent.relicFragments >= (params.amount as number)
        ? { met: true }
        : { met: false, reason: `Purged ${spent.relicFragments}/${params.amount} relic fragments.` };
    case "spend_combined": {
      const need = params as { influence: number; resources: number; tradeGoods: number };
      const met = spent.influence >= need.influence && spent.resources >= need.resources && spent.tradeGoods >= need.tradeGoods;
      return met
        ? { met: true }
        : {
            met: false,
            reason: `Needed ${need.influence}/${need.resources}/${need.tradeGoods} (influence/resources/trade goods), spent ${spent.influence}/${spent.resources}/${spent.tradeGoods}.`,
          };
    }
    default:
      return { met: false, reason: `Unknown spend checkType "${checkType}".` };
  }
}

/** Actually exhausts the planets/spends the trade goods/command tokens the player specified, returning both the updated state and a tally of what was spent (for checkSpendRequirement to compare against the objective's required amount). */
function executeObjectiveSpend(
  state: GameState,
  playerId: PlayerId,
  spend: NonNullable<Parameters<typeof scoreObjective>[1]["spend"]>,
  rules: RuleData,
): { ok: true; state: GameState; spent: SpentAmounts } | { ok: false; error: string } {
  let nextState = state;
  let resources = 0;
  let influence = 0;

  for (const planetId of spend.exhaustPlanetIdsForResources ?? []) {
    const found = findControlledPlanet(nextState, playerId, planetId);
    if (!found) return { ok: false, error: `This player doesn't control ${planetId}.` };
    if (found.planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };
    const data = rules.planets[planetId];
    if (!data) return { ok: false, error: `No static data for ${planetId}.` };
    resources += data.resources;
    nextState = setPlanetExhausted(nextState, found.systemId, planetId, true);
  }

  for (const planetId of spend.exhaustPlanetIdsForInfluence ?? []) {
    const found = findControlledPlanet(nextState, playerId, planetId);
    if (!found) return { ok: false, error: `This player doesn't control ${planetId}.` };
    if (found.planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };
    const data = rules.planets[planetId];
    if (!data) return { ok: false, error: `No static data for ${planetId}.` };
    influence += data.influence;
    nextState = setPlanetExhausted(nextState, found.systemId, planetId, true);
  }

  const tradeGoods = spend.tradeGoods ?? 0;
  const tacticTokens = spend.commandTokens?.tactic ?? 0;
  const strategyTokens = spend.commandTokens?.strategy ?? 0;
  const commandTokens = tacticTokens + strategyTokens;

  const player = nextState.players[playerId];
  if (tradeGoods > player.tradeGoods) return { ok: false, error: "Not enough trade goods." };
  if (tacticTokens > player.commandTokens.tactic) return { ok: false, error: "Not enough tactic command tokens." };
  if (strategyTokens > player.commandTokens.strategy) return { ok: false, error: "Not enough strategy command tokens." };

  // RR "Destroy Heretical Works": purge 2 relic fragments of ANY type
  // (mixed types allowed) — deliberately does NOT grant a relic, unlike
  // PURGE_RELIC_FRAGMENTS (RR 35.9's normal 3-for-1 exchange). A separate,
  // smaller spend, not a shortcut through the normal relic-purge action.
  const fragmentSpend = spend.relicFragments ?? { cultural: 0, industrial: 0, hazardous: 0, unknown: 0 };
  const relicFragments = (fragmentSpend.cultural ?? 0) + (fragmentSpend.industrial ?? 0) + (fragmentSpend.hazardous ?? 0) + (fragmentSpend.unknown ?? 0);
  for (const key of ["cultural", "industrial", "hazardous", "unknown"] as const) {
    const amount = fragmentSpend[key] ?? 0;
    if (amount > player.relicFragments[key]) return { ok: false, error: `Not enough ${key} relic fragments.` };
  }

  nextState = {
    ...nextState,
    players: {
      ...nextState.players,
      [playerId]: {
        ...player,
        tradeGoods: player.tradeGoods - tradeGoods,
        commandTokens: {
          ...player.commandTokens,
          tactic: player.commandTokens.tactic - tacticTokens,
          strategy: player.commandTokens.strategy - strategyTokens,
        },
        relicFragments: {
          cultural: player.relicFragments.cultural - (fragmentSpend.cultural ?? 0),
          industrial: player.relicFragments.industrial - (fragmentSpend.industrial ?? 0),
          hazardous: player.relicFragments.hazardous - (fragmentSpend.hazardous ?? 0),
          unknown: player.relicFragments.unknown - (fragmentSpend.unknown ?? 0),
        },
      },
    },
  };

  return { ok: true, state: nextState, spent: { resources, influence, tradeGoods, commandTokens, relicFragments } };
}

function findControlledPlanet(state: GameState, playerId: PlayerId, planetId: PlanetId): { systemId: SystemId; planet: PlanetState } | null {
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === planetId);
    if (planet && planet.controllerId === playerId) return { systemId: systemId as SystemId, planet };
  }
  return null;
}

function setPlanetExhausted(state: GameState, systemId: SystemId, planetId: PlanetId, exhausted: boolean): GameState {
  const system = state.systems[systemId];
  return {
    ...state,
    systems: {
      ...state.systems,
      [systemId]: {
        ...system,
        planets: system.planets.map((p: PlanetState) => (p.planetId === planetId ? { ...p, exhausted } : p)),
      },
    },
  };
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

fu
