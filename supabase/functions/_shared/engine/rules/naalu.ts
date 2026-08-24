import { GameState, Player, PlanetState } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, SystemId, asAbilityId, asLeaderId } from "../types/ids";
import { UnitType } from "../types/enums";
import { RuleData } from "../types/RuleData";
import { hasAbility } from "./abilities";
import { canUseAgent, exhaustLeader, purgeHero } from "./leaders";
import { isAdjacent } from "./adjacency";
import { activateSystem } from "../phases/tacticalAction";
import { hasCodex, hasThundersEdge } from "./gameMode";

/**
 * This file was previously delivered but never actually made it into the
 * uploaded repo (the 9 functions below were already being imported by
 * name from GameEngine.ts/actionPhase.ts/exploration.ts, which is exactly
 * why the whole project failed to compile) — rebuilt from those exact
 * call sites plus data/factions/naalu.json, confirmed against
 * yjmrobert.com/tirules/factions/f_naalu and tirules2.com/F_naalu where
 * cited below.
 */

function findNaaluPlayerId(state: GameState): PlayerId | undefined {
  return Object.values(state.players).find((p) => p.factionId === ("naalu" as never) && !p.eliminated)?.id;
}

function addPlanetUnits(planet: PlanetState, playerId: PlayerId, unitType: UnitType, count: number): PlanetState {
  const stacks = planet.unitsByPlayer[playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === unitType && !s.upgradeId);
  const updatedStacks = existing
    ? stacks.map((s) => (s === existing ? { ...s, count: s.count + count } : s))
    : [...stacks, { unitType, count, damagedCount: 0 }];
  return { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [playerId]: updatedStacks } };
}

/**
 * Naalu Collective "TELEPATHIC" (faction ability): "At the end of the
 * strategy phase, place the Naalu '0' token on your strategy card; you
 * are first in initiative order." Confirmed (yjmrobert.com/tirules/
 * factions/f_naalu): "the Naalu '0' token stays with the Naalu [player]
 * or the faction that gained the token through the 'Gift of Prescience'
 * promissory note" — i.e. this passive re-claim is SUPPRESSED for the
 * round if Gift of Prescience was actually played this round (checked
 * here as "does anyone currently have naalu_promissory face-up in their
 * play area" — if so, useGiftOfPrescience already set the holder itself
 * and this function leaves it alone). Called once, right at the RR 73.2
 * "end of the strategy phase" moment — see phases/strategyPhase.ts's own
 * finishStrategyCardChoiceIfPhaseComplete, immediately before
 * computeInitiativeOrder (rules/initiative.ts) actually consumes
 * naaluZeroTokenHolderId.
 */
export function applyTelepathic(state: GameState): GameState {
  const naaluId = findNaaluPlayerId(state);
  if (!naaluId) return state;

  const giftHolderId = Object.values(state.players).find((p) => p.promissoryNotesInPlayArea.includes("naalu_promissory" as never))?.id;
  if (giftHolderId) return state; // Gift of Prescience was played this round — TELEPATHIC is suppressed, holder already set.

  return { ...state, naaluZeroTokenHolderId: naaluId };
}

/**
 * Naalu Collective "Gift of Prescience" (promissory note, base version).
 * "Timing: At the end of the strategy phase: Place this card face-up in
 * your play area and place the Naalu '0' token on your strategy card;
 * you are first in the initiative order. The Naalu player cannot use
 * their TELEPATHIC faction ability during this game round. Return this
 * card to the Naalu player at the end of the status phase." The
 * RECIPIENT plays this (any player who was previously given the note in
 * a transaction) — playerId here is whoever is now claiming first
 * initiative, not necessarily Naalu themselves.
 */
export function useGiftOfPrescience(state: GameState, action: { type: "USE_GIFT_OF_PRESCIENCE"; playerId: PlayerId }): ActionResult {
  if (state.phase !== "strategy") {
    return { ok: false, error: "Gift of Prescience can only be played at the end of the strategy phase." };
  }
  const player = state.players[action.playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (!player.promissoryNotesInHand.includes("naalu_promissory" as never)) {
    return { ok: false, error: "This player doesn't have Gift of Prescience in hand." };
  }

  const updatedPlayer: Player = {
    ...player,
    promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("naalu_promissory" as never)),
    promissoryNotesInPlayArea: [...player.promissoryNotesInPlayArea, "naalu_promissory" as never],
  };
  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer }, naaluZeroTokenHolderId: action.playerId },
    events: [],
  };
}

