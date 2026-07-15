import { GameState } from "./types/GameState";
import { GameAction, ActionResult, GameEvent } from "./types/Actions";
import { PlayerId } from "./types/ids";
import { RuleData } from "./types/RuleData";
import { chooseStrategyCard } from "./phases/strategyPhase";
import { activateSystem, moveShips } from "./phases/tacticalAction";
import { announceRetreat, resolveSpaceCombatRound, assignHits } from "./phases/spaceCombat";
import {
  bombard,
  assignBombardmentHits,
  commitGroundForces,
  finishInvasionCommits,
  startGroundCombat,
  resolveGroundCombatRound,
  assignGroundCombatHits,
} from "./phases/invasion";
import { pass, autoAdvancePhase, scoreObjective, finishStatusPhaseScoring } from "./phases/actionPhase";
import { produceUnits, finishTacticalAction } from "./phases/production";
import { revealAgenda, castVotes } from "./phases/agendaPhase";
import { resolveStrategyPrimary, resolveStrategySecondary } from "./phases/strategyCardAbilities";
import { researchTechnology, researchUnitUpgrade } from "./phases/technology";
import { explorePlanet, exploreFrontier, purgeRelicFragments } from "./phases/exploration";
import { playersWithShipsInSystem, playersWithGroundForces } from "./rules/combat";

/**
 * GameEngine is the "bot": the single referee both the web client and (later)
 * any scheduled Supabase job talk to. It never touches Supabase, sockets,
 * or React state directly — it's a pure function core so it can be unit
 * tested with plain objects and, if we ever want an AI/practice opponent,
 * reused as-is to generate that opponent's moves via getLegalActions().
 *
 * Call pattern from the app layer:
 *   const result = GameEngine.applyAction(currentState, action);
 *   if (!result.ok) return showError(result.error);
 *   await supabase.from('games').update({ state: result.state }).eq('id', gameId);
 *   await supabase.from('game_events').insert(result.events.map(e => ({ game_id: gameId, ...e })));
 */
