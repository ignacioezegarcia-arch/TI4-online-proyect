import { GameState, Player, PlanetState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, ObjectiveId, PlanetId, SystemId, AgendaId, asTechId, asAbilityId, asLeaderId } from "../types/ids";
import { ObjectiveKind, SHIP_TYPES, GROUND_FORCE_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { OBJECTIVE_CHECKS, SPEND_CHECK_TYPES } from "../rules/objectiveChecks";
import { revealAgenda } from "./agendaPhase";
import { drawActionCard } from "./actionCards";
import { placeGainedCommandTokens } from "../rules/commandTokens";
import { getLawOwner } from "./agendaEffects";
import { maybeGainCrownOfEmphidiaVictoryPoint } from "../rules/relics";
import { hasAbility } from "../rules/abilities";
import { checkReinforcementsAvailable } from "../rules/reinforcements";
import { maybeUnlockHero, purgeHero } from "../rules/leaders";
import { placeRespawnedSpecOps } from "../rules/sol";
import { maybeReturnGiftOfPrescience } from "../rules/naalu";
import { applySchemingToDrawCount, drawActionCardsForPlayer } from "../rules/yssaril";
import { hasCodex } from "../rules/gameMode";
import { use4X41DHyperionVI, useMaxisCentralControl, useDokNPicsSalvageYardStore, useAeurexMechanica } from "./legendaryPlanets";
import { actionPhaseWindowOrder } from "../rules/priorityWindow";
import { agendaPhaseWindowOrder } from "../rules/priorityWindow";

/**
 * RR 3.2-3.5 PASS.
 * A player cannot pass until their strategy card(s) are exhausted, i.e.
 * they've resolved their strategic action for the round (RR 3.4, and the
 * 3-4p "both cards" variant). Passing does not end the action phase by
 * itself — see autoAdvancePhase, which is what actually notices "everyone's
 * done" and moves things along.
 */
export function pass(
  state: GameState,
  action: {
    type: "PASS";
    playerId: PlayerId;
    whenYouPassAbility?:
      | { kind: "4x41d_hyperion_vi"; commandTokenPool: "tactic" | "fleet" | "strategy" }
      | { kind: "maxis_central_control"; targetPlanetId: PlanetId; chosenTrait?: "cultural" | "industrial" | "hazardous" }
      | { kind: "dok_n_pics_salvage_yard_store"; cardId: string }
      | { kind: "aeurex_mechanica"; unitUpgradeId: import("../types/ids").UnitUpgradeId; targetSystemId: SystemId };
  },
  rules: RuleData,
): ActionResult {
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

  // RR "when you pass" legendary planet abilities — resolved as part of THIS same action, before hasPassed actually flips, since each one's own underlying function doesn't care about pass status but the ability itself is meant to trigger right at this moment.
  let workingState: GameState = state;
  const events: GameEvent[] = [];
  if (action.whenYouPassAbility) {
    const w = action.whenYouPassAbility;
    let abilityResult: ActionResult;
    if (w.kind === "4x41d_hyperion_vi") {
      abilityResult = use4X41DHyperionVI(workingState, { type: "USE_4X41D_HYPERION_VI", playerId: action.playerId, commandTokenPool: w.commandTokenPool });
    } else if (w.kind === "maxis_central_control") {
      abilityResult = useMaxisCentralControl(workingState, { type: "USE_MAXIS_CENTRAL_CONTROL", playerId: action.playerId, targetPlanetId: w.targetPlanetId, chosenTrait: w.chosenTrait }, rules);
    } else if (w.kind === "dok_n_pics_salvage_yard_store") {
      abilityResult = useDokNPicsSalvageYardStore(workingState, { type: "USE_DOK_N_PICS_SALVAGE_YARD_STORE", playerId: action.playerId, cardId: w.cardId });
    } else {
      abilityResult = useAeurexMechanica(workingState, { type: "USE_AEUREX_MECHANICA", playerId: action.playerId, unitUpgradeId: w.unitUpgradeId, targetSystemId: w.targetSystemId }, rules);
    }
    if (!abilityResult.ok) return abilityResult;
    workingState = abilityResult.state;
    events.push(...abilityResult.events);
  }

  const updatedPlayer: Player = { ...workingState.players[action.playerId], hasPassed: true };
  let nextState: GameState = {
    ...workingState,
    players: { ...workingState.players, [action.playerId]: updatedPlayer },
    lastPlayerToPass: action.playerId,
  };
  // RR: "at the end of your turn" abilities (The Acropolis, The Galactic
  // Council) and TE "Crisis"/"Puppets on a String" all need the
  // end_of_turn window to open here too — passing IS a player's own turn
  // ending, same as taking a normal action and having
  // maybeAdvanceActivePlayer decide there's nothing more to do. Calls
  // openEndOfTurnWindow DIRECTLY (not maybeAdvanceActivePlayer) since a
  // passing player never gets a Fleet Logistics/Master Plan bonus action
  // — those checks would be wrong to apply here.
  nextState = openEndOfTurnWindow(nextState, action.playerId, rules);

  return { ok: true, state: nextState, events: [{ type: "PLAYER_PASSED", playerId: action.playerId }, ...events] };
}

/**
 * RR 4.2/4.3: after a turn, the next player in initiative order who hasn't
 * passed becomes active, wrapping around and skipping passed players. If
 * everyone has passed, there's no active player — autoAdvancePhase (below)
 * picks that up and moves to the status phase.
 */
export function advanceActivePlayer(state: GameState, rules?: RuleData): GameState {
  const order = state.initiativeOrder;
  if (order.length === 0 || order.every((id) => state.players[id].hasPassed)) {
    return { ...state, activePlayerId: null };
  }
  const currentIndex = state.activePlayerId ? order.indexOf(state.activePlayerId) : -1;
  let skipsRemaining = 1;
  for (let i = 1; i <= order.length * 2; i++) {
    const candidate = order[(currentIndex + i) % order.length];
    if (state.players[candidate].hasPassed) continue;
    // TE "Crisis": this specific player's upcoming turn is skipped once — consumed here, then normal advancement continues to whoever's after them.
    if (candidate === state.skipNextTurnForPlayerId && skipsRemaining > 0) {
      skipsRemaining -= 1;
      continue;
    }
    // RR (yjmrobert.com/tirules/rules/r_transactions): the "1 per neighbor" transaction allowance is scoped to "the active player's turn" — a fresh turn starting (a new active player) resets it.
    let nextState: GameState = { ...state, activePlayerId: candidate, activePlayerActionsTaken: 0, transactionsThisTurn: undefined, skipNextTurnForPlayerId: undefined, usedMilitarySupportForActivePlayerTurn: undefined, usedChaosMappingForActivePlayerTurn: undefined };
    // Sol "Spec Ops II" (RESPAWN): "at the start of your next turn, place each unit that is on this card..." — right here, as this player actually becomes active again.
    if (rules) nextState = placeRespawnedSpecOps(nextState, candidate, rules);
    // TE "Extreme Duress": "At the start of another player's turn, if
    // they have a readied strategy card" — opened here, right as a new
    // player actually becomes active, for every OTHER player to
    // optionally react. Doesn't apply to the player whose turn is
    // starting (they can't play it against themselves).
    const hasReadiedStrategyCard = nextState.players[candidate]?.strategyCards.some((c) => !c.exhausted);
    if (hasReadiedStrategyCard) {
      const eligibleIds = Object.keys(nextState.players).filter((id) => id !== candidate && !nextState.players[id as PlayerId]?.eliminated) as PlayerId[];
      const turnStartOrder = actionPhaseWindowOrder(nextState, candidate, eligibleIds);
      if (turnStartOrder.length > 0) {
        nextState = { ...nextState, pendingPriorityWindow: { kind: "turn_start", order: turnStartOrder, currentIndex: 0, consecutivePasses: 0 } };
      }
    }
    return nextState;
  }
  return { ...state, activePlayerId: null, skipNextTurnForPlayerId: undefined };
}

/**
 * RR "Fleet Logistics": the shared entry point every "a tactical/component
 * action for the CURRENT active player just finished" call site uses
 * instead of calling advanceActivePlayer directly — PASS is the one
 * exception (see GameState.ts's own note on activePlayerActionsTaken for
 * why). If this player owns Fleet Logistics and hasn't yet used their
 * second action this turn-in-rotation, the turn does NOT advance (they
 * stay active, free to submit another ACTIVATE_SYSTEM/component action, or
 * PASS if they'd rather stop early); otherwise this behaves exactly like
 * advanceActivePlayer.
 */
export function maybeAdvanceActivePlayer(state: GameState, playerId: PlayerId, rules?: RuleData): GameState {
  const player = state.players[playerId];
  const actionsSoFar = state.activePlayerActionsTaken ?? 0;
  // TE "Puppets on a String": "The active player cannot use the Fleet Logistics technology to perform an additional action" during their own Puppets-granted turn — skipped entirely here; Master Plan's own separate bonus (below) is untouched.
  if (!state.puppetsOnAStringActive && player?.technologies.includes(asTechId("fleet_logistics")) && actionsSoFar < 1) {
    return { ...state, activePlayerActionsTaken: actionsSoFar + 1 };
  }
  // RR "Master Plan": same "stay active for 1 more action" shape as Fleet Logistics above, granted by the action card instead of a tech — consumed the moment it's used (unlike Fleet Logistics, which is a standing ability every turn).
  if (player?.masterPlanBonusAvailable) {
    return { ...state, players: { ...state.players, [playerId]: { ...player, masterPlanBonusAvailable: false } } };
  }
  // TE "Puppets on a String": their own granted action is over — restore hasPassed (RR: "the active player is still considered passed during their action; they do not pass again at the end") and clear the flag, WITHOUT opening the shared end_of_turn window below (per RR: "it is not considered the turn of the player who played Puppets On A String for game effects" — no "end of your turn" reactions for this specific, borrowed turn).
  if (state.puppetsOnAStringActive) {
    return { ...advanceActivePlayer({ ...state, players: { ...state.players, [playerId]: { ...player, hasPassed: true } }, puppetsOnAStringActive: undefined }, rules) };
  }
  return openEndOfTurnWindow(state, playerId, rules);
}

/**
 * TE "Crisis"/"Puppets on a String" + RR "at the end of your turn"
 * legendary planet abilities (The Acropolis, The Galactic Council): the
 * actual "is this turn over" moment, shared by maybeAdvanceActivePlayer
 * above (called AFTER its own Fleet Logistics/Master Plan bonus-action
 * checks) and phases/actionPhase.ts's own pass() (called DIRECTLY,
 * skipping those checks — a passing player never gets a bonus action
 * from either of those, whether or not they own Fleet Logistics or have
 * an unused Master Plan). Every non-eliminated player gets a chance to
 * react (each card's own function checks its own further eligibility);
 * finishEndOfTurn is what actually calls advanceActivePlayer once this
 * window closes (see GameEngine.ts's own end_of_turn window-close
 * handling).
 */
export function openEndOfTurnWindow(state: GameState, playerId: PlayerId, rules?: RuleData): GameState {
  const eligibleIds = Object.keys(state.players).filter((id) => !state.players[id as PlayerId]?.eliminated) as PlayerId[];
  const order = actionPhaseWindowOrder(state, playerId, eligibleIds);
  if (order.length > 0) {
    return { ...state, pendingPriorityWindow: { kind: "end_of_turn", order, currentIndex: 0, consecutivePasses: 0 } };
  }
  return advanceActivePlayer(state, rules);
}

/**
 * TE "Crisis"/"Puppets on a String" + RR "at the end of your turn"
 * legendary planet abilities: the continuation once the end_of_turn
 * window (opened by openEndOfTurnWindow above) actually closes.
 * Previously this jumped straight to advanceActivePlayer, silently
 * skipping the SAME "does this player still get a bonus action"
 * check maybeAdvanceActivePlayer itself makes — meaning "Jupiter Brain"
 * (Thunder's Edge's own legendary ability, usable ONLY inside this exact
 * window) granting its bonus action would have been ignored the moment
 * the window closed. Fixed: checks masterPlanBonusAvailable here too
 * (the same flag Jupiter Brain sets, reusing Master Plan's own
 * mechanism) before finally advancing — deliberately NOT re-opening
 * end_of_turn again for this same turn-ending (that already happened
 * once; Jupiter Brain's own bonus action is a genuinely separate turn
 * that will get its own end_of_turn opportunity when IT concludes).
 */
export function finishEndOfTurn(state: GameState, rules?: RuleData): GameState {
  const activePlayerId = state.activePlayerId;
  const player = activePlayerId ? state.players[activePlayerId] : undefined;
  if (player?.masterPlanBonusAvailable) {
    return { ...state, players: { ...state.players, [activePlayerId!]: { ...player, masterPlanBonusAvailable: false } } };
  }
  return advanceActivePlayer(state, rules);
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
export function autoAdvancePhase(state: GameState, rules: RuleData): { state: GameState; events: GameEvent[] } {
  // RR 1.19/1.20: never advance a phase while a priority window (or a
  // Sabotage-eligible action-card announcement) is still open — see
  // GameEngine.ts's own announceActionCard/rules/priorityWindow.ts. Not a
  // realistic case today (nothing currently causes activePlayerId to go
  // null or every status-phase player to finish scoring WHILE a window is
  // open), but a real one could exist once faction/leader/relic abilities
  // add more trigger points, so this is a deliberate, cheap guard rather
  // than an assumption this can never happen.
  if (state.pendingPriorityWindow || state.pendingActionCardAnnouncement) return { state, events: [] };

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

    // RR 20/70.5: bookkeeping (including queuing each player's own
    // command-token gain) only runs ONCE — the first time every player's
    // finished scoring. Later calls to this function while some of those
    // gains are still unplaced must NOT re-run it (that would re-draw
    // action cards, re-ready planets, etc. a second time).
    let next = state;
    let events: GameEvent[] = [];
    if (state.pendingCommandTokenGains === undefined) {
      const bookkeeping = runStatusPhaseBookkeeping(state, rules);
      next = bookkeeping.state;
      events = [...bookkeeping.events];
      // RR 61.15/81.2b: the game may have just ended right here (no public
      // objectives left to reveal) — if so, stop immediately, before any
      // of the rest of the status phase's own steps or phase transitions.
      if (next.winnerId) return { state: next, events };
    }

    // RR 20/70.5: the status phase can't actually finish until every
    // player has placed their own newly-gained command tokens (their own
    // choice of pool) — see PLACE_GAINED_COMMAND_TOKENS.
    if (Object.keys(next.pendingCommandTokenGains ?? {}).length > 0) {
      return { state: next, events };
    }

    // RR "Political Stability": every player gets 1 last chance, right
    // before strategy cards actually return to the common play area, to
    // keep theirs instead — same "block until resolved, once" shape as
    // pendingCommandTokenGains just above. statusPhaseStrategyReturnWindowDone
    // is the one-shot marker (mirroring pendingCommandTokenGains ===
    // undefined's own role) so this doesn't re-open every time
    // autoAdvancePhase re-runs after the window has already closed.
    if (!next.statusPhaseStrategyReturnWindowDone) {
      if (!next.pendingPriorityWindow) {
        const order = agendaPhaseWindowOrder(next).filter((id) => !next.players[id]?.eliminated);
        if (order.length > 0) {
          return { state: { ...next, pendingPriorityWindow: { kind: "status_phase_strategy_card_return", order, currentIndex: 0, consecutivePasses: 0 } }, events };
        }
      } else if (next.pendingPriorityWindow.kind === "status_phase_strategy_card_return") {
        return { state: next, events };
      }
      next = { ...next, statusPhaseStrategyReturnWindowDone: true };
    }

    if (state.mecatolCustodiansRemoved) {
      // RR "Ancient Burial Sites": every player gets 1 chance, right as
      // the agenda phase is ABOUT to begin, before even the first agenda
      // is revealed — same one-shot-marker shape as
      // statusPhaseStrategyReturnWindowDone just above.
      if (!next.agendaPhaseStartWindowDone) {
        if (!next.pendingPriorityWindow) {
          const order = agendaPhaseWindowOrder(next).filter((id) => !next.players[id]?.eliminated);
          if (order.length > 0) {
            return { state: { ...next, pendingPriorityWindow: { kind: "agenda_phase_start", order, currentIndex: 0, consecutivePasses: 0 } }, events };
          }
        } else if (next.pendingPriorityWindow.kind === "agenda_phase_start") {
          return { state: next, events };
        }
        next = { ...next, agendaPhaseStartWindowDone: true };
      }

      next = { ...next, phase: "agenda", agendaPhaseAgendasResolved: 0, agendaPhaseBannedFromVoting: [] };
      events.push({ type: "PHASE_CHANGED", from: "status", to: "agenda", round: next.round });
      const revealed = revealAgenda(next, rules);
      if (revealed.ok) {
        next = revealed.state;
        events.push(...revealed.events);
      }
    } else {
      next = startNewRound(next, rules);
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

  // RR 61.16: a player cannot score PUBLIC objectives at all unless they
  // control every planet in their own home system — previously unchecked
  // entirely. Secrets are unaffected (RR only names public objectives).
  // Clan of Saar "NOMADIC" (faction ability): "You can score objectives
  // even if you do not control the planets in your home system" — the
  // confirmed, sole exception to this rule.
  if (kind !== "secret" && !hasAbility(player, asAbilityId("nomadic"))) {
    const homeSystemId = rules.homeSystemByFaction[player.factionId] as SystemId | undefined;
    const homeSystem = homeSystemId ? state.systems[homeSystemId] : undefined;
    const controlsWholeHomeSystem = homeSystem ? homeSystem.planets.every((p) => p.controllerId === action.playerId) : false;
    if (!controlsWholeHomeSystem) {
      return { ok: false, error: "RR 61.16: this player cannot score public objectives — they don't control every planet in their own home system." };
    }
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
  // RR "The Silver Flame" (relic): "you cannot score public objectives" — a standing restriction once triggered.
  if (objectiveData.kind !== "secret" && player.cannotScorePublicObjectives) {
    return { ok: false, error: 'RR "The Silver Flame": this player cannot score public objectives.' };
  }

  // RR 61.16: same check as scoreObjective's own wrapper — repeated here
  // since Imperial's strategy card ability calls this core function
  // DIRECTLY, bypassing that wrapper entirely (see this function's own
  // header note on why). Simplification, flagged: keyed off each
  // objective's own STATIC kind (rules.objectives[...].kind), so a
  // Classified Document Leaks-converted secret (which behaves like a
  // public objective at runtime, but is still statically "secret" in the
  // data it was printed with) is not caught by this specific check —
  // same category as this project's other rare, acknowledged edge cases.
  if (objectiveData.kind !== "secret" && !hasAbility(player, asAbilityId("nomadic"))) {
    const homeSystemId = rules.homeSystemByFaction[player.factionId] as SystemId | undefined;
    const homeSystem = homeSystemId ? state.systems[homeSystemId] : undefined;
    const controlsWholeHomeSystem = homeSystem ? homeSystem.planets.every((p) => p.controllerId === playerId) : false;
    if (!controlsWholeHomeSystem) {
      return { ok: false, error: "RR 61.16: this player cannot score public objectives — they don't control every planet in their own home system." };
    }
  }

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

  // RR "Leaders": every hero's own unlock condition is universally "3 scored objectives" — checked generically here for whichever hero THIS player's own faction has, right after their own scoredObjectiveIds count could have just crossed that threshold. Previously never hooked in anywhere at all, for any faction.
  const heroLeaderId = rules.factionLeaders[updatedPlayer.factionId]?.hero?.id;
  if (heroLeaderId) {
    const unlockedPlayer = maybeUnlockHero(nextState.players[playerId], asLeaderId(heroLeaderId));
    nextState = { ...nextState, players: { ...nextState.players, [playerId]: unlockedPlayer } };
  }

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

function runStatusPhaseBookkeeping(state: GameState, rules: RuleData): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];

  // RR 61.15/81.2b: if there are no unrevealed public objectives left at
  // all (both stages exhausted), the game ends IMMEDIATELY right here —
  // before any of the rest of the status phase's own steps (action card
  // draw, command tokens, readying, repairs) even run. Previously
  // unchecked entirely: with both decks seeded and drained, this
  // function would just silently skip the reveal and continue on to a
  // phantom extra round forever.
  if (state.publicObjectiveDeck && state.publicObjectiveDeck.stageI.length === 0 && state.publicObjectiveDeck.stageII.length === 0) {
    const candidates = Object.values(state.players).filter((p) => !p.eliminated);
    const maxVp = Math.max(0, ...candidates.map((p) => p.victoryPoints.current));
    const tied = candidates.filter((p) => p.victoryPoints.current === maxVp);
    // RR 61.15a/98.8: ties go to whoever is earliest in initiative order.
    const winnerId = (state.initiativeOrder.find((id) => tied.some((p) => p.id === id)) ?? tied[0]?.id) as PlayerId | undefined;
    if (winnerId) {
      return { state: { ...state, winnerId }, events: [{ type: "GAME_ENDED", winnerId }] };
    }
  }

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

  // RR 70.3: each non-eliminated player draws 1 action card. RR 2.9:
  // reshuffles the discard pile into a fresh deck first if the deck is
  // empty — see phases/actionCards.ts's drawActionCard, shared with any
  // other future draw site rather than duplicating the reshuffle-check.
  let actionCardDeck = state.actionCardDeck ? [...state.actionCardDeck] : [];
  let actionCardDiscardPile = state.actionCardDiscardPile ? [...state.actionCardDiscardPile] : [];
  let players: GameState["players"] = {};
  const pendingCommandTokenGains: Partial<Record<PlayerId, number>> = {};
  const pendingSchemingDiscards: PlayerId[] = [];
  const pendingWormholeGeneratorPlacements: PlayerId[] = [];
  for (const [id, player] of Object.entries(state.players)) {
    // Ghosts of Creuss "Wormhole Generator" (original/base version):
    // "At the start of the status phase, place or move a Creuss
    // wormhole token..." — confirmed mandatory (yjmrobert.com/tirules/factions/f_creuss).
    // The Codex Ω version is an exhaustable ACTION instead, not tied to
    // this trigger at all — see rules/creuss.ts's own useWormholeGeneratorOmega.
    if (player.factionId === ("creuss" as never) && player.technologies.includes("wormhole_generator" as never) && !hasCodex(state.mode) && !player.eliminated) {
      pendingWormholeGeneratorPlacements.push(id as PlayerId);
    }
    let updatedPlayer: Player = {
      ...player,
      // RR 70.4: command tokens on the board return to reinforcements (i.e. just removed; they're re-gained as fresh tokens in 70.5, not literally recycled).
      commandTokens: { ...player.commandTokens, onBoard: [] },
      // RR 70.6: ready all exhausted strategy cards. (Ready state for planets is handled below, per-system.)
      strategyCards: player.strategyCards.map((c) => ({ ...c, exhausted: false })),
      // RR 70.6-adjacent: readies every exhausted TECH card too, same as strategy cards/planets.
      exhaustedTechnologies: [],
      // RR: readies every exhausted RELIC too — everything exhausted during the action phase readies at the end of the status phase, same general rule as strategy cards/planets/techs above.
      exhaustedRelics: [],
      // Arborec "Psychospore" (Breakthrough ability): same readying as the above — see this file's own doc comment on why hasBreakthrough alone wasn't enough for this specific card.
      breakthroughExhausted: false,
      // RR "Agents" (confirmed by this project's own user): exhausting an agent to use its ability, then readying it at the end of the status phase — same general "exhausted during the action phase, readies at the end of the status phase" rule as everything else here. Commanders/heroes don't normally have an exhaust/ready cycle at all (they're unlock-once, standing-effect leaders) — resetting exhausted unconditionally on every leader entry is harmless for those (already false, stays false) and correct for any exhaust-ability commander/hero too, not just agents specifically.
      leaders: player.leaders.map((l) => ({ ...l, exhausted: false })),
    };
    // RR 70.5: gain 2 command tokens — 3 instead, with Hyper Metabolism.
    // Confirmed: the PLAYER decides which pool(s) these go into — queued
    // here (see GameState.ts's own doc comment on pendingCommandTokenGains)
    // rather than auto-assigned, resolved via PLACE_GAINED_COMMAND_TOKENS.
    // Sol's own "VERSATILE" faction ability: "When you gain command
    // tokens during the status phase, gain 1 additional command token"
    // — stacks with Hyper Metabolism (a Sol player with both technologies
    // and abilities gains 4, not just 3).
    const commandTokenGain = (player.technologies.includes(asTechId("hyper_metabolism")) ? 3 : 2) + (hasAbility(player, asAbilityId("versatile")) ? 1 : 0);
    pendingCommandTokenGains[id as PlayerId] = commandTokenGain;

    if (!player.eliminated) {
      // Neural Motivator: draw 2 action cards instead of 1 — just runs the
      // same drawActionCard (with its own reshuffle-on-empty) an extra time.
      // Yssaril Tribes "SCHEMING": "when you draw 1+ action cards, draw 1
      // additional" — applied to the TOTAL requested count here (capped at
      // +1 regardless of how many were already being drawn), then a
      // mandatory discard gets queued below once any cards were actually
      // drawn — see rules/yssaril.ts's own applySchemingToDrawCount/discardSchemingCard.
      const baseDraws = player.technologies.includes(asTechId("neural_motivator")) ? 2 : 1;
      const drawResult = drawActionCardsForPlayer({ ...state, actionCardDeck, actionCardDiscardPile, players: { ...state.players, [id]: updatedPlayer }, pendingSchemingDiscards }, player.id, baseDraws);
      actionCardDeck = drawResult.state.actionCardDeck ?? [];
      actionCardDiscardPile = drawResult.state.actionCardDiscardPile ?? [];
      updatedPlayer = drawResult.state.players[player.id];
      events.push(...drawResult.events);
      pendingSchemingDiscards.length = 0;
      pendingSchemingDiscards.push(...(drawResult.state.pendingSchemingDiscards ?? []));
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
        // RR 53's legendary planet ability card readies independently in
        // spirit, but the status phase readies EVERY exhausted card
        // (RR 70.6), so in practice both flip together here regardless.
        ...(p.legendaryAbilityExhausted ? { legendaryAbilityExhausted: false } : {}),
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

  // RR "Minister of Policy": at the end of the status phase, the owner draws 1 additional action card — same reshuffle-on-empty draw as everyone else's RR 70.3 draw above.
  const ministerOfPolicyOwnerId = getLawOwner({ ...state, players }, "minister_of_policy" as AgendaId);
  if (ministerOfPolicyOwnerId && players[ministerOfPolicyOwnerId]) {
    const drawResult = drawActionCardsForPlayer({ ...state, actionCardDeck, actionCardDiscardPile, players, pendingSchemingDiscards }, ministerOfPolicyOwnerId, 1);
    actionCardDeck = drawResult.state.actionCardDeck ?? [];
    actionCardDiscardPile = drawResult.state.actionCardDiscardPile ?? [];
    players = drawResult.state.players;
    events.push(...drawResult.events);
    pendingSchemingDiscards.length = 0;
    pendingSchemingDiscards.push(...(drawResult.state.pendingSchemingDiscards ?? []));
  }

  // RR "The Crown of Emphidia" (relic): "At the end of the status phase, if you control the 'Tomb of Emphidia' attachment, you may purge this card to gain 1 Victory Point." Checked for whoever currently holds it (there's ever only one).
  let stateForCrownCheck: GameState = { ...state, players, systems };
  for (const p of Object.values(players)) {
    if (p.relics.includes("the_crown_of_emphidia" as never)) {
      const crownResult = maybeGainCrownOfEmphidiaVictoryPoint(stateForCrownCheck, p.id);
      stateForCrownCheck = crownResult.state;
      events.push(...crownResult.events);
      break;
    }
  }
  players = stateForCrownCheck.players;

  // Sol "Genesis" (flagship): "At the end of the status phase, place 1
  // infantry from your reinforcements in this system's space area." Only
  // triggers if the flagship is actually built and present somewhere on
  // the board (a player could have Sol as their faction but not have
  // built/kept their flagship).
  const genesisCapacityOverflow: { playerId: PlayerId; systemId: SystemId }[] = [];
  for (const [systemId, system] of Object.entries(systems)) {
    for (const [ownerId, stacks] of Object.entries(system.spaceUnitsByPlayer)) {
      const hasGenesis = (stacks ?? []).some((s) => s.unitType === "flagship" && s.count > 0);
      if (!hasGenesis) continue;
      const owner = players[ownerId as PlayerId];
      if (!owner || owner.factionId !== ("sol" as never)) continue;
      const reinforcementsCheck = checkReinforcementsAvailable({ ...state, systems, players }, ownerId as PlayerId, [{ unitType: "infantry", count: 1 }]);
      if (!reinforcementsCheck.ok) continue;
      const ownerStacks = system.spaceUnitsByPlayer[ownerId as PlayerId] ?? [];
      const existingInfantry = ownerStacks.find((s) => s.unitType === "infantry");
      const updatedStacks = existingInfantry
        ? ownerStacks.map((s) => (s.unitType === "infantry" ? { ...s, count: s.count + 1 } : s))
        : [...ownerStacks, { unitType: "infantry" as const, count: 1, damagedCount: 0 }];
      systems[systemId as SystemId] = { ...systems[systemId as SystemId], spaceUnitsByPlayer: { ...systems[systemId as SystemId].spaceUnitsByPlayer, [ownerId]: updatedStacks } };
      events.push({ type: "UNITS_PRODUCED", playerId: ownerId as PlayerId, systemId: systemId as SystemId, unitType: "infantry", count: 1, totalCost: 0 });

      // Confirmed (yjmrobert.com/tirules/factions/f_sol): "the Sol player might need to remove an infantry or fighter to meet capacity limits" — checked right after the mandatory placement, same RR 16.3 combined-capacity math used elsewhere, but as a PENDING CHOICE (which unit to remove) rather than an upfront rejection, since this placement itself is mandatory and can't simply be blocked.
      const totalCapacity = updatedStacks.reduce((sum, s) => {
        if (s.count <= 0 || !SHIP_TYPES.includes(s.unitType)) return sum;
        const shipStats = getUnitStats(rules, owner.factionId, s.unitType, owner.unitUpgrades);
        return sum + (shipStats?.capacity ?? 0) * s.count;
      }, 0);
      const totalCargo = updatedStacks.reduce((sum, s) => (s.unitType === "fighter" || GROUND_FORCE_TYPES.includes(s.unitType) ? sum + s.count : sum), 0);
      if (totalCargo > totalCapacity) {
        genesisCapacityOverflow.push({ playerId: ownerId as PlayerId, systemId: systemId as SystemId });
      }
    }
  }

  // Arborec "MITOSIS" (faction ability): "At the start of the status
  // phase, place 1 infantry from your reinforcements on any planet you
  // control." Confirmed (yjmrobert.com/tirules/factions/f_arborec):
  // "placing the infantry during the status phase is mandatory (unless
  // the Arborec player controls no planets)." Unlike Sol's own Genesis
  // above (a DETERMINISTIC location, the flagship's own system), this is
  // the OWNER's own CHOICE of which controlled planet — queued here as a
  // pending choice (RESOLVE_MITOSIS_PLACEMENT) rather than resolved
  // automatically, the same shape as pendingGenesisCapacityOverflow's
  // own "mandatory effect, but WHICH one needs a choice" pattern.
  const pendingMitosisPlacements: PlayerId[] = [];
  for (const [playerId, player] of Object.entries(players)) {
    if (player.factionId !== ("arborec" as never) || player.eliminated) continue;
    const hasControlledPlanet = Object.values(systems).some((sys) => sys.planets.some((p) => p.controllerId === playerId));
    if (!hasControlledPlanet) continue;
    const reinforcementsCheck = checkReinforcementsAvailable({ ...state, systems, players }, playerId as PlayerId, [{ unitType: "infantry", count: 1 }]);
    if (!reinforcementsCheck.ok) continue;
    pendingMitosisPlacements.push(playerId as PlayerId);
  }

  const preGiftState: GameState = {
    ...stateForCrownCheck,
    systems,
    objectives,
    publicObjectiveDeck: nextDeck,
    actionCardDeck,
    actionCardDiscardPile,
    pendingCommandTokenGains,
    ...(genesisCapacityOverflow.length > 0 ? { pendingGenesisCapacityOverflow: genesisCapacityOverflow } : {}),
    ...(pendingMitosisPlacements.length > 0 ? { pendingMitosisPlacements } : {}),
    ...(pendingSchemingDiscards.length > 0 ? { pendingSchemingDiscards } : {}),
    ...(pendingWormholeGeneratorPlacements.length > 0 ? { pendingWormholeGeneratorPlacements } : {}),
  };
  // Naalu Collective "Gift of Prescience": "return this card to the Naalu player at the end of the status phase" — see rules/naalu.ts's own maybeReturnGiftOfPrescience.
  return {
    state: maybeReturnGiftOfPrescience(preGiftState),
    events,
  };
}

export function startNewRound(state: GameState, rules: RuleData): GameState {
  const players: GameState["players"] = {};
  for (const [id, player] of Object.entries(state.players)) {
    // Letnev "Darktalon Treilla — DARK MATTER AFFINITY" (hero): "At the end of that game round, purge this card." Confirmed (yjmrobert.com/tirules/factions/f_letnev): "the game round ends after the agenda phase (or the status phase if the custodians token is yet to be removed from Mecatol Rex)" — exactly this function's own call site. "The Letnev player might need to remove ships from the board to satisfy fleet pool limits" once the bypass ends — flagged via pendingFleetCleanupSystemIds, resolved by the PLAYER'S OWN choice of which ships via rules/letnev.ts's own resolveFleetCleanup (RESOLVE_FLEET_CLEANUP action).
    if (player.darktalonTreillaActive) {
      const overLimitSystemIds = Object.entries(state.systems)
        .filter(([, sys]) => (sys.spaceUnitsByPlayer[id as PlayerId] ?? []).filter((s) => s.unitType !== "fighter" && SHIP_TYPES.includes(s.unitType)).reduce((sum, s) => sum + s.count, 0) > player.commandTokens.fleet + (hasAbility(player, asAbilityId("armada")) ? 2 : 0))
        .map(([systemId]) => systemId as SystemId);
      const purgedPlayer = purgeHero({ ...player, darktalonTreillaActive: undefined }, asLeaderId("letnev_hero"));
      players[id as PlayerId] = { ...purgedPlayer, hasPassed: false, strategyCards: [], pendingFleetCleanupSystemIds: overLimitSystemIds.length > 0 ? overLimitSystemIds : undefined };
      continue;
    }
    // RR "Political Stability": this player keeps their strategy card(s) — they don't return, and this player skips picking a NEW one this upcoming strategy phase instead (see phases/strategyPhase.ts's own isPlayersStrategyTurnInternal for where that skip is enforced).
    if (player.politicalStabilityKeepCards) {
      players[id as PlayerId] = { ...player, hasPassed: false, politicalStabilityKeepCards: false, skipsNextStrategyPick: true };
      continue;
    }
    players[id as PlayerId] = { ...player, hasPassed: false, strategyCards: [] };
  }

  // RR "The Triad" (relic): "readied... at the end of the agenda phase"
  // (confirmed) — a SECOND readying beyond the normal status-phase-only
  // one everything else gets, since it can be exhausted again mid-agenda-
  // phase to cast votes. This function is exactly RR's own "end of the
  // game round" moment (see darktalonTreillaActive's own doc comment
  // above, confirming this same call site) — safe to run unconditionally
  // even on rounds where the agenda phase was skipped entirely (deck
  // empty), since readying an already-readied relic is a harmless no-op.
  for (const id of Object.keys(players) as PlayerId[]) {
    const p = players[id];
    if ((p.exhaustedRelics ?? []).includes("the_triad" as never)) {
      players[id] = { ...p, exhaustedRelics: (p.exhaustedRelics ?? []).filter((r) => r !== ("the_triad" as never)) };
    }
  }

  // RR 70.8: strategy cards return to the common play area (RR 73.2's trade
  // goods only accrue on cards that go unchosen for a full round — cards
  // that were just used carry no residual trade goods forward).
  const unclaimedStrategyCards = state.unclaimedStrategyCards.length
    ? state.unclaimedStrategyCards
    : Object.values(state.players)
        .flatMap((p) => p.strategyCards)
        .map((c) => ({ cardId: c.cardId, tradeGoods: 0 }));

  // RR "Representative Government" (either version, "against"): each
  // queued voter's cultural planets all exhaust right as this new
  // strategy phase starts — see phases/agendaPhase.ts for where this list
  // gets built up.
  const againstVoters = state.pendingRepresentativeGovernmentAgainstVoters ?? [];
  const armsReductionActive = state.pendingArmsReductionExhaustTechSpecialty ?? false;
  const newConstitutionActive = state.pendingNewConstitutionExhaustHomeSystem ?? false;
  const systems: GameState["systems"] =
    againstVoters.length === 0 && !armsReductionActive && !newConstitutionActive
      ? state.systems
      : Object.fromEntries(
          Object.entries(state.systems).map(([systemId, system]) => [
            systemId,
            {
              ...system,
              planets: system.planets.map((p) => {
                if (!p.controllerId) return p;
                const repGov = againstVoters.includes(p.controllerId) && (rules.planets[p.planetId]?.traits ?? []).includes("cultural");
                const armsReduction = armsReductionActive && (rules.planets[p.planetId]?.techSpecialties ?? []).length > 0;
                const newConstitution = newConstitutionActive && rules.homeSystemByFaction[players[p.controllerId]?.factionId] === systemId;
                return repGov || armsReduction || newConstitution ? { ...p, exhausted: true } : p;
              }),
            },
          ]),
        );

  const nextState: GameState = {
    ...state,
    players,
    systems,
    phase: "strategy",
    round: state.round + 1,
    activePlayerId: null,
    initiativeOrder: [],
    unclaimedStrategyCards,
    lastPlayerToPass: undefined,
    activePlayerActionsTaken: undefined,
    pendingRepresentativeGovernmentAgainstVoters: undefined,
    pendingArmsReductionExhaustTechSpecialty: undefined,
    pendingNewConstitutionExhaustHomeSystem: undefined,
    strategyCardSecondariesUsedBy: undefined,
    statusPhaseStrategyReturnWindowDone: undefined,
    agendaPhaseStartWindowDone: undefined,
    electedOutcomeWindowDone: undefined,
  };
  // RR 1.20: "at the start of the strategy phase" — speaker-first order, same as agenda phase (rules/priorityWindow.ts's own agendaPhaseWindowOrder covers "strategy OR agenda phase" identically).
  const order = agendaPhaseWindowOrder(nextState).filter((id) => !nextState.players[id]?.eliminated);
  return order.length > 0 ? { ...nextState, pendingPriorityWindow: { kind: "strategy_phase_start", order, currentIndex: 0, consecutivePasses: 0 } } : nextState;
}

/** RR 20/70.5: resolves this player's own pending command-token gain (from GameState.pendingCommandTokenGains) — their own choice of how to split it across their 3 pools, subject to RR "Fleet Regulations"'s own cap when active. See rules/commandTokens.ts's shared validate+place logic. */
export function placeGainedCommandTokensAction(
  state: GameState,
  action: { type: "PLACE_GAINED_COMMAND_TOKENS"; playerId: PlayerId; tactic: number; fleet: number; strategy: number },
): ActionResult {
  const pendingCount = state.pendingCommandTokenGains?.[action.playerId];
  if (!pendingCount) return { ok: false, error: "This player has no pending command-token gain to place right now." };

  const player = state.players[action.playerId];
  const result = placeGainedCommandTokens(state, player, pendingCount, { tactic: action.tactic, fleet: action.fleet, strategy: action.strategy });
  if (!result.ok) return result;

  const { [action.playerId]: _removed, ...remainingGains } = state.pendingCommandTokenGains ?? {};
  const nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: result.player },
    pendingCommandTokenGains: remainingGains,
  };
  return { ok: true, state: nextState, events: [] };
}
