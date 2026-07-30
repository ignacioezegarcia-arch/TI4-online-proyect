import { GameState } from "./types/GameState";
import { GameAction, ActionResult, GameEvent } from "./types/Actions";
import { PlayerId, AgendaId, ActionCardId, asTechId } from "./types/ids";
import { RuleData } from "./types/RuleData";
import { chooseStrategyCard, getStrategyCardsPerPlayer, finishStrategyCardChoiceIfPhaseComplete } from "./phases/strategyPhase";
import { activateSystem, moveShips } from "./phases/tacticalAction";
import { announceRetreat, resolveSpaceCombatRound, assignHits, useAntiFighterBarrage, assignAntiFighterBarrageHits, useDuraniumArmor, skipDuraniumArmor, useAssaultCannonDestruction, removeExcessCapacityUnits } from "./phases/spaceCombat";
import {
  bombard,
  assignBombardmentHits,
  commitGroundForces,
  initiateCoexistCombat,
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
import { claimExpeditionSlice, completeThunderEdgeExpedition } from "./phases/expedition";
import { placeIngressTokens } from "./phases/theFracture";
import { convertCommoditiesViaSpaceStation } from "./rules/spaceStations";
import { resolveTransaction } from "./rules/transactions";
import { useCrownOfEmphidia, useMawOfWorlds, useBookOfLatvinia, useTheCodex, useStellarConverter, useNanoForge, useDynamisCore, useHeartOfIxth, useSilverFlame, useJrXs455O, useNeuraloop } from "./rules/relics";
import { gainFactionTechViaEntropicScar } from "./phases/entropicScar";
import { pass, autoAdvancePhase, scoreObjective, finishStatusPhaseScoring, placeGainedCommandTokensAction, finishEndOfTurn } from "./phases/actionPhase";
import { produceUnits, finishTacticalAction } from "./phases/production";
import { playActionCard, discardActionCard } from "./phases/actionCards";
import {
  playMiningInitiative,
  playIndustrialInitiative,
  playEconomicInitiative,
  playUprising,
  playFocusedResearch,
  playImpersonation,
  playUnexpectedAction,
  playRepealLaw,
  playFrontlineDeployment,
  playRiseOfAMessiah,
  playWarEffort,
  playGhostShip,
  playFighterConscription,
  playRefitTroops,
  playScuttle,
  playInsubordination,
  playLuckyShot,
  playReactorMeltdown,
  playSignalJamming,
  playSpy,
  playTacticalBombardment,
  playUnstablePlanet,
  playPlagiarize,
  playSeizeArtifact,
  playArchaeologicalExpedition,
  playDivertFunding,
  playExplorationProbe,
  playAssassinateRepresentative,
  playVeto,
  playHackElection,
  playInsiderInformation,
  playDiplomaticPressure,
  playImperialRider,
  playTradeRider,
  playLeadershipRider,
  playConstructionRider,
  playDiplomacyRider,
  playPoliticsRider,
  playTechnologyRider,
  playWarfareRider,
  playSanction,
  playFlankSpeed,
  playInTheSilenceOfSpace,
  playLostStarChart,
  playSolarFlare,
  playNavSuite,
  playMoraleBoost,
  playSkilledRetreat,
  playBunker,
  playBlitz,
  playSabotage,
  playSummit,
  playManipulateInvestments,
  playPoliticalStability,
  playPublicDisgrace,
  playCoupDetat,
  playAncientBurialSites,
  playDistinguishedCouncilor,
  playBribery,
  playConfusingLegalText,
  playConfoundingLegalText,
  playDeadlyPlot,
  playCrippleDefenses,
  playPlague,
  playDisable,
  playInfiltrate,
  playReparations,
  playParley,
  playGhostSquad,
  playUpgrade,
  playHarnessEnergy,
  playRally,
  playCounterstroke,
  playForwardSupplyBase,
  playDecoyOperation,
  playMasterPlan,
  playFighterPrototype,
  playEmergencyRepairs,
  playSalvage,
  playShieldsHolding,
  playManeuveringJets,
  playWarMachine,
  playReverseEngineer,
  playIntercept,
  playRout,
  playWaylay,
  playCourageousToTheEnd,
  playDirectHit,
  playReflectiveShielding,
  playExperimentalBattlestation,
  playFireTeam,
  playScrambleFrequency,
  playRevealPrototype,
  playStrategize,
  playOverrule,
  playCrisis,
  playPuppetsOnAString,
  playRescue,
  playLieInWait,
  playExchangeProgram,
  playBrilliance,
  playMercenaryContract,
  playPirateContract,
  playPirateFleet,
  playCrashLanding,
  playExtremeDuress,
  maybeApplyExtremeDuress,
} from "./phases/actionCardEffects";
import { passPriority, computeActionCardAnnounceWindowOrder, actionPhaseWindowOrder, agendaPhaseWindowOrder } from "./rules/priorityWindow";
import { revealAgenda, castVotes, resolveAgendaVote, continueAgendaPhaseAfterElectionReaction } from "./phases/agendaPhase";
import { checkGroundForcesCommittedWindow, finishGroundCombatWrapUp, openInvasionStartWindowIfNeeded } from "./phases/invasion";
import { resolveStrategyPrimary, resolveStrategySecondary } from "./phases/strategyCardAbilities";
import { researchTechnology, researchUnitUpgrade } from "./phases/technology";
import { exploreFrontier, purgeRelicFragments } from "./phases/exploration";
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
import { useAtrament, useImperialArmsVault, useExterrixHeadquarters, useMirageFlightAcademy, useDokNPicsSalvageYardPlay, useTheAcropolis, useTheGalacticCouncil, useJupiterBrain } from "./phases/legendaryPlanets";
import { useStarForge, useTheNucleus, applyStellarGenesisOnGain } from "./rules/muaat";
import { useOrbitalDrop, useZsThunderboltM2Deploy, resolveGenesisCapacityOverflow, useMilitarySupport, useClaireGibson, useJaceX } from "./rules/sol";
import { useRearAdmiralFarran, useDunlainReaperDeploy, useDarktalonTreilla, useMunitionsReserves, resolveFleetCleanup, useWarFunding, useWarFundingOmega } from "./rules/letnev";
import { useTekklarLegion, useExotriremeIISelfDestruct, useTro, useNorrSupremacy, useGhomSekkus, useShvalHarbinger } from "./rules/sardakk";
import { destroyShipForAntiIntellectualRevolution, exhaustPlanetsForAntiIntellectualRevolution, useCommitteeFormation, skipCommitteeFormation, destroyPdsForHomelandDefenseAct, discardRandomActionCardForExecutiveSanctions, useImperialArbiter, useMinisterOfPeace, useMinisterOfWar, useCrownOfThalnosReroll, skipCrownOfThalnosReroll, returnSecretObjective, getLawOwner } from "./phases/agendaEffects";
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
/**
 * RR (yjmrobert.com/tirules/rules/r_action_cards + the Xxcha Kingdom's
 * own Instinct Training rules): playing ANY action card first ANNOUNCES
 * it — nothing about the card resolves yet, nothing is paid, no dice are
 * rolled, no hidden choice (e.g. which technology Focused Research
 * researches) is even revealed — while every other eligible player gets
 * the RR 1.19/1.20 "action_card_announced" priority window to play
 * Sabotage against it. Only once that window fully closes with no
 * cancellation does applyAction's own PASS_PRIORITY handling re-dispatch
 * this SAME stored action to dispatchAction for real, running its actual
 * handler (playMoraleBoost, playFocusedResearch, whichever) for the
 * first time.
 */
function announceActionCard(state: GameState, action: GameAction & { playerId: PlayerId }, rules: RuleData): ActionResult {
  if (state.pendingActionCardAnnouncement) {
    return { ok: false, error: "Another action card's announcement is still pending resolution — it must resolve or be cancelled first." };
  }
  const cardId = action.type.replace(/^PLAY_/, "").toLowerCase() as ActionCardId;
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (!player.actionCards.includes(cardId)) {
    return { ok: false, error: `This player doesn't have ${cardId} in hand.` };
  }
  // RR "Political Censure": can't even announce a play while this law is active for them — same guard phases/actionCardEffects.ts's own playCard uses once a card actually resolves, checked again here so an ineligible player's announcement doesn't needlessly open a Sabotage window for something that could never legally resolve anyway.
  if (getLawOwner(state, "political_censure" as AgendaId) === action.playerId) {
    return { ok: false, error: 'RR "Political Censure": this player cannot play action cards while they own this card.' };
  }

  const order = computeActionCardAnnounceWindowOrder(state, action.playerId);
  const nextState: GameState = {
    ...state,
    pendingActionCardAnnouncement: { playerId: action.playerId, cardId, action },
    stashedPriorityWindow: state.pendingPriorityWindow,
    pendingPriorityWindow: order.length > 0 ? { kind: "action_card_announced", order, currentIndex: 0, consecutivePasses: 0 } : null,
  };

  // Nobody eligible to Sabotage at all (e.g. everyone else eliminated) — resolve immediately, same as a window that opened and instantly closed.
  if (order.length === 0) {
    return resolveAnnouncedActionCard(nextState, rules);
  }
  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_ANNOUNCED", playerId: action.playerId, cardId }] };
}

/** Restores whatever OUTER priority window (if any) was stashed when this card was announced, clears the announcement, and dispatches the originally-submitted action to its real handler for the first time. Shared by announceActionCard's own 0-eligible-Sabotage-responders shortcut and applyAction's own PASS_PRIORITY handling once the window closes normally. */
function resolveAnnouncedActionCard(state: GameState, rules: RuleData): ActionResult {
  const announced = state.pendingActionCardAnnouncement;
  if (!announced) return { ok: false, error: "No action card announcement is pending." };
  const stateWithoutAnnouncement: GameState = {
    ...state,
    pendingActionCardAnnouncement: undefined,
    pendingPriorityWindow: state.stashedPriorityWindow ?? null,
    stashedPriorityWindow: undefined,
  };
  return dispatchAction(stateWithoutAnnouncement, announced.action as GameAction, rules);
}

/** RR "Coup d'Etat": same shape as announceActionCard above, but for RESOLVE_STRATEGY_PRIMARY — opens "strategic_action_start" (order: every OTHER player, action-phase/initiative order) before the strategic action actually resolves, so Coup d'Etat can cancel it outright instead of only reacting after the fact. */
function announceStrategicAction(state: GameState, action: GameAction & { playerId: PlayerId }, rules: RuleData): ActionResult {
  if (state.pendingStrategicActionAnnouncement) {
    return { ok: false, error: "Another strategic action's announcement is still pending resolution." };
  }
  const order = actionPhaseWindowOrder(state, state.activePlayerId ?? action.playerId, Object.keys(state.players) as PlayerId[]).filter(
    (id) => id !== action.playerId && !state.players[id]?.eliminated,
  );
  const nextState: GameState = {
    ...state,
    pendingStrategicActionAnnouncement: { playerId: action.playerId, action },
    stashedPriorityWindow: state.pendingPriorityWindow,
    pendingPriorityWindow: order.length > 0 ? { kind: "strategic_action_start", order, currentIndex: 0, consecutivePasses: 0 } : null,
  };
  if (order.length === 0) return resolveAnnouncedStrategicAction(nextState, rules);
  return { ok: true, state: nextState, events: [] };
}

function resolveAnnouncedStrategicAction(state: GameState, rules: RuleData): ActionResult {
  const announced = state.pendingStrategicActionAnnouncement;
  if (!announced) return { ok: false, error: "No strategic action announcement is pending." };
  const stateWithoutAnnouncement: GameState = {
    ...state,
    pendingStrategicActionAnnouncement: undefined,
    pendingPriorityWindow: state.stashedPriorityWindow ?? null,
    stashedPriorityWindow: undefined,
  };
  return dispatchAction(stateWithoutAnnouncement, announced.action as GameAction, rules);
}

/**
 * The raw per-action-type dispatch table — used directly by applyAction
 * below for every action, AND called a second time, internally, the
 * moment an "action_card_announced" priority window fully closes with no
 * Sabotage (see applyAction's own PASS_PRIORITY handling and
 * announceActionCard below) — that second call is what actually runs a
 * card's real handler for the first time, since the initial PLAY_<CARD>
 * submission itself only ever announces, never resolves.
 */
function dispatchAction(state: GameState, action: GameAction, rules: RuleData): ActionResult {
  let result: ActionResult;
    switch (action.type) {
      case "CHOOSE_STRATEGY_CARD":
        result = chooseStrategyCard(state, action);
        break;
      case "PASS":
        result = pass(state, action, rules);
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
      case "REMOVE_EXCESS_CAPACITY_UNITS":
        result = removeExcessCapacityUnits(state, action);
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
      case "INITIATE_COEXIST_COMBAT":
        result = initiateCoexistCombat(state, action);
        break;
      case "CLAIM_EXPEDITION_SLICE":
        result = claimExpeditionSlice(state, action, rules);
        break;
      case "COMPLETE_THUNDER_EDGE_EXPEDITION":
        result = completeThunderEdgeExpedition(state, action, rules);
        break;
      case "PLACE_INGRESS_TOKENS":
        result = placeIngressTokens(state, action, rules);
        break;
      case "CONVERT_COMMODITIES_VIA_SPACE_STATION":
        result = convertCommoditiesViaSpaceStation(state, action);
        break;
      case "GAIN_FACTION_TECH_VIA_ENTROPIC_SCAR":
        result = gainFactionTechViaEntropicScar(state, action, rules);
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
        result = finishTacticalAction(state, action, rules);
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
        result = researchTechnology(state, action.playerId, action.techId, action.cost, action.exhaustPlanetIdsForResources, rules, action.useResearchTeamAttachmentPlanetId, action.exhaustPlanetIdsForTechSpecialty);
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
          action.exhaustPlanetIdsForTechSpecialty,
        );
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

      case "PLAY_MINING_INITIATIVE":
        result = playMiningInitiative(state, action, rules);
        break;
      case "PLAY_INDUSTRIAL_INITIATIVE":
        result = playIndustrialInitiative(state, action, rules);
        break;
      case "PLAY_ECONOMIC_INITIATIVE":
        result = playEconomicInitiative(state, action, rules);
        break;
      case "PLAY_UPRISING":
        result = playUprising(state, action, rules);
        break;
      case "PLAY_FOCUSED_RESEARCH":
        result = playFocusedResearch(state, action, rules);
        break;
      case "PLAY_IMPERSONATION":
        result = playImpersonation(state, action, rules);
        break;
      case "PLAY_UNEXPECTED_ACTION":
        result = playUnexpectedAction(state, action);
        break;
      case "PLAY_REPEAL_LAW":
        result = playRepealLaw(state, action);
        break;
      case "PLAY_FRONTLINE_DEPLOYMENT":
        result = playFrontlineDeployment(state, action);
        break;
      case "PLAY_RISE_OF_A_MESSIAH":
        result = playRiseOfAMessiah(state, action);
        break;
      case "PLAY_WAR_EFFORT":
        result = playWarEffort(state, action);
        break;
      case "PLAY_GHOST_SHIP":
        result = playGhostShip(state, action, rules);
        break;
      case "PLAY_FIGHTER_CONSCRIPTION":
        result = playFighterConscription(state, action, rules);
        break;
      case "PLAY_REFIT_TROOPS":
        result = playRefitTroops(state, action);
        break;
      case "PLAY_SCUTTLE":
        result = playScuttle(state, action, rules);
        break;
      case "PLAY_INSUBORDINATION":
        result = playInsubordination(state, action);
        break;
      case "PLAY_LUCKY_SHOT":
        result = playLuckyShot(state, action);
        break;
      case "PLAY_REACTOR_MELTDOWN":
        result = playReactorMeltdown(state, action, rules);
        break;
      case "PLAY_SIGNAL_JAMMING":
        result = playSignalJamming(state, action, rules);
        break;
      case "PLAY_SPY":
        result = playSpy(state, action);
        break;
      case "PLAY_TACTICAL_BOMBARDMENT":
        result = playTacticalBombardment(state, action, rules);
        break;
      case "PLAY_UNSTABLE_PLANET":
        result = playUnstablePlanet(state, action, rules);
        break;
      case "PLAY_PLAGIARIZE":
        result = playPlagiarize(state, action, rules);
        break;
      case "PLAY_SEIZE_ARTIFACT":
        result = playSeizeArtifact(state, action, rules);
        break;
      case "PLAY_ARCHAEOLOGICAL_EXPEDITION":
        result = playArchaeologicalExpedition(state, action, rules);
        break;
      case "PLAY_DIVERT_FUNDING":
        result = playDivertFunding(state, action, rules);
        break;
      case "PLAY_EXPLORATION_PROBE":
        result = playExplorationProbe(state, action, rules);
        break;
      case "PLAY_ASSASSINATE_REPRESENTATIVE":
        result = playAssassinateRepresentative(state, action);
        break;
      case "PLAY_VETO":
        result = playVeto(state, action, rules);
        break;
      case "PLAY_HACK_ELECTION":
        result = playHackElection(state, action);
        break;
      case "PLAY_INSIDER_INFORMATION":
        result = playInsiderInformation(state, action);
        break;
      case "PLAY_DIPLOMATIC_PRESSURE":
        result = playDiplomaticPressure(state, action);
        break;
      case "PLAY_IMPERIAL_RIDER":
        result = playImperialRider(state, action);
        break;
      case "PLAY_TRADE_RIDER":
        result = playTradeRider(state, action);
        break;
      case "PLAY_LEADERSHIP_RIDER":
        result = playLeadershipRider(state, action);
        break;
      case "PLAY_CONSTRUCTION_RIDER":
        result = playConstructionRider(state, action);
        break;
      case "PLAY_DIPLOMACY_RIDER":
        result = playDiplomacyRider(state, action);
        break;
      case "PLAY_POLITICS_RIDER":
        result = playPoliticsRider(state, action);
        break;
      case "PLAY_TECHNOLOGY_RIDER":
        result = playTechnologyRider(state, action);
        break;
      case "PLAY_WARFARE_RIDER":
        result = playWarfareRider(state, action);
        break;
      case "PLAY_SANCTION":
        result = playSanction(state, action);
        break;
      case "PLAY_FLANK_SPEED":
        result = playFlankSpeed(state, action);
        break;
      case "PLAY_IN_THE_SILENCE_OF_SPACE":
        result = playInTheSilenceOfSpace(state, action);
        break;
      case "PLAY_LOST_STAR_CHART":
        result = playLostStarChart(state, action);
        break;
      case "PLAY_SOLAR_FLARE":
        result = playSolarFlare(state, action);
        break;
      case "PLAY_NAV_SUITE":
        result = playNavSuite(state, action);
        break;
      case "PLAY_MORALE_BOOST":
        result = playMoraleBoost(state, action);
        break;
      case "PLAY_SKILLED_RETREAT":
        result = playSkilledRetreat(state, action, rules);
        break;
      case "PLAY_BUNKER":
        result = playBunker(state, action);
        break;
      case "PLAY_BLITZ":
        result = playBlitz(state, action);
        break;
      case "PLAY_SABOTAGE":
        result = playSabotage(state, action);
        break;
      case "PLAY_SUMMIT":
        result = playSummit(state, action);
        break;
      case "PLAY_MANIPULATE_INVESTMENTS":
        result = playManipulateInvestments(state, action);
        break;
      case "PLAY_POLITICAL_STABILITY":
        result = playPoliticalStability(state, action);
        break;
      case "PLAY_PUBLIC_DISGRACE":
        result = playPublicDisgrace(state, action);
        break;
      case "PLAY_COUP_DETAT":
        result = playCoupDetat(state, action);
        break;
      case "PLAY_ANCIENT_BURIAL_SITES":
        result = playAncientBurialSites(state, action, rules);
        break;
      case "PLAY_DISTINGUISHED_COUNCILOR":
        result = playDistinguishedCouncilor(state, action);
        break;
      case "PLAY_BRIBERY":
        result = playBribery(state, action);
        break;
      case "PLAY_CONFUSING_LEGAL_TEXT":
        result = playConfusingLegalText(state, action);
        break;
      case "PLAY_CONFOUNDING_LEGAL_TEXT":
        result = playConfoundingLegalText(state, action);
        break;
      case "PLAY_DEADLY_PLOT":
        result = playDeadlyPlot(state, action, rules);
        break;
      case "PLAY_CRIPPLE_DEFENSES":
        result = playCrippleDefenses(state, action);
        break;
      case "PLAY_PLAGUE":
        result = playPlague(state, action);
        break;
      case "PLAY_DISABLE":
        result = playDisable(state, action);
        break;
      case "PLAY_INFILTRATE":
        result = playInfiltrate(state, action);
        break;
      case "PLAY_REPARATIONS":
        result = playReparations(state, action);
        break;
      case "PLAY_PARLEY":
        result = playParley(state, action);
        break;
      case "PLAY_GHOST_SQUAD":
        result = playGhostSquad(state, action);
        break;
      case "PLAY_UPGRADE":
        result = playUpgrade(state, action);
        break;
      case "PLAY_HARNESS_ENERGY":
        result = playHarnessEnergy(state, action, rules);
        break;
      case "PLAY_RALLY":
        result = playRally(state, action);
        break;
      case "PLAY_COUNTERSTROKE":
        result = playCounterstroke(state, action);
        break;
      case "PLAY_FORWARD_SUPPLY_BASE":
        result = playForwardSupplyBase(state, action);
        break;
      case "PLAY_DECOY_OPERATION":
        result = playDecoyOperation(state, action);
        break;
      case "PLAY_MASTER_PLAN":
        result = playMasterPlan(state, action);
        break;
      case "PLAY_FIGHTER_PROTOTYPE":
        result = playFighterPrototype(state, action);
        break;
      case "PLAY_EMERGENCY_REPAIRS":
        result = playEmergencyRepairs(state, action);
        break;
      case "PLAY_SALVAGE":
        result = playSalvage(state, action);
        break;
      case "PLAY_SHIELDS_HOLDING":
        result = playShieldsHolding(state, action);
        break;
      case "PLAY_MANEUVERING_JETS":
        result = playManeuveringJets(state, action);
        break;
      case "PLAY_WAR_MACHINE":
        result = playWarMachine(state, action);
        break;
      case "PLAY_REVERSE_ENGINEER":
        result = playReverseEngineer(state, action);
        break;
      case "PLAY_INTERCEPT":
        result = playIntercept(state, action);
        break;
      case "PLAY_ROUT":
        result = playRout(state, action, rules);
        break;
      case "PLAY_WAYLAY":
        result = playWaylay(state, action);
        break;
      case "PLAY_COURAGEOUS_TO_THE_END":
        result = playCourageousToTheEnd(state, action, rules);
        break;
      case "PLAY_DIRECT_HIT":
        result = playDirectHit(state, action);
        break;
      case "PLAY_REFLECTIVE_SHIELDING":
        result = playReflectiveShielding(state, action, rules);
        break;
      case "PLAY_EXPERIMENTAL_BATTLESTATION":
        result = playExperimentalBattlestation(state, action, rules);
        break;
      case "PLAY_FIRE_TEAM":
        result = playFireTeam(state, action, rules);
        break;
      case "PLAY_SCRAMBLE_FREQUENCY":
        result = playScrambleFrequency(state, action, rules);
        break;
      case "PLAY_REVEAL_PROTOTYPE":
        result = playRevealPrototype(state, action, rules);
        break;
      case "PLAY_STRATEGIZE":
        result = playStrategize(state, action, rules);
        break;
      case "PLAY_OVERRULE":
        result = playOverrule(state, action, rules);
        break;
      case "PLAY_CRISIS":
        result = playCrisis(state, action);
        break;
      case "PLAY_PUPPETS_ON_A_STRING":
        result = playPuppetsOnAString(state, action);
        break;
      case "PLAY_RESCUE":
        result = playRescue(state, action);
        break;
      case "PLAY_LIE_IN_WAIT":
        result = playLieInWait(state, action);
        break;
      case "PLAY_EXCHANGE_PROGRAM":
        result = playExchangeProgram(state, action, rules);
        break;
      case "PLAY_BRILLIANCE":
        result = playBrilliance(state, action, rules);
        break;
      case "PLAY_MERCENARY_CONTRACT":
        result = playMercenaryContract(state, action, rules);
        break;
      case "PLAY_PIRATE_CONTRACT":
        result = playPirateContract(state, action, rules);
        break;
      case "PLAY_PIRATE_FLEET":
        result = playPirateFleet(state, action, rules);
        break;
      case "PLAY_CRASH_LANDING":
        result = playCrashLanding(state, action, rules);
        break;
      case "PLAY_EXTREME_DURESS":
        result = playExtremeDuress(state, action);
        break;
      case "USE_CROWN_OF_EMPHIDIA":
        result = useCrownOfEmphidia(state, action, rules);
        break;
      case "USE_MAW_OF_WORLDS":
        result = useMawOfWorlds(state, action);
        break;
      case "USE_BOOK_OF_LATVINIA":
        result = useBookOfLatvinia(state, action, rules);
        break;
      case "USE_THE_CODEX":
        result = useTheCodex(state, action);
        break;
      case "USE_STELLAR_CONVERTER":
        result = useStellarConverter(state, action, rules);
        break;
      case "USE_NANO_FORGE":
        result = useNanoForge(state, action, rules);
        break;
      case "USE_DYNAMIS_CORE":
        result = useDynamisCore(state, action, rules);
        break;
      case "USE_HEART_OF_IXTH":
        result = useHeartOfIxth(state, action);
        break;
      case "USE_SILVER_FLAME":
        result = useSilverFlame(state, action, rules);
        break;
      case "USE_JR_XS455_O":
        result = useJrXs455O(state, action, rules);
        break;
      case "USE_NEURALOOP":
        result = useNeuraloop(state, action, rules);
        break;
      case "USE_DOK_N_PICS_SALVAGE_YARD_PLAY":
        result = useDokNPicsSalvageYardPlay(state, action);
        break;
      case "USE_THE_ACROPOLIS":
        result = useTheAcropolis(state, action);
        break;
      case "USE_THE_GALACTIC_COUNCIL":
        result = useTheGalacticCouncil(state, action);
        break;
      case "USE_JUPITER_BRAIN":
        result = useJupiterBrain(state, action);
        break;
      case "USE_ORBITAL_DROP":
        result = useOrbitalDrop(state, action);
        break;
      case "USE_ZS_THUNDERBOLT_M2_DEPLOY":
        result = useZsThunderboltM2Deploy(state, action, rules);
        break;
      case "RESOLVE_GENESIS_CAPACITY_OVERFLOW":
        result = resolveGenesisCapacityOverflow(state, action);
        break;
      case "USE_MILITARY_SUPPORT":
        result = useMilitarySupport(state, action);
        break;
      case "USE_CLAIRE_GIBSON":
        result = useClaireGibson(state, action, rules);
        break;
      case "USE_JACE_X":
        result = useJaceX(state, action);
        break;
      case "USE_REAR_ADMIRAL_FARRAN":
        result = useRearAdmiralFarran(state, action, rules);
        break;
      case "USE_DUNLAIN_REAPER_DEPLOY":
        result = useDunlainReaperDeploy(state, action, rules);
        break;
      case "USE_DARKTALON_TREILLA":
        result = useDarktalonTreilla(state, action);
        break;
      case "USE_MUNITIONS_RESERVES":
        result = useMunitionsReserves(state, action, rules);
        break;
      case "RESOLVE_FLEET_CLEANUP":
        result = resolveFleetCleanup(state, action, rules);
        break;
      case "USE_WAR_FUNDING":
        result = useWarFunding(state, action, rules);
        break;
      case "USE_WAR_FUNDING_OMEGA":
        result = useWarFundingOmega(state, action, rules);
        break;
      case "USE_TEKKLAR_LEGION":
        result = useTekklarLegion(state, action);
        break;
      case "USE_EXOTRIREME_II_SELF_DESTRUCT":
        result = useExotriremeIISelfDestruct(state, action);
        break;
      case "USE_TRO":
        result = useTro(state, action, rules);
        break;
      case "USE_NORR_SUPREMACY":
        result = useNorrSupremacy(state, action);
        break;
      case "USE_GHOM_SEKKUS":
        result = useGhomSekkus(state, action, rules);
        break;
      case "USE_SHVAL_HARBINGER":
        result = useShvalHarbinger(state, action);
        break;
      case "USE_STAR_FORGE":
        result = useStarForge(state, action, rules);
        break;
      case "USE_THE_NUCLEUS":
        result = useTheNucleus(state, action, rules);
        break;
      case "APPLY_STELLAR_GENESIS":
        result = applyStellarGenesisOnGain(state, action.playerId, action.targetSystemId, rules);
        break;
      case "PASS_PRIORITY":
        result = passPriority(state, action);
        break;

      // --- Not yet implemented. Each of these follows the exact same shape
      // as the cases above — see phases/README.md for the recipe.
      case "PROPOSE_TRANSACTION":
        result = resolveTransaction(state, action, rules);
        break;
      case "END_TURN_TIMEOUT":
        return { ok: false, error: `${action.type} is not implemented yet.` };

      default: {
        const exhaustiveCheck: never = action;
        return { ok: false, error: `Unknown action: ${JSON.stringify(exhaustiveCheck)}` };
      }
    }
  return result;
}

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

    // RR (yjmrobert.com/tirules/rules/r_action_cards): every action card
    // must be ANNOUNCED before it resolves, giving every other eligible
    // player a chance to Sabotage it first — see announceActionCard's own
    // doc comment. PLAY_ACTION_CARD (the generic mechanical-only fallback
    // for cards without their own dedicated action yet) and PLAY_SABOTAGE
    // itself (which resolves directly against an ALREADY-open
    // "action_card_announced" window rather than opening its own) are the
    // only 2 exceptions.
    if (action.type.startsWith("PLAY_") && action.type !== "PLAY_ACTION_CARD" && action.type !== "PLAY_SABOTAGE") {
      return announceActionCard(state, action as GameAction & { playerId: PlayerId }, rules);
    }
    // RR "Coup d'Etat": same announce-first treatment as action cards, but for a strategic action's own primary ability resolving.
    if (action.type === "RESOLVE_STRATEGY_PRIMARY" && "playerId" in action) {
      return announceStrategicAction(state, action as GameAction & { playerId: PlayerId }, rules);
    }

    const dispatchResult = dispatchAction(state, action, rules);
    // If this action just closed a window that has its own "now actually
    // do the thing" follow-up (every eligible player consecutively
    // passed — a successful Sabotage/Public Disgrace instead clears its
    // own pending marker directly, so these checks naturally skip when
    // that happened), run that follow-up and merge in whatever events it
    // produces.
    let result: ActionResult = dispatchResult;
    if (dispatchResult.ok && dispatchResult.state && !dispatchResult.state.pendingPriorityWindow) {
      if (state.pendingPriorityWindow?.kind === "action_card_announced" && dispatchResult.state.pendingActionCardAnnouncement) {
        const resolved = resolveAnnouncedActionCard(dispatchResult.state, rules);
        result = resolved.ok ? { ok: true, state: resolved.state, events: [...(dispatchResult.events ?? []), ...resolved.events] } : resolved;
      } else if (state.pendingPriorityWindow?.kind === "strategy_card_chosen" && dispatchResult.state.lastStrategyCardChoice) {
        const finished = finishStrategyCardChoiceIfPhaseComplete(dispatchResult.state, dispatchResult.events ?? []);
        result = finished;
      } else if (state.pendingPriorityWindow?.kind === "strategic_action_start" && dispatchResult.state.pendingStrategicActionAnnouncement) {
        const resolved = resolveAnnouncedStrategicAction(dispatchResult.state, rules);
        result = resolved.ok ? { ok: true, state: resolved.state, events: [...(dispatchResult.events ?? []), ...resolved.events] } : resolved;
      } else if (state.pendingPriorityWindow?.kind === "after_you_cast_votes") {
        // RR "Distinguished Councilor"/"Bribery": if this really was the last vote (RR 8.2.ii: voting order always ends with the speaker), open "after_speaker_votes" for everyone next — actual resolution is deferred to THAT window closing, not this one.
        const pendingVote = dispatchResult.state.pendingAgendaVote;
        if (pendingVote && pendingVote.nextVoterIndex >= pendingVote.votingOrder.length) {
          const order = agendaPhaseWindowOrder(dispatchResult.state).filter((id) => !dispatchResult.state.players[id]?.eliminated);
          result =
            order.length > 0
              ? { ok: true, state: { ...dispatchResult.state, pendingPriorityWindow: { kind: "after_speaker_votes", order, currentIndex: 0, consecutivePasses: 0 } }, events: dispatchResult.events ?? [] }
              : (() => {
                  const resolved = resolveAgendaVote(dispatchResult.state, rules);
                  return { ok: true, state: resolved.state, events: [...(dispatchResult.events ?? []), ...resolved.events] };
                })();
        }
      } else if (state.pendingPriorityWindow?.kind === "after_speaker_votes" && dispatchResult.state.pendingAgendaVote) {
        const resolved = resolveAgendaVote(dispatchResult.state, rules);
        result = { ok: true, state: resolved.state, events: [...(dispatchResult.events ?? []), ...resolved.events] };
      } else if (state.pendingPriorityWindow?.kind === "elected_as_outcome") {
        const continued = continueAgendaPhaseAfterElectionReaction(dispatchResult.state, rules, dispatchResult.events ?? []);
        result = { ok: true, state: continued.state, events: continued.events };
      } else if (state.pendingPriorityWindow?.kind === "outcome_would_be_resolved") {
        // RR (yjmrobert.com/tirules/components/c_action_cards): this window now opens AFTER finalizeAgendaResolutionWithPredictions has already run (elected_as_outcome comes first) — pendingAgendaVote is null in BOTH the "everyone declined" and "Deadly Plot resolved it" cases now, so this always calls the SAME continuation uniformly (matching how planet_control_gained etc. are already handled) rather than trying to distinguish the two.
        const continued = continueAgendaPhaseAfterElectionReaction(dispatchResult.state, rules, dispatchResult.events ?? []);
        result = { ok: true, state: continued.state, events: continued.events };
      } else if (state.pendingPriorityWindow?.kind === "planet_control_gained") {
        const continuation = dispatchResult.state.pendingPlanetControlGainedContinuation;
        const stateWithoutMarker: GameState = { ...dispatchResult.state, pendingPlanetControlGainedContinuation: undefined };
        const pendingTactical = stateWithoutMarker.pendingTacticalAction;
        if (continuation === "check_ground_forces_committed" && pendingTactical) {
          result = checkGroundForcesCommittedWindow(stateWithoutMarker, pendingTactical.playerId, pendingTactical.systemId, dispatchResult.events ?? []);
        } else if (continuation === "ground_combat_wrap_up" && pendingTactical) {
          const finished = finishGroundCombatWrapUp(stateWithoutMarker, pendingTactical, pendingTactical.systemId, dispatchResult.events ?? []);
          result = { ok: true, state: finished.state, events: finished.events };
        }
      } else if (state.pendingPriorityWindow?.kind === "after_system_activated" && dispatchResult.state.pendingTacticalAction) {
        // RR "Counterstroke"/"Forward Supply Base"/"Rally"/"Decoy Operation": once THIS activating player's own 2 system-activation windows are both done, everyone ELSE who has standing (a command token, units, or structures already there) gets their own chance to react to the activation itself.
        const pendingTactical = dispatchResult.state.pendingTacticalAction;
        const system = dispatchResult.state.systems[pendingTactical.systemId];
        const others = system
          ? (Object.keys(dispatchResult.state.players) as PlayerId[]).filter((id) => {
              if (id === pendingTactical.playerId || dispatchResult.state.players[id]?.eliminated) return false;
              const hasToken = dispatchResult.state.players[id].commandTokens.onBoard.includes(pendingTactical.systemId);
              const hasShips = (system.spaceUnitsByPlayer[id] ?? []).some((s) => s.count > 0);
              const hasGroundOrStructures = system.planets.some((p) => (p.unitsByPlayer[id] ?? []).some((s) => s.count > 0));
              return hasToken || hasShips || hasGroundOrStructures;
            })
          : [];
        const order = actionPhaseWindowOrder(dispatchResult.state, pendingTactical.playerId, others);
        if (order.length > 0) {
          result = {
            ok: true,
            state: { ...dispatchResult.state, pendingPriorityWindow: { kind: "after_another_player_activates_system", order, currentIndex: 0, consecutivePasses: 0 } },
            events: dispatchResult.events ?? [],
          };
        }
      } else if (state.pendingPriorityWindow?.kind === "space_combat_won" && dispatchResult.state.pendingTacticalAction?.step === "invasion") {
        result = { ok: true, state: openInvasionStartWindowIfNeeded(dispatchResult.state), events: dispatchResult.events ?? [] };
      } else if (state.pendingPriorityWindow?.kind === "end_of_turn") {
        // TE "Crisis"/"Puppets on a String": once every eligible player has declined (or acted), proceed to the SAME advanceActivePlayer call maybeAdvanceActivePlayer would have made directly.
        result = { ok: true, state: finishEndOfTurn(dispatchResult.state, rules), events: dispatchResult.events ?? [] };
      }
    }

    if (!result.ok || !result.state) return result;

    // TE "Extreme Duress": checked against the ARMED player's own very
    // next action, whatever its type — a no-op unless this action's own
    // playerId matches whoever Extreme Duress is currently watching.
    const actingPlayerId = "playerId" in action ? action.playerId : undefined;
    const duressResult = actingPlayerId ? maybeApplyExtremeDuress(result.state, actingPlayerId, action.type) : { state: result.state, events: [] };
    result = { ok: true, state: duressResult.state, events: [...(result.events ?? []), ...duressResult.events] };

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

    // RR 1.19/1.20: whoever's turn it currently is in an open priority
    // window (see rules/priorityWindow.ts) can always at least pass on it.
    // This does NOT enumerate which specific PLAY_<CARD> reactive actions
    // are also legal right now (that depends on which matching cards this
    // player actually holds, plus each one's own further legality checks —
    // same "not modeled here" scope cut PLAY_ACTION_CARD's own comment
    // below already covers) — whatever's asking this player should offer
    // PASS_PRIORITY alongside any of their held cards whose printed timing
    // matches the window's own `kind`.
    if (state.pendingPriorityWindow && state.pendingPriorityWindow.order[state.pendingPriorityWindow.currentIndex] === playerId) {
      legal.push("PASS_PRIORITY");
    }

    // RR 2.4/2.7: PLAY_ACTION_CARD here is only the generic, mechanical-
    // only fallback for the handful of action cards that don't have their
    // own dedicated PLAY_<CARD> action yet (see phases/actionCards.ts's
    // own header comment) — for those, this project genuinely doesn't
    // model the card's own printed timing window, so it's offered
    // whenever the player holds any, same deferred-content scope as the
    // card's own effect. Every card that DOES have its own dedicated
    // action (most of them, by now) isn't enumerated here at all — its
    // real legality depends on which specific timing window is currently
    // open (see rules/priorityWindow.ts) plus its own target-specific
    // checks, which this deliberately-conservative function doesn't
    // reach into. Voluntary discard has no timing restriction either way.
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
      if (state.pendingTacticalAction.pendingCapacityOverflow?.playerId === playerId) {
        legal.push("REMOVE_EXCESS_CAPACITY_UNITS");
      }
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
    // RR "Political Stability": sat out this round's picks entirely.
    if (candidate.skipsNextStrategyPick) continue;
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
