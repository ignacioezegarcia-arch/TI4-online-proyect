import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, asLeaderId, asAbilityId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { getAdjacentSystems } from "./adjacency";
import { setPlanetController } from "../phases/invasion";
import { unlockCommander } from "./leaders";
import { hasAbility } from "./abilities";
import { advanceActivePlayer } from "../phases/actionPhase";
import { isPlayersTurnInWindow } from "./priorityWindow";
import { checkReinforcementsAvailable } from "./reinforcements";

/**
 * Xxcha "PEACE ACCORDS" (faction ability): "After you resolve the
 * primary or secondary ability of the 'Diplomacy' strategy card, you
 * may gain control of 1 planet other than Mecatol Rex that does not
 * contain any units and is in a system that is adjacent to a planet you
 * control." Confirmed (yjmrobert.com/tirules/factions/f_xxcha):
 *  - "A planet is adjacent to both the system it is in, and every
 *    system adjacent to that" — i.e. the TARGET planet just needs to
 *    sit in a system that is itself adjacent to (or the same as) a
 *    system where this player controls a planet.
 *  - If the target planet was uncontrolled, this player explores it
 *    (routed through invasion.ts's own setPlanetController, same as
 *    every other route to control in this project — RR 25.1c).
 *  - Gained exhausted (setPlanetController's own default for every
 *    control-gain, nothing special needed here).
 *
 * KNOWN SIMPLIFICATION: this project has no generic "you just resolved
 * Diplomacy's primary/secondary" hook — the caller is trusted to submit
 * this action only right after actually doing so, same "immediately
 * after X" category as several other reactive abilities elsewhere.
 */
export function usePeaceAccords(
  state: GameState,
  action: { type: "USE_PEACE_ACCORDS"; playerId: PlayerId; targetPlanetId: PlanetId; chosenTrait?: "cultural" | "industrial" | "hazardous"; explorationChoice?: import("../phases/exploration").ExplorationCardChoice },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === action.targetPlanetId);
    if (planet) {
      found = { systemId: systemId as SystemId, system, planet };
      break;
    }
  }
  if (!found) return { ok: false, error: `No planet ${action.targetPlanetId}.` };
  if (rules.planets[action.targetPlanetId]?.isMecatolRex) return { ok: false, error: "PEACE ACCORDS: cannot target Mecatol Rex." };
  const hasAnyUnits = Object.values(found.planet.unitsByPlayer).some((stacks) => (stacks ?? []).some((s) => s.count > 0));
  if (hasAnyUnits) return { ok: false, error: "PEACE ACCORDS: that planet must contain no units." };

  const eligibleSystemIds = new Set([found.systemId, ...getAdjacentSystems(state, found.systemId, rules)]);
  const hasAdjacentControlledPlanet = Object.entries(state.systems).some(
    ([sysId, sys]) => eligibleSystemIds.has(sysId as SystemId) && sys.planets.some((p) => p.controllerId === action.playerId),
  );
  if (!hasAdjacentControlledPlanet) {
    return { ok: false, error: "PEACE ACCORDS: that planet's system isn't adjacent to (or the same as) a system with a planet this player controls." };
  }

  const controlResult = setPlanetController(state, found.systemId, action.targetPlanetId, action.playerId, rules, action.chosenTrait, action.explorationChoice);
  return { ok: true, state: controlResult.state, events: [...controlResult.events, { type: "PLANET_CONTROL_ESTABLISHED", systemId: found.systemId, planetId: action.targetPlanetId, playerId: action.playerId }] };
}

/**
 * Xxcha "Ggrucoto Rinn" (agent): "ACTION: Exhaust this card to ready any
 * planet; if that planet is in a system that is adjacent to a planet
 * you control, you may remove 1 infantry from that planet and return it
 * to its reinforcements." Confirmed (yjmrobert.com/tirules/factions/f_xxcha):
 *  - Same "adjacent to a planet you control" scope as PEACE ACCORDS —
 *    the target planet's own system, or one adjacent to it, needs a
 *    planet THIS player (Xxcha) controls.
 *  - "A planet must be exhausted to be targeted" — only makes sense to
 *    ready an already-exhausted one.
 *  - "Ready ANY planet" (no ownership restriction on the planet itself)
 *    is the same AGENT-BENEFITS-ANY-PLAYER pattern as this project's
 *    own fixed Evelyn DeLouis/Viscount Unlenn — the infantry-removal
 *    half only makes sense if THAT planet's own controller agrees to
 *    it, but this project models it as the CASTER's own single choice
 *    (bundled into one action), same simplification as Exchange Program
 *    and similar mutual-consent mechanics elsewhere.
 */
