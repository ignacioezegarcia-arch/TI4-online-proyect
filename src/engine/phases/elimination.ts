import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { GameEvent } from "../types/Actions";
import { PlayerId, AgendaId, ObjectiveId, PromissoryNoteId } from "../types/ids";
import { GROUND_FORCE_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { fisherYatesShuffle } from "../setup/mapGeneration";

/**
 * RR 87.7/98.7: EVERY source of victory points, not just SCORE_OBJECTIVE
 * (Custodians Token, Shard of the Throne/Crown of Emphidia's VP transfer,
 * Holy Planet of Ixth, Political Censure, Mutiny, Seed of an Empire,
 * Imperial's own "control Mecatol Rex" +1 clause, and any future one),
 * needs to be checked against the victory point target — previously only
 * scoreObjectiveCore (phases/actionPhase.ts) did this, meaning a player
 * could cross the target via any of those OTHER sources and the game
 * would never recognize the win. Centralized here and called once per
 * action from GameEngine, right alongside checkAndApplyEliminations,
 * rather than retrofitting a win-check into every individual VP-granting
 * call site across 5+ files.
 *
 * RR 98.7's own tie-break, for the rare case more than one player crosses
 * the threshold via the SAME action (e.g. "Mutiny" granting VP to several
 * "for" voters at once): earliest in initiative order among those who
 * qualify; if nobody currently has a strategy card (initiativeOrder is
 * empty — e.g. during the agenda phase), the tied player nearest the
 * speaker, going clockwise (i.e. earliest in seatOrder starting from the
 * speaker), wins instead.
 */
export function checkForVictory(state: GameState): GameState {
  if (state.winnerId) return state;
  const qualifying = Object.values(state.players).filter((p) => !p.eliminated && p.victoryPoints.current >= state.victoryPointTarget);
  if (qualifying.length === 0) return state;

  let winnerId: PlayerId;
  const byInitiative = state.initiativeOrder.find((id) => qualifying.some((p) => p.id === id));
  if (byInitiative) {
    winnerId = byInitiative;
  } else {
    const speakerId = state.seatOrder.find((id) => state.players[id]?.isSpeaker);
    const startIndex = speakerId ? state.seatOrder.indexOf(speakerId) : 0;
    const clockwiseFromSpeaker = [...state.seatOrder.slice(startIndex), ...state.seatOrder.slice(0, startIndex)];
    winnerId = (clockwiseFromSpeaker.find((id) => qualifying.some((p) => p.id === id)) ?? qualifying[0].id) as PlayerId;
  }

  return { ...state, winnerId };
}

/**
 * RR 33 ELIMINATION. Confirmed: `player.eliminated` was previously only
 * ever READ throughout this project (turn legality, agenda voting order,
 * status-phase bookkeeping, strategy-card selection, etc.) but nothing
 * ever actually SET it — meaning the entire elimination mechanic was a
 * no-op the whole time this project checked for it. This file is the one
 * place that both detects (33.1) and applies (33.2-33.9, 33.11) it.
 *
 * Called once per successfully-applied action, from GameEngine's own
 * applyAction, right alongside autoAdvancePhase — cheap to run
 * unconditionally since eliminate-checking a player who obviously still
 * has units/planets is an early-exit.
 *
 * NOT implemented, flagged rather than silently skipped:
 *  - RR 33.10's faction-specific interactions (Nekro Virus Valefar
 *    Assimilator, Ghosts of Creuss wormhole tokens, Naalu "0" token,
 *    Titans of Ul attachments, Mahact command tokens) — every one of
 *    these is deferred faction-specific content this project hasn't
 *    built yet (see this project's own established scope note on
 *    faction abilities generally).
 *  - RR 33.9 (5+-player games staying at 1 strategy card per player even
 *    after elimination drops them to 4 or fewer) — would need this
 *    project to track the ORIGINAL starting player count somewhere,
 *    which GameState doesn't have a field for yet. Flagged, not guessed.
 */
export function checkAndApplyEliminations(state: GameState, rules: RuleData): { state: GameState; events: GameEvent[] } {
  let nextState = state;
  const events: GameEvent[] = [];

  for (const playerId of Object.keys(state.players) as PlayerId[]) {
    if (nextState.players[playerId].eliminated) continue;
    if (!meetsEliminationConditions(nextState, playerId, rules)) continue;
    const result = eliminatePlayer(nextState, playerId, rules);
    nextState = result.state;
    events.push(...result.events);
  }

  return { state: nextState, events };
}

/** RR 33.1: a player is eliminated once ALL THREE are true simultaneously — no ground forces anywhere on the board, no unit anywhere with the "production" ability, and no planet under their control. */
function meetsEliminationConditions(state: GameState, playerId: PlayerId, rules: RuleData): boolean {
  const player = state.players[playerId];
  let hasGroundForces = false;
  let hasProductionUnit = false;
  let controlsAnyPlanet = false;

  for (const system of Object.values(state.systems)) {
    for (const stack of system.spaceUnitsByPlayer[playerId] ?? []) {
      if (stack.count <= 0) continue;
      if (GROUND_FORCE_TYPES.includes(stack.unitType)) hasGroundForces = true;
      const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
      if (stats?.abilities.includes("production")) hasProductionUnit = true;
    }
    for (const planet of system.planets) {
      if (planet.controllerId === playerId) controlsAnyPlanet = true;
      for (const stack of planet.unitsByPlayer[playerId] ?? []) {
        if (stack.count <= 0) continue;
        if (GROUND_FORCE_TYPES.includes(stack.unitType)) hasGroundForces = true;
        const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
        if (stats?.abilities.includes("production")) hasProductionUnit = true;
      }
    }
    if (hasGroundForces && hasProductionUnit && controlsAnyPlanet) return false; // early exit — can't possibly qualify
  }

  return !hasGroundForces && !hasProductionUnit && !controlsAnyPlanet;
}

function eliminatePlayer(state: GameState, playerId: PlayerId, rules: RuleData): { state: GameState; events: GameEvent[] } {
  const player = state.players[playerId];
  const events: GameEvent[] = [{ type: "PLAYER_ELIMINATED" as const, playerId }];

  // RR 33.2: every remaining unit this player has anywhere on the board
  // is removed (returned to the box) — structures, stray ships, anything
  // left over. Ground forces/production/control are already confirmed
  // absent by this point, but a lone non-Production ship sitting in a
  // system's space area, for instance, wouldn't have blocked elimination
  // and still needs clearing here.
  const systems: GameState["systems"] = Object.fromEntries(
    Object.entries(state.systems).map(([systemId, system]) => [
      systemId,
      {
        ...system,
        spaceUnitsByPlayer: Object.fromEntries(Object.entries(system.spaceUnitsByPlayer).filter(([pid]) => pid !== playerId)),
        planets: system.planets.map((p) => ({
          ...p,
          unitsByPlayer: Object.fromEntries(Object.entries(p.unitsByPlayer).filter(([pid]) => pid !== playerId)),
          // A planet this player still somehow controlled would have blocked elimination — this is just belt-and-suspenders in case a controlToken-only (no units) control slipped through.
          controllerId: p.controllerId === playerId ? null : p.controllerId,
        })),
      } as SystemState,
    ]),
  );

  // RR 33.3: every agenda card this player OWNS is discarded.
  const ownedLawIds = state.agendaDeck.lawsInPlay.filter((l) => l.ownerId === playerId).map((l) => l.agendaId);
  const agendaDeck = {
    ...state.agendaDeck,
    lawsInPlay: state.agendaDeck.lawsInPlay.filter((l) => l.ownerId !== playerId),
    discardIds: [...state.agendaDeck.discardIds, ...ownedLawIds],
  };

  // RR 33.6: strategy cards return to the common play area regardless of exhausted state.
  const unclaimedStrategyCards = [
    ...state.unclaimedStrategyCards,
    ...player.strategyCards.map((c) => ({ cardId: c.cardId, tradeGoods: 0 })),
  ];

  // RR 33.7: secret objectives (held AND already-scored ones) shuffle back into the deck.
  const scoredSecretIds = player.victoryPoints.scoredObjectiveIds.filter((id) => rules.objectives[id]?.kind === "secret");
  const returningSecretIds: ObjectiveId[] = [...player.secretObjectives, ...scoredSecretIds];
  const secretObjectiveDeck = returningSecretIds.length > 0 ? fisherYatesShuffle([...(state.secretObjectiveDeck ?? []), ...returningSecretIds], Math.random) : state.secretObjectiveDeck;

  // RR 33.4: promissory notes. (a) any note whose PRINTED owner is this
  // eliminated player is returned to the box outright, even if another
  // player currently holds it. (b) any note this player currently holds
  // that belongs to someone ELSE is returned to that original owner.
  const promissoryNoteInstances = state.promissoryNoteInstances
    ? Object.fromEntries(Object.entries(state.promissoryNoteInstances).filter(([, note]) => note.ownerId !== playerId))
    : state.promissoryNoteInstances;
  const eliminatedOwnNoteIds = new Set(
    Object.entries(state.promissoryNoteInstances ?? {})
      .filter(([, note]) => note.ownerId === playerId)
      .map(([id]) => id as PromissoryNoteId),
  );
  const notesHeldByEliminated = [...player.promissoryNotesInHand, ...player.promissoryNotesInPlayArea].filter((id) => !eliminatedOwnNoteIds.has(id));

  let players: GameState["players"] = { ...state.players };
  for (const noteId of notesHeldByEliminated) {
    const originalOwnerId = state.promissoryNoteInstances?.[noteId]?.ownerId;
    if (!originalOwnerId || !players[originalOwnerId]) continue;
    const owner = players[originalOwnerId];
    players = { ...players, [originalOwnerId]: { ...owner, promissoryNotesInHand: [...owner.promissoryNotesInHand, noteId] } };
  }
  // Strip any reference to this eliminated player's own notes from every OTHER player's hand/play area too (returned to the box, not tradeable anymore).
  for (const [pid, p] of Object.entries(players)) {
    if (pid === playerId) continue;
    const filteredHand = p.promissoryNotesInHand.filter((id) => !eliminatedOwnNoteIds.has(id));
    const filteredPlayArea = p.promissoryNotesInPlayArea.filter((id) => !eliminatedOwnNoteIds.has(id));
    if (filteredHand.length !== p.promissoryNotesInHand.length || filteredPlayArea.length !== p.promissoryNotesInPlayArea.length) {
      players = { ...players, [pid]: { ...p, promissoryNotesInHand: filteredHand, promissoryNotesInPlayArea: filteredPlayArea } };
    }
  }

  // RR 33.8: speaker token passes to the next non-eliminated player to the (soon-to-be-eliminated) speaker's left.
  let seatOrder = state.seatOrder;
  if (player.isSpeaker) {
    const idx = seatOrder.indexOf(playerId);
    for (let i = 1; i <= seatOrder.length; i++) {
      const candidateId = seatOrder[(idx + i) % seatOrder.length];
      if (candidateId === playerId) continue;
      players = { ...players, [candidateId]: { ...players[candidateId], isSpeaker: true } };
      break;
    }
  }

  // RR 33.5 (action cards discarded), RR 33.11 (captured units returned to their original owners — this player simply stops holding them; there's no separate "reinforcements pool" object to credit them back into in this engine), and the elimination flag itself.
  const updatedEliminatedPlayer: Player = {
    ...players[playerId],
    eliminated: true,
    isSpeaker: false,
    hasPassed: true,
    actionCards: [],
    strategyCards: [],
    secretObjectives: [],
    promissoryNotesInHand: [],
    promissoryNotesInPlayArea: [],
    commandTokens: { tactic: 0, fleet: 0, strategy: 0, onBoard: [] },
    capturedUnits: [],
    capturedGenericUnits: { infantry: 0, fighter: 0 },
  };
  players = { ...players, [playerId]: updatedEliminatedPlayer };

  const actionCardDiscardPile = [...(state.actionCardDiscardPile ?? []), ...player.actionCards];

  const nextState: GameState = {
    ...state,
    systems,
    players,
    seatOrder,
    agendaDeck,
    unclaimedStrategyCards,
    secretObjectiveDeck,
    promissoryNoteInstances,
    actionCardDiscardPile,
  };

  return { state: nextState, events };
}