/**
 * The return half of Gift of Prescience — "Return this card to the Naalu
 * player at the end of the status phase." Same shape as rules/hacan.ts's
 * own maybeReturnTradeConvoys, just on a phase-boundary timer instead of
 * a reactive trigger. Called unconditionally from phases/actionPhase.ts's
 * own runStatusPhaseBookkeeping — a no-op if nobody currently has it in
 * their play area (including if Naalu themselves were the one who played
 * it, which the card's own text doesn't actually prevent).
 */
export function maybeReturnGiftOfPrescience(state: GameState): GameState {
  const naaluId = findNaaluPlayerId(state);
  if (!naaluId) return state;
  const holderId = Object.values(state.players).find((p) => p.promissoryNotesInPlayArea.includes("naalu_promissory" as never))?.id;
  if (!holderId) return state;

  let players = state.players;
  const holder = players[holderId];
  players = { ...players, [holderId]: { ...holder, promissoryNotesInPlayArea: holder.promissoryNotesInPlayArea.filter((id) => id !== ("naalu_promissory" as never)) } };
  if (holderId !== naaluId) {
    const naaluPlayer = players[naaluId];
    players = { ...players, [naaluId]: { ...naaluPlayer, promissoryNotesInHand: [...naaluPlayer.promissoryNotesInHand, "naalu_promissory" as never] } };
  }
  return { ...state, players };
}

/**
 * Naalu Collective "Z'eu — Ω" (agent, Codex version): "ACTION: Exhaust
 * this card and choose a player; that player may perform a tactical
 * action in a non-home system without placing a command token; that
 * system still counts as being activated." Confirmed
 * (yjmrobert.com/tirules/factions/f_naalu): "this does NOT count as the
 * tactical-action player's own turn, so they cannot use Fleet Logistics,
 * however they could use Master Plan or Minister of War"; "if the chosen
 * player had previously passed, they are still considered passed during
 * their action, and do not pass again at the end of it." Delegates
 * straight into phases/tacticalAction.ts's own activateSystem — that
 * function's own `skipCommandToken` parameter exists specifically for
 * this ability (see its own doc comment) and already enforces "not this
 * player's own home system" and every other normal activation rule.
 * Superseded entirely by the ΩΩ (Thunder's Edge) version once TE is in
 * play — same "highest applicable version wins" precedence this project
 * already uses for reworked technologies (rules/gameMode.ts's own
 * usesCodex4Version doc comment).
 */
export function useZeuOmega(
  state: GameState,
  action: { type: "USE_ZEU_OMEGA"; playerId: PlayerId; targetPlayerId: PlayerId; systemId: SystemId },
  rules: RuleData,
): ActionResult {
  if (!hasCodex(state.mode)) return { ok: false, error: "Z'eu — Ω requires Codex content." };
  if (hasThundersEdge(state.mode)) return { ok: false, error: "Thunder's Edge supersedes this version — use Z'eu ΩΩ instead." };
  if (state.phase !== "action") return { ok: false, error: "Z'eu — Ω is only usable during the action phase." };
  if (state.activePlayerId !== action.playerId) return { ok: false, error: "RR 4: it's not this player's turn." };
  if (state.pendingTacticalAction) {
    return { ok: false, error: "A tactical action is already in progress; resolve it before using Z'eu — Ω." };
  }
  const player = state.players[action.playerId];
  const agentCheck = canUseAgent(player, asLeaderId("naalu_agent"));
  if (!agentCheck.ok) return agentCheck;
  const target = state.players[action.targetPlayerId];
  if (!target || target.eliminated) return { ok: false, error: "Unknown or eliminated target player." };
  if (target.id === action.playerId) return { ok: false, error: "Z'eu — Ω must choose another player." };

  const exhaustedPlayer = exhaustLeader(player, asLeaderId("naalu_agent"));
  const preActivation: GameState = { ...state, players: { ...state.players, [action.playerId]: exhaustedPlayer }, activePlayerId: action.targetPlayerId };

  const activation = activateSystem(preActivation, { type: "ACTIVATE_SYSTEM", playerId: action.targetPlayerId, systemId: action.systemId }, rules, true);
  if (!activation.ok) return activation;
  const pending = activation.state.pendingTacticalAction;
  if (!pending) return { ok: false, error: "Z'eu — Ω: failed to activate the system." };

  // Banked here so phases/production.ts's own finishTacticalAction restores the REAL active player directly once this borrowed action ends, instead of advancing turn order normally.
  const finalState: GameState = { ...activation.state, pendingTacticalAction: { ...pending, zeuOmegaOriginalActivePlayerId: action.playerId } };
  return { ok: true, state: finalState, events: activation.events };
}