export function useGgrucotoRinn(
  state: GameState,
  action: { type: "USE_GGRUCOTO_RINN"; playerId: PlayerId; targetPlanetId: PlanetId; removeInfantry?: boolean },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const agentEntry = player.leaders.find((l) => l.leaderId === ("xxcha_agent" as never));
  if (!agentEntry) return { ok: false, error: "This player doesn't have Ggrucoto Rinn." };
  if (agentEntry.exhausted) return { ok: false, error: "Ggrucoto Rinn is already exhausted." };

  let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === action.targetPlanetId);
    if (planet) {
      found = { systemId: systemId as SystemId, system, planet };
      break;
    }
  }
  if (!found) return { ok: false, error: `No planet ${action.targetPlanetId}.` };
  if (!found.planet.exhausted) return { ok: false, error: "Ggrucoto Rinn: that planet must be exhausted to be targeted." };

  const updatedPlanet: PlanetState = { ...found.planet, exhausted: false };
  let systems: GameState["systems"] = { ...state.systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)) } };

  if (action.removeInfantry) {
    const eligibleSystemIds = new Set([found.systemId, ...getAdjacentSystems(state, found.systemId, rules)]);
    const hasAdjacentControlledPlanet = Object.entries(state.systems).some(
      ([sysId, sys]) => eligibleSystemIds.has(sysId as SystemId) && sys.planets.some((p) => p.controllerId === action.playerId),
    );
    if (!hasAdjacentControlledPlanet) {
      return { ok: false, error: "Ggrucoto Rinn: that planet's system isn't adjacent to (or the same as) a system with a planet this player controls." };
    }
    const controllerId = updatedPlanet.controllerId;
    if (!controllerId) return { ok: false, error: "Ggrucoto Rinn: that planet has no controller, so there's no infantry owner to remove from." };
    const stacks = updatedPlanet.unitsByPlayer[controllerId] ?? [];
    const infantryStack = stacks.find((s) => s.unitType === "infantry" && s.count > 0);
    if (!infantryStack) return { ok: false, error: "That planet has no infantry to remove." };
    const finalPlanet: PlanetState = { ...updatedPlanet, unitsByPlayer: { ...updatedPlanet.unitsByPlayer, [controllerId]: stacks.map((s) => (s === infantryStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0) } };
    systems = { ...systems, [found.systemId]: { ...systems[found.systemId], planets: systems[found.systemId].planets.map((p) => (p.planetId === action.targetPlanetId ? finalPlanet : p)) } };
  }

  const updatedPlayer: Player = { ...player, leaders: player.leaders.map((l) => (l.leaderId === ("xxcha_agent" as never) ? { ...l, exhausted: true } : l)) };
  return { ok: true, state: { ...state, systems, players: { ...state.players, [action.playerId]: updatedPlayer } }, events: [] };
}

/**
 * Xxcha "Elder Qanoj" (commander, passive): "Each planet you exhaust to
 * cast votes provides 1 additional vote. Game effects cannot prevent
 * you from voting on an agenda." Confirmed
 * (yjmrobert.com/tirules/factions/f_xxcha):
 *  - "A planet with zero influence may be used to cast one additional
 *    vote" — the bonus is PER PLANET EXHAUSTED, not per influence point,
 *    so even a 0-influence planet contributes +1.
 *  - "Game effects may prevent the Xxcha player from casting ADDITIONAL
 *    votes" — the voting-immunity half is scoped to being ABLE to vote
 *    at all, not to this specific bonus (a separate mechanic this
 *    project's own agenda-phase voting-eligibility checks would need to
 *    respect, not built here since this project has no generic "this
 *    player cannot vote" blocking effect yet to exempt Xxcha from).
 */
export function getElderQanojVoteBonus(state: GameState, playerId: PlayerId, exhaustedPlanetCount: number): number {
  const player = state.players[playerId];
  const commanderEntry = player?.leaders.find((l) => l.leaderId === ("xxcha_commander" as never));
  if (!commanderEntry || commanderEntry.locked) return 0;
  return exhaustedPlanetCount;
}

