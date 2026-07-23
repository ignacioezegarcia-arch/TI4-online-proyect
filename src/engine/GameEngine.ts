import { GameState } from "./types/GameState";
import { GameAction, ActionResult, GameEvent } from "./types/Actions";
import { PlayerId, asTechId } from "./types/ids";
import { RuleData } from "./types/RuleData";
import { chooseStrategyCard, getStrategyCardsPerPlayer } from "./phases/strategyPhase";
import { activateSystem, moveShips } from "./phases/tacticalAction";
import { announceRetreat, resolveSpaceCombatRound, assignHits, useAntiFighterBarrage, assignAntiFighterBarrageHits, useDuraniumArmor, skipDuraniumArmor, useAssaultCannonDestruction } from "./phases/spaceCombat";
import {
  bombard,
  assignBombardmentHits,
  commitGroundForces,
  useRemoveCustodiansToken,
  finishInvasionCommits,
  startGroundCombat,
  resolveGroundCombatRound,
  assignGroundCombatHits,
  useSpaceCannonDefense,
  skipSpaceCannonDefense,
  assignSpaceCannonDefenseHits,
  useMagenDefenseGrid,
  skipMagenDefenseGrid,
  assignMagenDefenseGridHit,
} from "./phases/invasion";
import { pass, autoAdvancePhase, scoreObjective, finishStatusPhaseScoring, placeGainedCommandTokensAction } from "./phases/actionPhase";
import { produceUnits, finishTacticalAction } from "./phases/production";
import { playActionCard, discardActionCard } from "./phases/actionCards";
import { revealAgenda, castVotes } from "./phases/agendaPhase";
import { resolveStrategyPrimary, resolveStrategySecondary } from "./phases/strategyCardAbilities";
import { researchTechnology, researchUnitUpgrade } from "./phases/technology";
import { explorePlanet, exploreFrontier, purgeRelicFragments } from "./phases/exploration";
import { useSpaceCannonOffense, skipSpaceCannonOffense, assignSpaceCannonOffenseHits } from "./phases/spaceCannonOffense";
import {
  useSelfAssemblyRoutines,
  useDacxiveAnimators,
  useIntegratedEconomy,
  useX89BacterialWeapon,
  usePsychoarchaeology,
  useSlingRelay,
  useScanlinkDroneNetwork,
  useBioStims,
  usePredictiveIntelligenceRedistribute,
  useTransitDiodes,
} from "./phases/technologyAbilities";
import { useAtrament, useImperialArmsVault, useExterrixHeadquarters, useMirageFlightAcademy } from "./phases/legendaryPlanets";
import { destroyShipForAntiIntellectualRevolution, exhaustPlanetsForAntiIntellectualRevolution, useCommitteeFormation, skipCommitteeFormation, destroyPdsForHomelandDefenseAct, discardRandomActionCardForExecutiveSanctions, useImperialArbiter, useMinisterOfPeace, useMinisterOfWar, useCrownOfThalnosReroll, skipCrownOfThalnosReroll, returnSecretObjective } from "./phases/agendaEffects";
import {
  useColonialRedistributionChoice,
  placeColonialRedistributionInfantry,
  skipColonialRedistributionInfantry,
  useResearchGrantReallocation,
  useIxthianArtifactDieRoll,
  useIxthianArtifactResearch,
  skipIxthianArtifactResearch,
  useWormholeResearch,
  skipWormholeResearch,
  useGalacticCrisisPact,
  skipGalacticCrisisPact,
} from "./phases/directiveEffects";
import { playersWithShipsInSystem, playersWithGroundForces } from "./rules/combat";
import { checkAndApplyEliminations, checkForVictory } from "./phases/elimination";

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
        result = activateSystem(state, action, rules);
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
        result = commitGroundForces(state, action, rules);
        break;
      case "USE_REMOVE_CUSTODIANS_TOKEN":
        result = useRemoveCustodiansToken(state, action, rules);
        break;
      case "FINISH_INVASION_COMMITS":
        result = finishInvasionCommits(state, action);
        break;
      case "START_GROUND_COMBAT":
        result = startGroundCombat(state, action, rules);
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
      case "PLACE_GAINED_COMMAND_TOKENS":
        result = placeGainedCommandTokensAction(state, action);
        break;
      case "CAST_VOTES":
        result = castVotes(state, action, rules);
        break;
      case "REVEAL_AGENDA":
        result = revealAgenda(state, rules);
        break;
      case "RESOLVE_STRATEGY_PRIMARY":
        result = resolveStrategyPrimary(state, action, rules);
        break;
      case "RESOLVE_STRATEGY_SECONDARY":
        result = resolveStrategySecondary(state, action, rules);
        break;
      case "RESEARCH_TECHNOLOGY":
        result = researchTechnology(state, action.playerId, action.techId, action.cost, action.exhaustPlanetIdsForResources, rules, action.useResearchTeamAttachmentPlanetId);
        break;
      case "RESEARCH_UNIT_UPGRADE":
        result = researchUnitUpgrade(
          state,
          action.playerId,
          action.upgradeId,
          action.cost,
          action.exhaustPlanetIdsForResources,
          rules,
          action.aiDevelopmentAlgorithmIgnoreColor,
          action.useResearchTeamAttachmentPlanetId,
        );
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
      case "USE_SELF_ASSEMBLY_ROUTINES":
        result = useSelfAssemblyRoutines(state, action);
        break;
      case "USE_DACXIVE_ANIMATORS":
        result = useDacxiveAnimators(state, action);
        break;
      case "USE_INTEGRATED_ECONOMY":
        result = useIntegratedEconomy(state, action, rules);
        break;
      case "USE_X89_BACTERIAL_WEAPON":
        result = useX89BacterialWeapon(state, action, rules);
        break;
      case "USE_PSYCHOARCHAEOLOGY":
        result = usePsychoarchaeology(state, action, rules);
        break;
      case "USE_SLING_RELAY":
        result = useSlingRelay(state, action, rules);
        break;
      case "USE_SCANLINK_DRONE_NETWORK":
        result = useScanlinkDroneNetwork(state, action, rules);
        break;
      case "USE_BIO_STIMS":
        result = useBioStims(state, action, rules);
        break;
      case "USE_PREDICTIVE_INTELLIGENCE_REDISTRIBUTE":
        result = usePredictiveIntelligenceRedistribute(state, action);
        break;
      case "USE_TRANSIT_DIODES":
        result = useTransitDiodes(state, action);
        break;
      case "USE_ATRAMENT":
        result = useAtrament(state, action);
        break;
      case "USE_IMPERIAL_ARMS_VAULT":
        result = useImperialArmsVault(state, action);
        break;
      case "USE_EXTERRIX_HEADQUARTERS":
        result = useExterrixHeadquarters(state, action);
        break;
      case "USE_MIRAGE_FLIGHT_ACADEMY":
        result = useMirageFlightAcademy(state, action, rules);
        break;
      case "DESTROY_SHIP_FOR_ANTI_INTELLECTUAL_REVOLUTION":
        result = destroyShipForAntiIntellectualRevolution(state, action);
        break;
      case "EXHAUST_PLANETS_FOR_ANTI_INTELLECTUAL_REVOLUTION":
        result = exhaustPlanetsForAntiIntellectualRevolution(state, action, rules);
        break;
      case "USE_COMMITTEE_FORMATION":
        result = useCommitteeFormation(state, action, rules);
        break;
      case "SKIP_COMMITTEE_FORMATION":
        result = skipCommitteeFormation(state, action, rules);
        break;
      case "DESTROY_PDS_FOR_HOMELAND_DEFENSE_ACT":
        result = destroyPdsForHomelandDefenseAct(state, action);
        break;
      case "RANDOM_DISCARD_FOR_EXECUTIVE_SANCTIONS":
        result = discardRandomActionCardForExecutiveSanctions(state, action);
        break;
      case "USE_IMPERIAL_ARBITER":
        result = useImperialArbiter(state, action);
        break;
      case "USE_MINISTER_OF_PEACE":
        result = useMinisterOfPeace(state, action);
        break;
      case "USE_MINISTER_OF_WAR":
        result = useMinisterOfWar(state, action);
        break;
      case "USE_CROWN_OF_THALNOS_REROLL":
        result = useCrownOfThalnosReroll(state, action, rules);
        break;
      case "SKIP_CROWN_OF_THALNOS_REROLL":
        result = skipCrownOfThalnosReroll(state, action);
        break;
      case "USE_COLONIAL_REDISTRIBUTION_CHOICE":
        result = useColonialRedistributionChoice(state, action);
        break;
      case "PLACE_COLONIAL_REDISTRIBUTION_INFANTRY":
        result = placeColonialRedistributionInfantry(state, action);
        break;
      case "SKIP_COLONIAL_REDISTRIBUTION_INFANTRY":
        result = skipColonialRedistributionInfantry(state, action);
        break;
      case "USE_RESEARCH_GRANT_REALLOCATION":
        result = useResearchGrantReallocation(state, action, rules);
        break;
      case "USE_IXTHIAN_ARTIFACT_DIE_ROLL":
        result = useIxthianArtifactDieRoll(state, action, rules);
        break;
      case "USE_IXTHIAN_ARTIFACT_RESEARCH":
        result = useIxthianArtifactResearch(state, action, rules);
        break;
      case "SKIP_IXTHIAN_ARTIFACT_RESEARCH":
        result = skipIxthianArtifactResearch(state, action);
        break;
      case "USE_WORMHOLE_RESEARCH":
        result = useWormholeResearch(state, action, rules);
        break;
      case "SKIP_WORMHOLE_RESEARCH":
        result = skipWormholeResearch(state, action);
        break;
      case "USE_GALACTIC_CRISIS_PACT":
        result = useGalacticCrisisPact(state, action, rules);
        break;
      case "SKIP_GALACTIC_CRISIS_PACT":
        result = skipGalacticCrisisPact(state, action);
        break;
      case "RETURN_SECRET_OBJECTIVE":
        result = returnSecretObjective(state, action);
        break;
      case "USE_SPACE_CANNON_OFFENSE":
        result = useSpaceCannonOffense(state, action, rules);
        break;
      case "SKIP_SPACE_CANNON_OFFENSE":
        result = skipSpaceCannonOffense(state, action, rules);
        break;
      case "ASSIGN_SPACE_CANNON_OFFENSE_HITS":
        result = assignSpaceCannonOffenseHits(state, action, rules);
        break;
      case "USE_ANTI_FIGHTER_BARRAGE":
        result = useAntiFighterBarrage(state, action, rules);
        break;
      case "ASSIGN_ANTI_FIGHTER_BARRAGE_HITS":
        result = assignAntiFighterBarrageHits(state, action, rules);
        break;
      case "USE_DURANIUM_ARMOR":
        result = useDuraniumArmor(state, action, rules);
        break;
      case "SKIP_DURANIUM_ARMOR":
        result = skipDuraniumArmor(state, action, rules);
        break;
      case "USE_ASSAULT_CANNON_DESTRUCTION":
        result = useAssaultCannonDestruction(state, action, rules);
        break;
      case "USE_SPACE_CANNON_DEFENSE":
        result = useSpaceCannonDefense(state, action, rules);
        break;
      case "SKIP_SPACE_CANNON_DEFENSE":
        result = skipSpaceCannonDefense(state, action);
        break;
      case "ASSIGN_SPACE_CANNON_DEFENSE_HITS":
        result = assignSpaceCannonDefenseHits(state, action, rules);
        break;
      case "USE_MAGEN_DEFENSE_GRID":
        result = useMagenDefenseGrid(state, action);
        break;
      case "SKIP_MAGEN_DEFENSE_GRID":
        result = skipMagenDefenseGrid(state, action);
        break;
      case "ASSIGN_MAGEN_DEFENSE_GRID_HIT":
        result = assignMagenDefenseGridHit(state, action, rules);
        break;

      case "PLAY_ACTION_CARD":
        result = playActionCard(state, action);
        break;
      case "DISCARD_ACTION_CARD":
        result = discardActionCard(state, action);
        break;

      // --- Not yet implemented. Each of these follows the exact same shape
      // as the cases above — see phases/README.md for the recipe.
      case "PROPOSE_TRANSACTION":
      case "END_TURN_TIMEOUT":
        return { ok: false, error: `${action.type} is not implemented yet.` };

      default: {
        const exhaustiveCheck: never = action;
        return { ok: false, error: `Unknown action: ${JSON.stringify(exhaustiveCheck)}` };
      }
    }

    if (!result.ok || !result.state) return result;

    // RR 33: check every non-eliminated player against the 3 elimination
    // conditions after every single action — cheap (early-exits fast for
    // anyone obviously still fine) and means no individual handler above
    // has to remember to check this itself. Runs BEFORE autoAdvancePhase
    // since phase-transition checks (e.g. "has every non-eliminated player
    // finished scoring?") need to already see this action's own
    // elimination fallout, if any.
    const eliminationResult = checkAndApplyEliminations(result.state, rules);
    const stateAfterEliminations = eliminationResult.state;
    const eliminationEvents = eliminationResult.events;

    // RR 87.7/98.7: any victory-point grant, from ANY source, is checked
    // against the victory point target here — see phases/elimination.ts's
    // own header note on why this needed to be centralized rather than
    // retrofitted into every individual VP-granting call site.
    const stateAfterVictoryCheck = checkForVictory(stateAfterEliminations);
    const victoryEvents: GameEvent[] = stateAfterVictoryCheck.winnerId && !stateAfterEliminations.winnerId ? [{ type: "GAME_ENDED", winnerId: stateAfterVictoryCheck.winnerId }] : [];

    const { state: advancedState, events: advanceEvents } = autoAdvancePhase(stateAfterVictoryCheck, rules);
    const allEvents = [...(result.events ?? []), ...eliminationEvents, ...victoryEvents, ...advanceEvents];

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
      const cardsNeeded = getStrategyCardsPerPlayer(state);
      if (player.strategyCards.length < cardsNeeded && isPlayersStrategyTurn(state, playerId)) {
        legal.push("CHOOSE_STRATEGY_CARD");
      }
      void alreadyHasCard;
    }

    if (state.phase === "status" && !state.statusPhaseScoring?.[playerId]?.done) {
      legal.push("SCORE_OBJECTIVE", "FINISH_STATUS_PHASE_SCORING");
    }
    if (state.pendingCommandTokenGains?.[playerId]) {
      legal.push("PLACE_GAINED_COMMAND_TOKENS");
    }

    // RR 2.4/2.7: discarding (voluntary, e.g. hand-limit compliance) and
    // playing an action card aren't tied to a specific phase the way most
    // other actions here are — a card's own printed timing window decides
    // when it's legal, and that per-card timing text isn't modeled yet
    // (same deferred-content scope as the card's effect itself). Offered
    // here as generally available whenever the player holds any.
    if (player.actionCards.length > 0) {
      legal.push("DISCARD_ACTION_CARD", "PLAY_ACTION_CARD");
    }

    if (state.phase === "agenda" && state.pendingAgendaVote?.votingOrder[state.pendingAgendaVote.nextVoterIndex] === playerId) {
      legal.push("CAST_VOTES");
    }

    if (state.phase === "action" && state.activePlayerId === playerId && !player.hasPassed) {
      legal.push("PASS");
      if (!state.pendingTacticalAction) {
        legal.push("ACTIVATE_SYSTEM");
        if (player.technologies.includes(asTechId("x89_bacterial_weapon")) && !player.exhaustedTechnologies.includes(asTechId("x89_bacterial_weapon"))) {
          legal.push("USE_X89_BACTERIAL_WEAPON");
        }
        if (player.technologies.includes(asTechId("sling_relay")) && !player.exhaustedTechnologies.includes(asTechId("sling_relay"))) {
          legal.push("USE_SLING_RELAY");
        }
      } else if (state.pendingTacticalAction.playerId === playerId) {
        if (state.pendingTacticalAction.step === "movement") {
          legal.push("MOVE_SHIPS");
          if (state.mode !== "base" && player.technologies.includes(asTechId("scanlink_drone_network"))) {
            legal.push("USE_SCANLINK_DRONE_NETWORK");
          }
        }
        if (state.pendingTacticalAction.step === "invasion" && !state.pendingTacticalAction.currentInvasionPlanetId) {
          const noPendingHits = Object.keys(state.pendingTacticalAction.pendingHits ?? {}).length === 0;
          if (!noPendingHits) {
            legal.push("ASSIGN_BOMBARDMENT_HITS");
          } else if (!state.pendingTacticalAction.invasionCommitsFinished) {
            legal.push("BOMBARD", "COMMIT_GROUND_FORCES", "FINISH_INVASION_COMMITS");
            // RR 27.2: USE_REMOVE_CUSTODIANS_TOKEN isn't offered here — this
            // function doesn't have `rules` in scope to confirm the active
            // system is actually Mecatol Rex's, and applyAction is still the
            // authority that rejects it correctly if used elsewhere. Same
            // "fine to under-report, never over-report" contract as this
            // function's own doc comment.
            if (player.technologies.includes(asTechId("dacxive_animators"))) legal.push("USE_DACXIVE_ANIMATORS");
            if (player.technologies.includes(asTechId("integrated_economy"))) legal.push("USE_INTEGRATED_ECONOMY");
          } else if ((state.pendingTacticalAction.remainingInvasionPlanetIds ?? []).length > 0) {
            legal.push("START_GROUND_COMBAT");
          }
        }
        if (state.pendingTacticalAction.step === "production") {
          legal.push("PRODUCE_UNITS", "FINISH_TACTICAL_ACTION");
          if (player.technologies.includes(asTechId("self_assembly_routines")) && !player.exhaustedTechnologies.includes(asTechId("self_assembly_routines"))) {
            legal.push("USE_SELF_ASSEMBLY_ROUTINES");
          }
        }
      }
      if (player.technologies.includes(asTechId("psychoarchaeology"))) legal.push("USE_PSYCHOARCHAEOLOGY");
      if (player.technologies.includes(asTechId("bio_stims")) && !player.exhaustedTechnologies.includes(asTechId("bio_stims"))) {
        legal.push("USE_BIO_STIMS");
      }
      if (player.technologies.includes(asTechId("predictive_intelligence")) && !player.exhaustedTechnologies.includes(asTechId("predictive_intelligence"))) {
        legal.push("USE_PREDICTIVE_INTELLIGENCE_REDISTRIBUTE");
      }
      if (player.technologies.includes(asTechId("transit_diodes")) && !player.exhaustedTechnologies.includes(asTechId("transit_diodes"))) {
        legal.push("USE_TRANSIT_DIODES");
      }
      const controlledLegendaryPlanets = Object.values(state.systems).flatMap((s) => s.planets.filter((p) => p.controllerId === playerId && !p.legendaryAbilityExhausted));
      if (controlledLegendaryPlanets.some((p) => p.planetId === "primor")) legal.push("USE_ATRAMENT");
      if (controlledLegendaryPlanets.some((p) => p.planetId === "hopes_end")) legal.push("USE_IMPERIAL_ARMS_VAULT");
      if (controlledLegendaryPlanets.some((p) => p.planetId === "mallice")) legal.push("USE_EXTERRIX_HEADQUARTERS");
      if (controlledLegendaryPlanets.some((p) => p.planetId === "mirage")) legal.push("USE_MIRAGE_FLIGHT_ACADEMY");
    }

    // RR "Anti-Intellectual Revolution": both of its own pending decisions
    // are cross-phase (a ship destruction can be owed any time research
    // happens; the one-time exhaustion can be owed right as the agenda
    // phase hands off to strategy) — checked independently of `state.phase`
    // for that reason, unlike most of this function's other blocks.
    if ((state.pendingAntiIntellectualRevolutionDestruction ?? []).includes(playerId)) {
      legal.push("DESTROY_SHIP_FOR_ANTI_INTELLECTUAL_REVOLUTION");
    }
    if ((state.pendingAntiIntellectualRevolutionExhaustion ?? []).includes(playerId)) {
      legal.push("EXHAUST_PLANETS_FOR_ANTI_INTELLECTUAL_REVOLUTION");
    }
    if (state.pendingCommitteeFormationDecision?.ownerId === playerId) {
      legal.push("USE_COMMITTEE_FORMATION", "SKIP_COMMITTEE_FORMATION");
    }
    if ((state.pendingHomelandDefenseActDestruction ?? []).includes(playerId)) {
      legal.push("DESTROY_PDS_FOR_HOMELAND_DEFENSE_ACT");
    }
    if ((state.pendingExecutiveSanctionsRandomDiscard ?? []).includes(playerId)) {
      legal.push("RANDOM_DISCARD_FOR_EXECUTIVE_SANCTIONS");
    }
    // RR "Imperial Arbiter": approximated as "any time during the action
    // phase" rather than strictly gated to the exact instant the strategy
    // phase ends — a reasonable, bounded approximation (same category as
    // this project's other "not strictly gated to the precise instant"
    // timing notes, e.g. technologyAbilities.ts's own header comment).
    if (state.phase === "action" && state.agendaDeck.lawsInPlay.some((l) => l.agendaId === "imperial_arbiter" && l.ownerId === playerId)) {
      legal.push("USE_IMPERIAL_ARBITER");
    }
    // RR "Minister of Peace": offered right after ANY player activates a
    // system with another player's units in it — deliberately checked
    // independently of whose turn it currently is, and independently of
    // `state.phase`'s usual "is this player active" gate elsewhere in this
    // function, since the OWNER (not necessarily the active player) is who
    // reacts here.
    if (
      state.pendingTacticalAction &&
      (state.pendingTacticalAction.step === "activation" || state.pendingTacticalAction.step === "movement") &&
      state.agendaDeck.lawsInPlay.some((l) => l.agendaId === "minister_of_peace" && l.ownerId === playerId)
    ) {
      const activatedSystem = state.systems[state.pendingTacticalAction.systemId];
      const activatorId = state.pendingTacticalAction.playerId;
      const hasOtherPlayerUnits =
        Object.entries(activatedSystem?.spaceUnitsByPlayer ?? {}).some(([pid, stacks]) => pid !== activatorId && (stacks ?? []).some((s) => s.count > 0)) ||
        (activatedSystem?.planets ?? []).some((p) => Object.entries(p.unitsByPlayer).some(([pid, stacks]) => pid !== activatorId && (stacks ?? []).some((s) => s.count > 0)));
      if (hasOtherPlayerUnits) legal.push("USE_MINISTER_OF_PEACE");
    }
    // RR "Minister of War": offered on this player's own turn during the
    // action phase, whenever they have at least 1 on-board command token
    // to return.
    if (state.phase === "action" && state.activePlayerId === playerId && (player.commandTokens.onBoard.length > 0) && state.agendaDeck.lawsInPlay.some((l) => l.agendaId === "minister_of_war" && l.ownerId === playerId)) {
      legal.push("USE_MINISTER_OF_WAR");
    }
    // RR "The Crown of Thalnos": cross-phase in the same sense as the
    // other pending-decision blocks above — checked independently of
    // whose turn it currently is (it's about who's a COMBATANT this
    // round, not who's active).
    if ((state.pendingTacticalAction?.crownOfThalnosPendingPlayers ?? []).includes(playerId)) {
      legal.push("USE_CROWN_OF_THALNOS_REROLL", "SKIP_CROWN_OF_THALNOS_REROLL");
    }
    if (state.pendingColonialRedistributionChoice?.controllerId === playerId) {
      legal.push("USE_COLONIAL_REDISTRIBUTION_CHOICE");
    }
    if (state.pendingColonialRedistributionInfantryOffer?.playerId === playerId) {
      legal.push("PLACE_COLONIAL_REDISTRIBUTION_INFANTRY", "SKIP_COLONIAL_REDISTRIBUTION_INFANTRY");
    }
    if (state.pendingResearchGrantReallocationChoice === playerId) {
      legal.push("USE_RESEARCH_GRANT_REALLOCATION");
    }
    if (state.pendingIxthianArtifactDieRoll && state.seatOrder.find((id) => state.players[id]?.isSpeaker) === playerId) {
      legal.push("USE_IXTHIAN_ARTIFACT_DIE_ROLL");
    }
    if ((state.pendingIxthianArtifactResearch?.[playerId] ?? 0) > 0) {
      legal.push("USE_IXTHIAN_ARTIFACT_RESEARCH", "SKIP_IXTHIAN_ARTIFACT_RESEARCH");
    }
    if ((state.pendingWormholeResearchOffer ?? []).includes(playerId)) {
      legal.push("USE_WORMHOLE_RESEARCH", "SKIP_WORMHOLE_RESEARCH");
    }
    if ((state.pendingGalacticCrisisPactOffer?.playersRemaining ?? []).includes(playerId)) {
      legal.push("USE_GALACTIC_CRISIS_PACT", "SKIP_GALACTIC_CRISIS_PACT");
    }
    if ((state.pendingSecretObjectiveReturn ?? []).includes(playerId)) {
      legal.push("RETURN_SECRET_OBJECTIVE");
    }

    if (state.pendingTacticalAction?.step === "spaceCannonOffense") {
      const owesHits = (state.pendingTacticalAction.pendingHits?.[playerId] ?? 0) > 0;
      const isResponder = state.pendingTacticalAction.spaceCannonOffenseRespondersRemaining?.includes(playerId);
      if (owesHits) legal.push("ASSIGN_SPACE_CANNON_OFFENSE_HITS");
      else if (isResponder) legal.push("USE_SPACE_CANNON_OFFENSE", "SKIP_SPACE_CANNON_OFFENSE");
    }

    if (state.pendingTacticalAction?.step === "spaceCombat") {
      const inCombat = playersWithShipsInSystem(state, state.pendingTacticalAction.systemId).includes(playerId);
      const owesHits = (state.pendingTacticalAction.pendingHits?.[playerId] ?? 0) > 0;
      const noPendingHits = Object.keys(state.pendingTacticalAction.pendingHits ?? {}).length === 0;
      const stillInAfbPhase = state.pendingTacticalAction.combatRound === undefined;
      const afbPending = state.pendingTacticalAction.afbPendingPlayers?.includes(playerId);
      const duraniumArmorPending = state.pendingTacticalAction.duraniumArmorPendingPlayers?.includes(playerId);
      const assaultCannonPending = state.pendingTacticalAction.assaultCannonPendingPlayer === playerId;

      if (assaultCannonPending) legal.push("USE_ASSAULT_CANNON_DESTRUCTION");
      else if (owesHits && stillInAfbPhase) legal.push("ASSIGN_ANTI_FIGHTER_BARRAGE_HITS");
      else if (owesHits) legal.push("ASSIGN_HITS");
      else if (stillInAfbPhase && afbPending && noPendingHits) legal.push("USE_ANTI_FIGHTER_BARRAGE");
      else if (duraniumArmorPending && noPendingHits) legal.push("USE_DURANIUM_ARMOR", "SKIP_DURANIUM_ARMOR");
      else if (inCombat && noPendingHits && !stillInAfbPhase) {
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

      if (state.pendingTacticalAction.spaceCannonDefensePending) {
        const defenderId = planet ? playersWithGroundForces(planet).find((id) => id !== state.pendingTacticalAction!.playerId) : undefined;
        if (owesHits) legal.push("ASSIGN_SPACE_CANNON_DEFENSE_HITS");
        else if (defenderId === playerId) legal.push("USE_SPACE_CANNON_DEFENSE", "SKIP_SPACE_CANNON_DEFENSE");
      } else if (state.pendingTacticalAction.magenDefenseGridPending) {
        const defenderId = planet ? playersWithGroundForces(planet).find((id) => id !== state.pendingTacticalAction!.playerId) : undefined;
        if (defenderId === playerId) legal.push("USE_MAGEN_DEFENSE_GRID", "SKIP_MAGEN_DEFENSE_GRID");
      } else if (state.pendingTacticalAction.magenDefenseGridAutoHitPending) {
        const defenderId = planet ? playersWithGroundForces(planet).find((id) => id !== state.pendingTacticalAction!.playerId) : undefined;
        if (defenderId === playerId) legal.push("ASSIGN_MAGEN_DEFENSE_GRID_HIT");
      } else if (owesHits) legal.push("ASSIGN_HITS");
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
  const cardsNeeded = getStrategyCardsPerPlayer(state);
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