export const GameEngine = {
  /**
   * Validate + apply a single action. Returns a *new* GameState (never
   * mutates the input) plus the events that occurred, or an error and the
   * original state is implicitly still valid.
   *
   * After a successful action, this always runs autoAdvancePhase so callers
   * never have to remember to check "did everyone just pass?" themselves.
   */
  applyAction(state: GameState, action: GameAction, rules: RuleData): ActionResult {
    if (state.phase === "ended") {
      return { ok: false, error: "Game has already ended." };
    }

    const guard = guardTurnLegality(state, action);
    if (guard) return { ok: false, error: guard };

    let result: ActionResult;
    switch (action.type) {
      case "CHOOSE_STRATEGY_CARD":
        result = chooseStrategyCard(state, action);
        break;
      case "PASS":
        result = pass(state, action);
        break;
      case "ACTIVATE_SYSTEM":
        result = activateSystem(state, action);
        break;
      case "MOVE_SHIPS":
        result = moveShips(state, action, rules);
        break;
      case "ANNOUNCE_RETREAT":
        result = announceRetreat(state, action);
        break;
      case "RESOLVE_COMBAT_ROUND":
        result =
          state.pendingTacticalAction?.step === "invasion"
            ? resolveGroundCombatRound(state, action, rules)
            : resolveSpaceCombatRound(state, action, rules);
        break;
      case "ASSIGN_HITS":
        result =
          state.pendingTacticalAction?.step === "invasion"
            ? assignGroundCombatHits(state, action, rules)
            : assignHits(state, action, rules);
        break;
      case "BOMBARD":
        result = bombard(state, action, rules);
        break;
      case "ASSIGN_BOMBARDMENT_HITS":
        result = assignBombardmentHits(state, action, rules);
        break;
      case "COMMIT_GROUND_FORCES":
        result = commitGroundForces(state, action);
        break;
      case "FINISH_INVASION_COMMITS":
        result = finishInvasionCommits(state, action);
        break;
      case "START_GROUND_COMBAT":
        result = startGroundCombat(state, action);
        break;
      case "PRODUCE_UNITS":
        result = produceUnits(state, action, rules);
        break;
      case "FINISH_TACTICAL_ACTION":
        result = finishTacticalAction(state, action);
        break;
      case "SCORE_OBJECTIVE":
        result = scoreObjective(state, action, rules);
        break;
      case "FINISH_STATUS_PHASE_SCORING":
        result = finishStatusPhaseScoring(state, action);
        break;
      case "CAST_VOTES":
        result = castVotes(state, action, rules);
        break;
      case "REVEAL_AGENDA":
        result = revealAgenda(state);
        break;
      case "RESOLVE_STRATEGY_PRIMARY":
        result = resolveStrategyPrimary(state, action, rules);
        break;
      case "RESOLVE_STRATEGY_SECONDARY":
        result = resolveStrategySecondary(state, action, rules);
        break;
      case "RESEARCH_TECHNOLOGY":
        result = researchTechnology(state, action.playerId, action.techId, action.cost, action.exhaustPlanetIdsForResources, rules);
        break;
      case "RESEARCH_UNIT_UPGRADE":
        result = researchUnitUpgrade(state, action.playerId, action.upgradeId, action.cost, action.exhaustPlanetIdsForResources, rules);
        break;
      case "EXPLORE_PLANET":
        result = explorePlanet(state, action, rules);
        break;
      case "EXPLORE_FRONTIER":
        result = exploreFrontier(state, action, rules);
        break;
      case "PURGE_RELIC_FRAGMENTS":
        result = purgeRelicFragments(state, action);
        break;

      // --- Not yet implemented. Each of these follows the exact same shape
      // as the cases above — see phases/README.md for the recipe.
      case "USE_SPACE_CANNON_OFFENSE":
      case "PLAY_ACTION_CARD":
      case "PROPOSE_TRANSACTION":
      case "END_TURN_TIMEOUT":
        return { ok: false, error: `${action.type} is not implemented yet.` };

      default: {
        const exhaustiveCheck: never = action;
        return { ok: false, error: `Unknown action: ${JSON.stringify(exhaustiveCheck)}` };
      }
    }

    if (!result.ok || !result.state) return result;

    const { state: advancedState, events: advanceEvents } = autoAdvancePhase(result.state);
    const allEvents = [...(result.events ?? []), ...advanceEvents];

    // See GameState.ts's own doc comment on recentEvents for why this
    // lives here (one central place, so no handler has to remember it)
    // and why it's capped rather than growing forever.
    const finalState: GameState = {
      ...advancedState,
      recentEvents: [...(advancedState.recentEvents ?? []), ...allEvents].slice(-200),
    };

    return {
      ok: true,
      state: finalState,
      events: allEvents,
    };
  },

  /**
   * What can this player legally do right now? Drives which buttons the UI
   * enables, and doubles as the move-generator for a future AI opponent.
   * Deliberately conservative: it's fine for this to under-report edge cases
   * (applyAction is still the source of truth and will reject anything
   * illegal), but it should never suggest an action that's actually illegal.
   */
  getLegalActions(state: GameState, playerId: PlayerId): GameAction["type"][] {
    const legal: GameAction["type"][] = [];
    const player = state.players[playerId];
    if (!player || player.eliminated) return legal;

    if (state.phase === "strategy") {
      const alreadyHasCard = player.strategyCards.length > 0;
      const cardsNeeded = Object.keys(state.players).length <= 4 ? 2 : 1;
      if (player.strategyCards.length < cardsNeeded && isPlayersStrategyTurn(state, playerId)) {
        legal.push("CHOOSE_STRATEGY_CARD");
      }
      void alreadyHasCard;
    }

    if (state.phase === "status" && !state.statusPhaseScoring?.[playerId]?.done) {
      legal.push("SCORE_OBJECTIVE", "FINISH_STATUS_PHASE_SCORING");
    }

    if (state.phase === "agenda" && state.pendingAgendaVote?.votingOrder[state.pendingAgendaVote.nextVoterIndex] === playerId) {
      legal.push("CAST_VOTES");
    }

    if (state.phase === "action" && state.activePlayerId === playerId && !player.hasPassed) {
      legal.push("PASS");
      if (!state.pendingTacticalAction) {
        legal.push("ACTIVATE_SYSTEM");
      } else if (state.pendingTacticalAction.playerId === playerId) {
        if (state.pendingTacticalAction.step === "movement") legal.push("MOVE_SHIPS");
        if (state.pendingTacticalAction.step === "invasion" && !state.pendingTacticalAction.currentInvasionPlanetId) {
          const noPendingHits = Object.keys(state.pendingTacticalAction.pendingHits ?? {}).length === 0;
          if (!noPendingHits) {
            legal.push("ASSIGN_BOMBARDMENT_HITS");
          } else if (!state.pendingTacticalAction.invasionCommitsFinished) {
            legal.push("BOMBARD", "COMMIT_GROUND_FORCES", "FINISH_INVASION_COMMITS");
          } else if ((state.pendingTacticalAction.remainingInvasionPlanetIds ?? []).length > 0) {
            legal.push("START_GROUND_COMBAT");
          }
        }
        if (state.pendingTacticalAction.step === "production") {
          legal.push("PRODUCE_UNITS", "FINISH_TACTICAL_ACTION");
        }
      }
    }

    if (state.pendingTacticalAction?.step === "spaceCombat") {
      const inCombat = playersWithShipsInSystem(state, state.pendingTacticalAction.systemId).includes(playerId);
      const owesHits = (state.pendingTacticalAction.pendingHits?.[playerId] ?? 0) > 0;
      const noPendingHits = Object.keys(state.pendingTacticalAction.pendingHits ?? {}).length === 0;
      if (owesHits) legal.push("ASSIGN_HITS");
      else if (inCombat && noPendingHits) {
        legal.push("RESOLVE_COMBAT_ROUND");
        if (!state.pendingTacticalAction.retreating?.some((r) => r.playerId === playerId)) {
          legal.push("ANNOUNCE_RETREAT");
        }
      }
    }

    if (state.pendingTacticalAction?.step === "invasion" && state.pendingTacticalAction.currentInvasionPlanetId) {
      const { systemId, currentInvasionPlanetId } = state.pendingTacticalAction;
      const planet = state.systems[systemId]?.planets.find((p) => p.planetId === currentInvasionPlanetId);
      const inCombat = planet ? playersWithGroundForces(planet).includes(playerId) : false;
      const owesHits = (state.pendingTacticalAction.pendingHits?.[playerId] ?? 0) > 0;
      const noPendingHits = Object.keys(state.pendingTacticalAction.pendingHits ?? {}).length === 0;
      if (owesHits) legal.push("ASSIGN_HITS");
      else if (inCombat && noPendingHits) legal.push("RESOLVE_COMBAT_ROUND");
    }

    return legal;
  },
};