/**
 * Shared discard-and-reveal-replacement mechanic for Xxcha "QUASH"
 * (faction ability) and "Political Favor" (promissory note): "When an
 * agenda is revealed, [discard that agenda and reveal 1 agenda from the
 * top of the deck]. Players vote on this agenda instead." Confirmed
 * (yjmrobert.com/tirules/factions/f_xxcha):
 *  - QUASH/Political Favor/the Political Secret promissory note/the
 *    Veto action card are all played in the SAME timing window, before
 *    the rider window — checked here via pendingPriorityWindow.kind
 *    being "agenda_revealed".
 *  - "Quash may be used on the replacement agenda" — this function is
 *    reusable; nothing here prevents calling it again on the new
 *    agendaId right after.
 *  - Each agenda is considered SEPARATE for the once-per-agenda
 *    transaction limit — achieved for free here, since transactionsThisAgenda
 *    gets cleared the SAME way revealAgenda's own normal path already
 *    does for a fresh reveal.
 */
function discardAndRevealReplacementAgenda(state: GameState): GameState {
  const pending = state.pendingAgendaVote!;
  const discardedId = pending.agendaId;
  const [newAgendaId, ...rest] = state.agendaDeck.deckIds;
  return {
    ...state,
    agendaDeck: { ...state.agendaDeck, deckIds: rest, discardIds: [...state.agendaDeck.discardIds, discardedId] },
    pendingAgendaVote: { ...pending, agendaId: newAgendaId, votesByOutcome: {} },
    transactionsThisAgenda: undefined,
  };
}

/**
 * Xxcha "QUASH" (faction ability): "When an agenda is revealed, you may
 * spend 1 token from your strategy pool to discard that agenda and
 * reveal 1 agenda from the top of the deck. Players vote on this agenda
 * instead."
 */
export function useQuash(state: GameState, action: { type: "USE_QUASH"; playerId: PlayerId } ): ActionResult {
  const player = state.players[action.playerId];
  if (!hasAbility(player, asAbilityId("quash"))) return { ok: false, error: "This player doesn't have QUASH." };
  if (state.pendingPriorityWindow?.kind !== "agenda_revealed" || !state.pendingAgendaVote) {
    return { ok: false, error: "QUASH is only usable right when an agenda is revealed." };
  }
  if (player.commandTokens.strategy <= 0) return { ok: false, error: "No command token in this player's strategy pool to spend." };

  const updatedPlayer: Player = { ...player, commandTokens: { ...player.commandTokens, strategy: player.commandTokens.strategy - 1 } };
  const nextState = discardAndRevealReplacementAgenda({ ...state, players: { ...state.players, [action.playerId]: updatedPlayer } });
  return { ok: true, state: nextState, events: [] };
}

/**
 * Xxcha "Political Favor" (promissory note): "When an agenda is
 * revealed: Remove 1 token from the Xxcha player's strategy pool and
 * return it to their reinforcements. Then, discard the revealed agenda
 * and reveal 1 agenda from the top of the deck. Players vote on this
 * agenda instead. Then, return this card to the Xxcha player." Confirmed
 * (yjmrobert.com/tirules/factions/f_xxcha): "if the Xxcha player has no
 * command tokens in their strategy pool, Political Favor CANNOT be
 * played" (unlike some OTHER "remove 1 token if able" promissory notes
 * elsewhere, this one is a hard requirement, not a soft "if able").
 */
export function usePoliticalFavor(state: GameState, action: { type: "USE_POLITICAL_FAVOR"; playerId: PlayerId } ): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("political_favor" as never)) {
    return { ok: false, error: "This player doesn't have Political Favor in hand." };
  }
  if (state.pendingPriorityWindow?.kind !== "agenda_revealed" || !state.pendingAgendaVote) {
    return { ok: false, error: "Political Favor is only usable right when an agenda is revealed." };
  }
  const xxchaPlayerId = Object.values(state.players).find((p) => p.factionId === ("xxcha" as never))?.id;
  if (!xxchaPlayerId) return { ok: false, error: "No Xxcha player in this game." };
  const xxchaPlayer = state.players[xxchaPlayerId];
  if (xxchaPlayer.commandTokens.strategy <= 0) return { ok: false, error: "Political Favor cannot be played — the Xxcha player has no command tokens in their strategy pool." };

  const updatedXxchaPlayer: Player = {
    ...xxchaPlayer,
    commandTokens: { ...xxchaPlayer.commandTokens, strategy: xxchaPlayer.commandTokens.strategy - 1 },
    promissoryNotesInHand: [...xxchaPlayer.promissoryNotesInHand, "political_favor" as never],
  };
  const updatedPlayer: Player = { ...player, promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("political_favor" as never)) };
  const workingState: GameState = { ...state, players: { ...state.players, [action.playerId]: updatedPlayer, [xxchaPlayerId]: updatedXxchaPlayer } };
  return { ok: true, state: discardAndRevealReplacementAgenda(workingState), events: [] };
}