/**
 * Naalu Collective "Z'eu — ΩΩ" (agent, Thunder's Edge version): "After
 * any player's command token is placed in a system: You may exhaust this
 * card to return that token to that player's reinforcements." Broader
 * than the Ω version above — triggers off ANY command token landing in
 * ANY system (a tactical action, Diplomacy's primary/secondary, a
 * Construction placement, etc.), not just tactical-action activations,
 * so this is intentionally not folded into phases/tacticalAction.ts's
 * own activateSystem the way e.g. E-Res Siphons is. The removed token
 * goes to reinforcements (the shared box), not back into any of the
 * target's own 3 pools — matches how activation itself already moves a
 * token OUT of a pool onto the board (rules/reinforcements.ts's own
 * total-supply accounting treats onBoard and the 3 pools as disjoint).
 */
export function useZeuOmegaOmega(
  state: GameState,
  action: { type: "USE_ZEU_OMEGA_OMEGA"; playerId: PlayerId; targetPlayerId: PlayerId; systemId: SystemId },
): ActionResult {
  if (!hasThundersEdge(state.mode)) return { ok: false, error: "Z'eu — ΩΩ requires Thunder's Edge." };
  const player = state.players[action.playerId];
  const agentCheck = canUseAgent(player, asLeaderId("naalu_agent"));
  if (!agentCheck.ok) return agentCheck;
  const target = state.players[action.targetPlayerId];
  if (!target) return { ok: false, error: "Unknown target player." };
  if (!target.commandTokens.onBoard.includes(action.systemId)) {
    return { ok: false, error: "That player doesn't have a command token in that system." };
  }

  const updatedTarget: Player = { ...target, commandTokens: { ...target.commandTokens, onBoard: target.commandTokens.onBoard.filter((id) => id !== action.systemId) } };
  const updatedPlayer = exhaustLeader(player, asLeaderId("naalu_agent"));
  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer, [action.targetPlayerId]: updatedTarget } },
    events: [],
  };
}

/**
 * Naalu Collective "Neuroglaive" (faction technology): "After another
 * player activates a system that contains 1 or more of your ships, that
 * player removes 1 token from their fleet pool and returns it to their
 * reinforcements." Confirmed (sirreileffects.com/naalu-collective,
 * tirules2.com/F_naalu — "the active player must meet fleet pool limits
 * in all systems that contain their ships before they may proceed to the
 * Movement step") this deterministically targets the FLEET pool
 * specifically, never a player choice of pool — action.removedCommandTokenPool
 * is validated against "fleet" rather than actually branched on, kept as
 * an explicit field on the action so the caller/UI states plainly which
 * pool is about to be affected. Confirmed (boardgamegeek.com/thread/
 * 2011582) reducing the pool to 0 is legal, no floor-protection fallback
 * exists — this simply errors if it's ALREADY at 0 (nothing left to
 * remove), rather than silently substituting a different pool.
 */