/**
 * Cross-cutting checks that apply no matter which action is being submitted:
 * is it this player's turn, do they exist, are they mid-combat-response-only,
 * etc. Kept separate from per-action validation so every handler in
 * phases/* doesn't have to repeat "is this even your turn" logic.
 */
function guardTurnLegality(state: GameState, action: GameAction): string | null {
  if (state.winnerId) {
    return `RR 87: the game has already ended (winner: ${state.winnerId}).`;
  }
  const playerId = "playerId" in action ? action.playerId : undefined;
  if (playerId && !state.players[playerId]) {
    return `Unknown player: ${playerId}`;
  }
  if (playerId && state.players[playerId].eliminated) {
    return `RR 31: ${playerId} is eliminated and cannot act.`;
  }
  return null;
}

function isPlayersStrategyTurn(state: GameState, playerId: PlayerId): boolean {
  // RR 73.1: starting with the speaker and proceeding clockwise through seatOrder,
  // skipping anyone who already holds a strategy card for this round.
  const cardsNeeded = Object.keys(state.players).length <= 4 ? 2 : 1;
  for (const candidateId of rotateFromSpeaker(state)) {
    const candidate = state.players[candidateId];
    if (candidate.strategyCards.length < cardsNeeded) {
      return candidateId === playerId;
    }
  }
  return false;
}

function rotateFromSpeaker(state: GameState): PlayerId[] {
  const speakerId = state.seatOrder.find((id) => state.players[id].isSpeaker);
  const startIndex = speakerId ? state.seatOrder.indexOf(speakerId) : 0;
  return [...state.seatOrder.slice(startIndex), ...state.seatOrder.slice(0, startIndex)];
}

export type { GameAction, GameEvent, ActionResult };