/**
 * Xxcha "Nullification Field" (faction tech, exhaustable): "After
 * another player activates a system that contains 1 or more of your
 * ships, you may exhaust this card and spend 1 token from your strategy
 * pool; immediately end that player's turn." Confirmed
 * (yjmrobert.com/tirules/factions/f_xxcha):
 *  - Once resolved, the active player can't use any "after you activate
 *    a system" ability, and NO player (including Xxcha) can use any
 *    "after another player activates a system that..." ability for
 *    THIS SAME activation.
 *  - The active player CAN still use "at the end of your turn"
 *    abilities.
 *
 * KNOWN GAP: this project's own E-Res Siphons/Trade Convoys triggers
 * fire INSIDE activateSystem itself, before any reactive window a
 * response like this could occupy — meaning by the time this action
 * could be submitted, those 2 effects have already resolved for this
 * activation. Properly suppressing them retroactively would need
 * deeper surgery into activateSystem's own control flow than this pass
 * covers; flagged rather than silently handled.
 */
export function useNullificationField(
  state: GameState,
  action: { type: "USE_NULLIFICATION_FIELD"; playerId: PlayerId; targetSystemId: SystemId },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.technologies.includes("nullification_field" as never)) {
    return { ok: false, error: "This player doesn't have Nullification Field." };
  }
  if (player.exhaustedTechnologies.includes("nullification_field" as never)) {
    return { ok: false, error: "Nullification Field is already exhausted." };
  }
  if (player.commandTokens.strategy <= 0) return { ok: false, error: "No command token in this player's strategy pool to spend." };
  const pending = state.pendingTacticalAction;
  if (!pending || pending.systemId !== action.targetSystemId || pending.playerId === action.playerId) {
    return { ok: false, error: "Nullification Field: no other player's tactical action currently in that system." };
  }
  const hasOwnShipsThere = (state.systems[action.targetSystemId]?.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0);
  if (!hasOwnShipsThere) return { ok: false, error: "This player has no ships in that system." };

  const updatedPlayer: Player = {
    ...player,
    exhaustedTechnologies: [...player.exhaustedTechnologies, "nullification_field" as never],
    commandTokens: { ...player.commandTokens, strategy: player.commandTokens.strategy - 1 },
  };
  const stateWithClearedAction: GameState = { ...state, players: { ...state.players, [action.playerId]: updatedPlayer }, pendingTacticalAction: null };
  return { ok: true, state: advanceActivePlayer(stateWithClearedAction, rules), events: [] };
}

/**
 * Xxcha "Instinct Training" (faction tech, exhaustable): "You may
 * exhaust this card and spend 1 token from your strategy pool when
 * another player plays an action card; cancel that action card."
 * Confirmed (yjmrobert.com/tirules/factions/f_xxcha):
 *  - Can cancel Sabotage itself.
 *  - If the cancelled card had a second copy, the player may play THAT
 *    one instead (not applicable here — that's the PLAYER'S own later
 *    choice, this function just cancels the first one).
 *  - No costs are paid for the cancelled card.
 *  - If it was a card with a later effect (a rider), it can ONLY be
 *    cancelled right here, at its original announcement.
 *  - If cancelling a card that was to perform a component action, the
 *    active player must perform a different action or pass.
 *
 * Structurally near-identical to phases/actionCardEffects.ts's own
 * playSabotage (that function's own doc comment already references
 * Instinct Training directly) — same announced-but-not-yet-resolved
 * state, just Xxcha's own tech + strategy token instead of playing a
 * card.
 */