export function useNeuroglaive(
  state: GameState,
  action: { type: "USE_NEUROGLAIVE"; playerId: PlayerId; activatingPlayerId: PlayerId; systemId: SystemId; removedCommandTokenPool: "tactic" | "fleet" | "strategy" },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player || player.factionId !== ("naalu" as never)) return { ok: false, error: "Only the Naalu player has Neuroglaive." };
  if (!player.technologies.includes("neuroglaive" as never)) return { ok: false, error: "This player doesn't have Neuroglaive." };
  if (action.removedCommandTokenPool !== "fleet") {
    return { ok: false, error: "Neuroglaive always removes a token from the activating player's own fleet pool." };
  }
  const activating = state.players[action.activatingPlayerId];
  if (!activating || activating.id === action.playerId) return { ok: false, error: "Unknown or invalid activating player." };
  const activatedSystem = state.systems[action.systemId];
  const hasNaaluShips = (activatedSystem?.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0);
  if (!hasNaaluShips) return { ok: false, error: "Neuroglaive: that system doesn't contain any of this player's ships." };
  if (activating.commandTokens.fleet <= 0) return { ok: false, error: "That player's fleet pool is already empty." };

  const updatedActivating: Player = { ...activating, commandTokens: { ...activating.commandTokens, fleet: activating.commandTokens.fleet - 1 } };
  return { ok: true, state: { ...state, players: { ...state.players, [action.activatingPlayerId]: updatedActivating } }, events: [] };
}

/**
 * Naalu Collective "The Oracle" (hero): "C-RADIUM GEOMETRY — At the end
 * of the status phase: You may force each other player to give you 1
 * promissory note from their hand. If you do, purge this card." Every
 * OTHER non-eliminated player who currently holds at least 1 note in
 * hand needs an entry in `choices`; a player with an empty hand simply
 * has nothing to give and is skipped (not an error). Which SPECIFIC note
 * each target gives isn't RR-specified as the Naalu player's own choice
 * (typically the target's), so this project's own engine takes it as a
 * caller-supplied resolution (same "trusted caller" simplification this
 * project already uses for other hidden-information-adjacent choices)
 * rather than modeling a full secret negotiation.
 */