export function useInstinctTraining(
  state: GameState,
  action: { type: "USE_INSTINCT_TRAINING"; playerId: PlayerId },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.technologies.includes("instinct_training" as never)) {
    return { ok: false, error: "This player doesn't have Instinct Training." };
  }
  if (player.exhaustedTechnologies.includes("instinct_training" as never)) {
    return { ok: false, error: "Instinct Training is already exhausted." };
  }
  if (player.commandTokens.strategy <= 0) return { ok: false, error: "No command token in this player's strategy pool to spend." };
  if (!isPlayersTurnInWindow(state, "action_card_announced", action.playerId)) {
    return { ok: false, error: "It isn't this player's turn in the current action-card-announcement priority window." };
  }
  const announced = state.pendingActionCardAnnouncement;
  if (!announced) return { ok: false, error: "No action card is currently pending Instinct Training." };

  const announcer = state.players[announced.playerId];
  const updatedAnnouncer: Player = { ...announcer, actionCards: announcer.actionCards.filter((c) => c !== announced.cardId) };
  const updatedPlayer: Player = {
    ...player,
    exhaustedTechnologies: [...player.exhaustedTechnologies, "instinct_training" as never],
    commandTokens: { ...player.commandTokens, strategy: player.commandTokens.strategy - 1 },
  };
  const nextState: GameState = {
    ...state,
    players: { ...state.players, [announced.playerId]: updatedAnnouncer, [action.playerId]: updatedPlayer },
    actionCardDiscardPile: [...(state.actionCardDiscardPile ?? []), announced.cardId],
    pendingActionCardAnnouncement: undefined,
    pendingPriorityWindow: state.stashedPriorityWindow ?? null,
    stashedPriorityWindow: undefined,
  };

  return { ok: true, state: nextState, events: [{ type: "ACTION_CARD_CANCELLED", playerId: announced.playerId, cardId: announced.cardId, cancelledBy: action.playerId }] };
}

/**
 * Xxcha "Xxekir Grom — PLANETARY DEFENSE NEXUS ΩΩ" (hero, Thunder's Edge
 * version, single-use): "ACTION: Place any combination of up to 4 PDS
 * or mechs onto planets you control; ready each planet that you place a
 * unit on. Then, purge this card." Confirmed
 * (yjmrobert.com/tirules/factions/f_xxcha):
 *  - Units may be placed on an ALREADY-readied planet too (no
 *    requirement that the target be exhausted first).
 *  - Multiple units may be placed on the SAME planet.
 *
 * This is the LATEST (Thunder's Edge) version of Xxekir Grom's own
 * ability, superseding the Codex Ω version above whenever this game
 * includes Thunder's Edge content — see this project's own rules/
 * gameMode.ts for that gating.
 */
export function useXxekirGromOmegaOmega(
  state: GameState,
  action: { type: "USE_XXEKIR_GROM_OMEGA_OMEGA"; playerId: PlayerId; placements: { planetId: PlanetId; unitType: "pds" | "mech"; count: number }[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player.leaders.find((l) => l.leaderId === ("xxcha_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Xxekir Grom." };

  const totalPlaced = action.placements.reduce((sum, p) => sum + p.count, 0);
  if (totalPlaced > 4) return { ok: false, error: "PLANETARY DEFENSE NEXUS: can place at most 4 units total." };
  if (totalPlaced <= 0) return { ok: false, error: "No units specified to place." };

  let systems: GameState["systems"] = state.systems;
  const events: GameEvent[] = [];
  for (const { planetId, unitType, count } of action.placements) {
    if (count <= 0) continue;
    let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
    for (const [systemId, system] of Object.entries(systems)) {
      const planet = system.planets.find((p) => p.planetId === planetId);
      if (planet) {
        found = { systemId: systemId as SystemId, system, planet };
        break;
      }
    }
    if (!found || found.planet.controllerId !== action.playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };

    const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType, count }]);
    if (!reinforcementsCheck.ok) return reinforcementsCheck;

    const stacks = found.planet.unitsByPlayer[action.playerId] ?? [];
    const existing = stacks.find((s) => s.unitType === unitType);
    const updatedStacks = existing ? stacks.map((s) => (s.unitType === unitType ? { ...s, count: s.count + count } : s)) : [...stacks, { unitType, count, damagedCount: 0 }];
    const updatedPlanet: PlanetState = { ...found.planet, unitsByPlayer: { ...found.planet.unitsByPlayer, [action.playerId]: updatedStacks }, exhausted: false };
    systems = { ...systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } };
    events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: found.systemId, planetId, unitType, count, totalCost: 0 });
  }

  const updatedPlayer: Player = { ...player, leaders: player.leaders.filter((l) => l.leaderId !== ("xxcha_hero" as never)) };
  return { ok: true, state: { ...state, systems, players: { ...state.players, [action.playerId]: updatedPlayer } }, events };
}