export function useTheOracle(
  state: GameState,
  action: { type: "USE_THE_ORACLE"; playerId: PlayerId; choices: { targetPlayerId: PlayerId; promissoryNoteId: string }[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player?.leaders.find((l) => l.leaderId === ("naalu_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have The Oracle unlocked." };

  const expectedTargetIds = new Set(
    Object.values(state.players)
      .filter((p) => p.id !== action.playerId && !p.eliminated && p.promissoryNotesInHand.length > 0)
      .map((p) => p.id),
  );
  const providedTargetIds = new Set(action.choices.map((c) => c.targetPlayerId));
  for (const id of expectedTargetIds) {
    if (!providedTargetIds.has(id)) return { ok: false, error: `The Oracle: missing a choice for ${id}, who holds at least 1 promissory note.` };
  }

  let players = state.players;
  for (const choice of action.choices) {
    const target = players[choice.targetPlayerId];
    if (!target) return { ok: false, error: `Unknown target player ${choice.targetPlayerId}.` };
    if (!target.promissoryNotesInHand.includes(choice.promissoryNoteId as never)) {
      return { ok: false, error: `${choice.targetPlayerId} doesn't have that promissory note in hand.` };
    }
    const acting = players[action.playerId];
    players = {
      ...players,
      [choice.targetPlayerId]: { ...target, promissoryNotesInHand: target.promissoryNotesInHand.filter((id) => id !== (choice.promissoryNoteId as never)) },
      [action.playerId]: { ...acting, promissoryNotesInHand: [...acting.promissoryNotesInHand, choice.promissoryNoteId as never] },
    };
  }

  players = { ...players, [action.playerId]: purgeHero(players[action.playerId], asLeaderId("naalu_hero")) };
  void rules;
  return { ok: true, state: { ...state, players }, events: [] };
}

/**
 * Naalu Collective's own Breakthrough ability "Mindsieve": "When you
 * would resolve the secondary ability of another player's strategy card,
 * you may give them a promissory note to resolve it without spending a
 * command token." Split into 2 steps to match this project's own
 * existing 2-step design for the underlying action (this hands over the
 * note and banks the discount; the very next RESOLVE_STRATEGY_SECONDARY
 * this player submits — phases/strategyCardAbilities.ts's own
 * resolveStrategySecondaryEffect — checks GameState.mindsieveFreeSecondaryPlayerId
 * as a 3rd exemption alongside Leadership/Masters of Trade, and clears
 * it). RR 83.4's own eligibility checks (not your own card, chosen by
 * someone, once per round) still apply at THAT later call — this step
 * only handles the note transfer + banking, never bypasses them.
 */
export function useMindsieve(
  state: GameState,
  action: { type: "USE_MINDSIEVE"; playerId: PlayerId; strategyCardOwnerId: PlayerId; promissoryNoteId: string },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player || player.factionId !== ("naalu" as never) || !player.hasBreakthrough) {
    return { ok: false, error: "This player doesn't have Mindsieve." };
  }
  if (!player.promissoryNotesInHand.includes(action.promissoryNoteId as never)) {
    return { ok: false, error: "This player doesn't have that promissory note in hand." };
  }
  const owner = state.players[action.strategyCardOwnerId];
  if (!owner) return { ok: false, error: "Unknown strategy card owner." };
  if (owner.id === action.playerId) return { ok: false, error: "Mindsieve: cannot be used on this player's own strategy card." };

  const updatedPlayer: Player = { ...player, promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== (action.promissoryNoteId as never)) };
  const updatedOwner: Player = { ...owner, promissoryNotesInHand: [...owner.promissoryNotesInHand, action.promissoryNoteId as never] };
  return {
    ok: true,
    state: {
      ...state,
      players: { ...state.players, [action.playerId]: updatedPlayer, [action.strategyCardOwnerId]: updatedOwner },
      mindsieveFreeSecondaryPlayerId: action.playerId,
    },
    events: [],
  };
}

/**
 * Naalu Collective "FORESIGHT" (faction ability): "After another player
 * moves ships into a system that contains 1 or more of your ships, you
 * may place 1 token from your strategy pool in an adjacent system that
 * does not contain another player's ships; move your ships from the
 * active system into that system." Confirmed (tirules2.com/F_naalu):
 * "this is not the active player's own turn"; "capacity and fleet pool
 * limits apply in the destination system after moving"; "if the Naalu
 * player uses Foresight to move out of a gravity rift, they roll for
 * removal — even if every ship is removed, the strategy token is still
 * placed"; "after resolving Foresight, play continues to the Space
 * Cannon Offense step, and only the active player's ships in the active
 * system may be assigned hits" (i.e. Naalu's own units, having left, are
 * no longer valid targets there) — this project's own tacticalAction.ts
 * (SPACE_CANNON_OFFENSE step) already only ever assigns hits against
 * units still actually present, so that half is automatic. The units
 * list is exactly what moves — this project's own engine trusts the
 * caller's own selection (same shape as PRODUCE_UNITS's own units list)
 * rather than forcing the whole stack.
 */
export function useForesight(
  state: GameState,
  action: {
    type: "USE_FORESIGHT";
    playerId: PlayerId;
    activeSystemId: SystemId;
    destinationSystemId: SystemId;
    units: { unitType: UnitType; count: number }[];
  },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player || !hasAbility(player, asAbilityId("foresight"))) return { ok: false, error: "This player doesn't have Foresight." };
  if (player.commandTokens.strategy <= 0) return { ok: false, error: "No command token in this player's strategy pool." };
  if (!isAdjacent(state, action.activeSystemId, action.destinationSystemId, rules)) {
    return { ok: false, error: "Foresight: the destination system must be adjacent to the active system." };
  }
  const destinationSystem = state.systems[action.destinationSystemId];
  if (!destinationSystem) return { ok: false, error: "Unknown destination system." };
  const destinationHasOtherPlayersShips = Object.entries(destinationSystem.spaceUnitsByPlayer).some(([pid, stacks]) => pid !== action.playerId && (stacks ?? []).some((s) => s.count > 0));
  if (destinationHasOtherPlayersShips) {
    return { ok: false, error: "Foresight: the destination system cannot contain another player's ships." };
  }
  const activeSystem = state.systems[action.activeSystemId];
  if (!activeSystem) return { ok: false, error: "Unknown active system." };
  const ownStacks = activeSystem.spaceUnitsByPlayer[action.playerId] ?? [];
  for (const move of action.units) {
    const available = ownStacks.filter((s) => s.unitType === move.unitType).reduce((sum, s) => sum + s.count, 0);
    if (available < move.count) return { ok: false, error: `Foresight: not enough ${move.unitType} in the active system to move.` };
  }

  let remainingStacks = ownStacks.map((s) => ({ ...s }));
  const destinationStacks = [...(destinationSystem.spaceUnitsByPlayer[action.playerId] ?? [])];
  for (const move of action.units) {
    let toMove = move.count;
    remainingStacks = remainingStacks.map((s) => {
      if (s.unitType !== move.unitType || toMove <= 0) return s;
      const taken = Math.min(s.count, toMove);
      toMove -= taken;
      return { ...s, count: s.count - taken, damagedCount: Math.min(s.damagedCount, s.count - taken) };
    });
    const existingDest = destinationStacks.find((s) => s.unitType === move.unitType);
    if (existingDest) {
      existingDest.count += move.count;
    } else {
      destinationStacks.push({ unitType: move.unitType, count: move.count, damagedCount: 0 });
    }
  }
  remainingStacks = remainingStacks.filter((s) => s.count > 0);

  const systems: GameState["systems"] = {
    ...state.systems,
    [action.activeSystemId]: { ...activeSystem, spaceUnitsByPlayer: { ...activeSystem.spaceUnitsByPlayer, [action.playerId]: remainingStacks } },
    [action.destinationSystemId]: { ...destinationSystem, spaceUnitsByPlayer: { ...destinationSystem.spaceUnitsByPlayer, [action.playerId]: destinationStacks } },
  };

  const updatedPlayer: Player = { ...player, commandTokens: { ...player.commandTokens, strategy: player.commandTokens.strategy - 1 } };
  return {
    ok: true,
    state: { ...state, systems, players: { ...state.players, [action.playerId]: updatedPlayer } },
    events: [],
  };
}

/**
 * Naalu Collective "Iconoclast — ΩΩ" (mech, Thunder's Edge Deploy):
 * "When another player gains a relic, place 1 mech on any planet you
 * control." Called from every genuine "a player gains a fresh relic"
 * site (phases/exploration.ts's own Dead World draw and relic-fragment
 * purge, phases/directiveEffects.ts's own Minister of Antiques,
 * phases/invasion.ts's own first-ever-control-of-a-relic-icon-planet,
 * and rules/relics.ts's own transferRelicAndVp for the 3 VP-carrying
 * relics changing hands via combat) — never for Naalu's OWN gains
 * ("another player", not this player). "Any planet you control" is a
 * genuine player choice this project doesn't yet have a dedicated
 * pending-choice action for (no RESOLVE_ICONOCLAST_DEPLOY_PLACEMENT
 * exists in Actions.ts) — deterministically picks this player's first
 * controlled planet (stable iteration order) instead, same simplification
 * called out on GameState.ts's own doc comment for this function. A
 * no-op if this player controls no planets at all (mirrors Arborec
 * MITOSIS's own "unless the Arborec player controls no planets" guard).
 */
export function applyIconoclastOmegaOmegaDeploy(state: GameState, gainingPlayerId: PlayerId): GameState {
  if (!hasThundersEdge(state.mode)) return state; // Iconoclast's Deploy trigger only exists on the ΩΩ (Thunder's Edge) version — base/Ω versions have different abilities entirely (see data/factions/naalu.json's own mech.versions), same mode-gated-not-researched shape as combat.ts's own Iconoclast relic-bonus/barrage-immunity checks.
  const naaluId = findNaaluPlayerId(state);
  if (!naaluId || naaluId === gainingPlayerId) return state;

  for (const [systemId, system] of Object.entries(state.systems)) {
    for (const planet of system.planets) {
      if (planet.controllerId !== naaluId) continue;
      const updatedPlanet = addPlanetUnits(planet, naaluId, "mech", 1);
      const updatedSystem = { ...system, planets: system.planets.map((p) => (p.planetId === planet.planetId ? updatedPlanet : p)) };
      return { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
    }
  }
  return state;
}
