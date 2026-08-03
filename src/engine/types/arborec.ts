import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId } from "../types/ids";
import { RuleData, getUnitStats } from "../types/RuleData";
import { UnitType, SHIP_TYPES, GROUND_FORCE_TYPES } from "../types/enums";
import { checkReinforcementsAvailable } from "./reinforcements";
import { spendForCost } from "../phases/technology";
import { getAdjacentSystems } from "./adjacency";

/**
 * Arborec "MITOSIS" (faction ability): the pending-choice half — "place
 * 1 infantry from your reinforcements on any planet you control."
 * Confirmed (yjmrobert.com/tirules/factions/f_arborec): "placing the
 * infantry during the status phase is mandatory (unless the Arborec
 * player controls no planets)" — queued by phases/actionPhase.ts's own
 * runStatusPhaseBookkeeping (GameState.pendingMitosisPlacements),
 * resolved here.
 *
 * "Letani Behemoth" (mech, Deploy): "When you would use your MITOSIS
 * faction ability you may replace 1 of your infantry with 1 mech from
 * your reinforcements instead." — the player's own choice, via
 * useDeployMech below.
 */
export function resolveMitosisPlacement(
  state: GameState,
  action: { type: "RESOLVE_MITOSIS_PLACEMENT"; playerId: PlayerId; targetPlanetId: PlanetId; useDeployMech?: boolean },
): ActionResult {
  const pending = state.pendingMitosisPlacements ?? [];
  if (!pending.includes(action.playerId)) {
    return { ok: false, error: "This player has no pending MITOSIS placement." };
  }
  let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === action.targetPlanetId);
    if (planet) {
      found = { systemId: systemId as SystemId, system, planet };
      break;
    }
  }
  if (!found || found.planet.controllerId !== action.playerId) {
    return { ok: false, error: "This player doesn't control that planet." };
  }
  const placedUnitType = action.useDeployMech ? "mech" : "infantry";
  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: placedUnitType, count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const stacks = found.planet.unitsByPlayer[action.playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === placedUnitType);
  const updatedStacks = existing ? stacks.map((s) => (s.unitType === placedUnitType ? { ...s, count: s.count + 1 } : s)) : [...stacks, { unitType: placedUnitType, count: 1, damagedCount: 0 }];
  const updatedPlanet: PlanetState = { ...found.planet, unitsByPlayer: { ...found.planet.unitsByPlayer, [action.playerId]: updatedStacks } };
  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)) };

  const remainingPending = pending.filter((id) => id !== action.playerId);
  return {
    ok: true,
    state: {
      ...state,
      systems: { ...state.systems, [found.systemId]: updatedSystem },
      pendingMitosisPlacements: remainingPending.length > 0 ? remainingPending : undefined,
    },
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: found.systemId, planetId: action.targetPlanetId, unitType: placedUnitType, count: 1, totalCost: 0 }],
  };
}

function findArborecPlayerId(state: GameState): PlayerId | undefined {
  return Object.values(state.players).find((p) => p.factionId === ("arborec" as never))?.id;
}

/**
 * Arborec "Stymie" (promissory note, original): "ACTION: Place this
 * card face up in your play area. While this card is in your play
 * area, the Arborec player cannot produce units in or adjacent to
 * non-home systems that contain 1 or more of your units. If you
 * activate a system that contains 1 or more of the Arborec player's
 * units, return this card to the Arborec player." Confirmed
 * (yjmrobert.com/tirules/factions/f_arborec):
 *  - No effect while in hand.
 *  - Returned on activation even with no hostile intent, and even for a
 *    structures-only system (same shape as Hacan's own Trade Convoys —
 *    rules/hacan.ts's own maybeReturnTradeConvoys).
 *  - NOT returned by a non-tactical-action command placement (e.g.
 *    Diplomacy's own primary).
 */
export function useStymie(state: GameState, action: { type: "USE_STYMIE"; playerId: PlayerId } ): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("stymie" as never)) {
    return { ok: false, error: "This player doesn't have Stymie in hand." };
  }
  const updatedPlayer: Player = {
    ...player,
    promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("stymie" as never)),
    promissoryNotesInPlayArea: [...player.promissoryNotesInPlayArea, "stymie" as never],
  };
  return { ok: true, state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } }, events: [] };
}

/**
 * The return half of Stymie — called from phases/tacticalAction.ts's own
 * activateSystem, same hook point as Hacan's own maybeReturnTradeConvoys.
 */
export function maybeReturnStymie(state: GameState, activatingPlayerId: PlayerId, activatedSystemHasArborecUnits: boolean): GameState {
  if (!activatedSystemHasArborecUnits) return state;
  const arborecPlayerId = findArborecPlayerId(state);
  if (!arborecPlayerId || activatingPlayerId === arborecPlayerId) return state;

  let players = state.players;
  for (const [holderId, holder] of Object.entries(players)) {
    if (!holder.promissoryNotesInPlayArea.includes("stymie" as never)) continue;
    const arborecPlayer = players[arborecPlayerId];
    players = {
      ...players,
      [holderId]: { ...holder, promissoryNotesInPlayArea: holder.promissoryNotesInPlayArea.filter((id) => id !== ("stymie" as never)) },
      [arborecPlayerId]: { ...arborecPlayer, promissoryNotesInHand: [...arborecPlayer.promissoryNotesInHand, "stymie" as never] },
    };
  }
  return { ...state, players };
}

/**
 * Arborec "Stymie Ω" (promissory note, Codex version): "After another
 * player moves ships into a system that contains 1 or more of your
 * units: You may place 1 command token from that player's
 * reinforcements in any non-home system. Then, return this card to the
 * Arborec player." Confirmed (yjmrobert.com/tirules/factions/f_arborec):
 *  - If the target player has 0 command tokens in their reinforcements,
 *    they place ONE FROM THEIR OWN COMMAND SHEET instead (any pool of
 *    their own choosing) — the effect still happens, just sourced
 *    differently.
 *  - Cannot target the home system of an ELIMINATED player.
 */
export function useStymieOmega(
  state: GameState,
  action: { type: "USE_STYMIE_OMEGA"; playerId: PlayerId; targetPlayerId: PlayerId; targetSystemId: SystemId; commandTokenPool?: "tactic" | "fleet" | "strategy" },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("stymie_omega" as never)) {
    return { ok: false, error: "This player doesn't have Stymie Ω in hand." };
  }
  const arborecPlayerId = findArborecPlayerId(state);
  if (!arborecPlayerId) return { ok: false, error: "No Arborec player in this game." };

  const target = state.players[action.targetPlayerId];
  if (!target) return { ok: false, error: "Unknown target player." };
  const targetHomeSystemId = rules.homeSystemByFaction[target.factionId];
  if (action.targetSystemId === targetHomeSystemId) return { ok: false, error: "Stymie Ω cannot target a home system." };
  const eliminatedHomeSystemIds = Object.values(state.players)
    .filter((p) => p.eliminated)
    .map((p) => rules.homeSystemByFaction[p.factionId]);
  if (eliminatedHomeSystemIds.includes(action.targetSystemId)) {
    return { ok: false, error: "Stymie Ω cannot place a command token in the home system of an eliminated player." };
  }

  const { tactic, fleet, strategy, onBoard } = target.commandTokens;
  if (onBoard.includes(action.targetSystemId)) {
    return { ok: false, error: "That player already has a command token in that system." };
  }
  let updatedTarget: Player;
  if (tactic + fleet + strategy > 0) {
    // From reinforcements — RR "command token" default source when available.
    const pool: "tactic" | "fleet" | "strategy" = tactic > 0 ? "tactic" : fleet > 0 ? "fleet" : "strategy";
    updatedTarget = { ...target, commandTokens: { ...target.commandTokens, [pool]: target.commandTokens[pool] - 1, onBoard: [...onBoard, action.targetSystemId] } };
  } else {
    // "If a player has no command tokens in their reinforcements, that player places one command token of their choice from their command sheet" — the TARGET's own choice of which pool to draw from, supplied by the caster on their behalf via commandTokenPool (this project's own convention elsewhere for "the affected player's choice, supplied by whoever submits the action").
    const pool = action.commandTokenPool ?? "tactic";
    if (target.commandTokens[pool] <= 0) return { ok: false, error: `That player has no tokens in their ${pool} pool to move.` };
    updatedTarget = { ...target, commandTokens: { ...target.commandTokens, [pool]: target.commandTokens[pool] - 1, onBoard: [...onBoard, action.targetSystemId] } };
  }

  const arborecPlayer = state.players[arborecPlayerId];
  const updatedPlayer: Player = { ...player, promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("stymie_omega" as never)) };
  const updatedArborecPlayer: Player = { ...arborecPlayer, promissoryNotesInHand: [...arborecPlayer.promissoryNotesInHand, "stymie_omega" as never] };

  return {
    ok: true,
    state: {
      ...state,
      players: { ...state.players, [action.playerId]: updatedPlayer, [action.targetPlayerId]: updatedTarget, [arborecPlayerId]: updatedArborecPlayer },
    },
    events: [],
  };
}

/**
 * Arborec "Duha Menaimon" (flagship): "After you activate this system,
 * you may produce up to 5 units in this system." Confirmed
 * (yjmrobert.com/tirules/factions/f_arborec):
 *  - Units must be paid for (no discount source applies below, since
 *    this deliberately bypasses executeProduction's own Sarween Tools/
 *    War Machine/AI Development Algorithm checks entirely).
 *  - Does NOT have the "Production" ability itself — Sarween Tools and
 *    similar effects do not apply (achieved simply by never invoking
 *    executeProduction's own Production-ability-gated cost logic here).
 *  - Must have been present in the system AT ACTIVATION, not just now
 *    — checked via pendingTacticalAction's own duhaMenaimonPresentAtActivation.
 *  - A ship may be produced only if no OTHER player currently has ships
 *    in this system (same "uncontested system" restriction as Dirzuga
 *    Rophal/Letani Miasmiala below).
 */
export function useDuhaMenaimonProduction(
  state: GameState,
  action: { type: "USE_DUHA_MENAIMON_PRODUCTION"; playerId: PlayerId; units: { unitType: UnitType; count: number }[]; exhaustPlanetIdsForResources: PlanetId[]; groundForceTargetPlanetId?: PlanetId },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) return { ok: false, error: "No tactical action in progress for this player." };
  if (!pending.duhaMenaimonPresentAtActivation) {
    return { ok: false, error: "Duha Menaimon: must have been present in this system when it was activated." };
  }
  const player = state.players[action.playerId];
  const systemId = pending.systemId;
  const system = state.systems[systemId];

  const totalRequested = action.units.reduce((sum, u) => sum + u.count, 0);
  if (totalRequested <= 0) return { ok: false, error: "No units specified." };
  if (totalRequested > 5) return { ok: false, error: "Duha Menaimon: can produce at most 5 units total." };

  const hasEnemyShips = Object.entries(system.spaceUnitsByPlayer).some(([pid, stacks]) => pid !== action.playerId && (stacks ?? []).some((s) => s.count > 0));
  const wantsShips = action.units.some((u) => u.count > 0 && SHIP_TYPES.includes(u.unitType));
  if (wantsShips && hasEnemyShips) {
    return { ok: false, error: "Duha Menaimon: a ship may only be produced here if no other player currently has ships in this system." };
  }

  let totalCost = 0;
  const resolvedUnits: { unitType: UnitType; count: number }[] = [];
  for (const { unitType, count } of action.units) {
    if (count <= 0) continue;
    const stats = getUnitStats(rules, player.factionId, unitType, player.unitUpgrades);
    if (!stats) return { ok: false, error: `No stats for ${unitType}.` };
    if (stats.cost == null) return { ok: false, error: `RR 26.3: ${unitType} has no cost and cannot be produced this way.` };
    const perToken = stats.producesQuantity ?? 1;
    if (count % perToken !== 0) return { ok: false, error: `${unitType} is produced ${perToken} at a time.` };
    totalCost += (count / perToken) * stats.cost;
    resolvedUnits.push({ unitType, count });
  }

  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, resolvedUnits);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  // No Sarween Tools/War Machine/AI Development Algorithm discount applies — Duha Menaimon doesn't actually have the Production ability, so none of those "reduce Production's own cost" effects have anything to attach to here.
  const spend = spendForCost(state, action.playerId, totalCost, action.exhaustPlanetIdsForResources, rules);
  if (!spend.ok) return spend;

  let nextState = spend.state;
  const events: GameEvent[] = [];
  let updatedSpaceStacks = (nextState.systems[systemId]?.spaceUnitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
  let groundForceTargetPlanet: PlanetState | undefined;
  if (action.groundForceTargetPlanetId) {
    groundForceTargetPlanet = nextState.systems[systemId]?.planets.find((p) => p.planetId === action.groundForceTargetPlanetId);
    if (!groundForceTargetPlanet || groundForceTargetPlanet.controllerId !== action.playerId) {
      return { ok: false, error: "This player doesn't control that planet in this system." };
    }
  }
  for (const { unitType, count } of resolvedUnits) {
    const isGroundForce = GROUND_FORCE_TYPES.includes(unitType);
    if (isGroundForce && groundForceTargetPlanet) {
      const stacks = groundForceTargetPlanet.unitsByPlayer[action.playerId] ?? [];
      const existing = stacks.find((s) => s.unitType === unitType);
      const updatedStacks = existing ? stacks.map((s) => (s.unitType === unitType ? { ...s, count: s.count + count } : s)) : [...stacks, { unitType, count, damagedCount: 0 }];
      groundForceTargetPlanet = { ...groundForceTargetPlanet, unitsByPlayer: { ...groundForceTargetPlanet.unitsByPlayer, [action.playerId]: updatedStacks } };
    } else {
      const existing = updatedSpaceStacks.find((s) => s.unitType === unitType);
      if (existing) existing.count += count;
      else updatedSpaceStacks.push({ unitType, count, damagedCount: 0 });
    }
    events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId, unitType, count, totalCost: 0 });
  }
  const systemAfterSpace = { ...nextState.systems[systemId], spaceUnitsByPlayer: { ...nextState.systems[systemId].spaceUnitsByPlayer, [action.playerId]: updatedSpaceStacks } };
  const updatedSystem: SystemState = groundForceTargetPlanet
    ? { ...systemAfterSpace, planets: systemAfterSpace.planets.map((p) => (p.planetId === groundForceTargetPlanet!.planetId ? groundForceTargetPlanet! : p)) }
    : systemAfterSpace;
  nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: updatedSystem } };

  return { ok: true, state: nextState, events };
}

/**
 * Arborec "Bioplasmosis" (faction tech): "At the end of the status
 * phase, you may remove any number of infantry from planets you
 * control and place them on 1 or more planets you control in the same
 * or adjacent systems." Confirmed (yjmrobert.com/tirules/factions/f_arborec):
 *  - "Any number of infantry may move, but all movement is done
 *    SIMULTANEOUSLY, and no infantry may move beyond an adjacent
 *    system" — e.g. for systems A-B-C (only directly-adjacent pairs
 *    connected): 1 infantry CANNOT move A→B→C in the same resolution
 *    (that's 2 hops for 1 unit), but 1 infantry moving A→B while a
 *    DIFFERENT infantry moves B→C is fine (2 separate 1-hop moves,
 *    simultaneous). Modeled here as a list of individual MOVES (not
 *    Transit Diodes' own simpler "removals list + placements list with
 *    matching totals" shape, since THAT doesn't tie a specific removal
 *    to a specific destination) — each move's own destination must be
 *    the SAME system as its own origin, or directly adjacent to it,
 *    checked per-move independently.
 *  - Cannot move Letani Behemoth (mechs) — infantry only, unlike
 *    Transit Diodes' own "infantry" | "mech" flexibility.
 */
export function useBioplasmosis(
  state: GameState,
  action: { type: "USE_BIOPLASMOSIS"; playerId: PlayerId; moves: { fromPlanetId: PlanetId; toPlanetId: PlanetId; count: number }[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.technologies.includes("bioplasmosis" as never)) {
    return { ok: false, error: "This player doesn't have Bioplasmosis." };
  }

  const findPlanetIn = (s: GameState, planetId: PlanetId): { systemId: SystemId; system: SystemState; planet: PlanetState } | null => {
    for (const [systemId, system] of Object.entries(s.systems)) {
      const planet = system.planets.find((p) => p.planetId === planetId);
      if (planet) return { systemId: systemId as SystemId, system, planet };
    }
    return null;
  };

  // Confirmed (yjmrobert.com/tirules/factions/f_arborec): "all movement
  // is done SIMULTANEOUSLY" — validated here against the ORIGINAL,
  // pre-batch state for every single move (not the state as it stands
  // after EARLIER moves in this same batch), so an infantry that JUST
  // arrived somewhere via one move in this batch can never be the
  // source for ANOTHER move in the same batch (that would be a
  // forbidden 2-hop chain across 2 separate move entries, exactly
  // ruling #1's own "cannot move from A to B, then B to C" example).
  const removedSoFarByPlanet = new Map<PlanetId, number>();
  for (const { fromPlanetId, toPlanetId, count } of action.moves) {
    if (count <= 0) continue;
    const fromFound = findPlanetIn(state, fromPlanetId);
    const toFound = findPlanetIn(state, toPlanetId);
    if (!fromFound || fromFound.planet.controllerId !== action.playerId) return { ok: false, error: `This player doesn't control ${fromPlanetId}.` };
    if (!toFound || toFound.planet.controllerId !== action.playerId) return { ok: false, error: `This player doesn't control ${toPlanetId}.` };
    if (fromFound.systemId !== toFound.systemId && !getAdjacentSystems(state, fromFound.systemId, rules).includes(toFound.systemId)) {
      return { ok: false, error: `Bioplasmosis: ${toPlanetId}'s system isn't the same as (or adjacent to) ${fromPlanetId}'s.` };
    }
    const originalInfantryCount = (fromFound.planet.unitsByPlayer[action.playerId] ?? []).find((s) => s.unitType === "infantry")?.count ?? 0;
    const alreadyCommitted = removedSoFarByPlanet.get(fromPlanetId) ?? 0;
    if (alreadyCommitted + count > originalInfantryCount) {
      return { ok: false, error: `Not enough infantry originally on ${fromPlanetId} to cover all moves sourcing from it (had ${originalInfantryCount}).` };
    }
    removedSoFarByPlanet.set(fromPlanetId, alreadyCommitted + count);
  }

  // Now apply: all removals first (against the snapshot above), then all additions — this ordering itself doesn't matter for correctness anymore, since the VALIDATION above already used the frozen pre-batch counts; this is purely mechanical bookkeeping now.
  let nextState: GameState = state;
  for (const [planetId, totalRemoved] of removedSoFarByPlanet.entries()) {
    const found = findPlanetIn(nextState, planetId)!;
    const stacks = found.planet.unitsByPlayer[action.playerId] ?? [];
    const infantryStack = stacks.find((s) => s.unitType === "infantry")!;
    const updatedStacks = stacks.map((s) => (s === infantryStack ? { ...s, count: s.count - totalRemoved } : s)).filter((s) => s.count > 0);
    const updatedPlanet: PlanetState = { ...found.planet, unitsByPlayer: { ...found.planet.unitsByPlayer, [action.playerId]: updatedStacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } } };
  }

  const events: GameEvent[] = [];
  for (const { toPlanetId, count } of action.moves) {
    if (count <= 0) continue;
    const found = findPlanetIn(nextState, toPlanetId)!;
    const stacks = found.planet.unitsByPlayer[action.playerId] ?? [];
    const existing = stacks.find((s) => s.unitType === "infantry");
    const updatedStacks = existing ? stacks.map((s) => (s.unitType === "infantry" ? { ...s, count: s.count + count } : s)) : [...stacks, { unitType: "infantry" as const, count, damagedCount: 0 }];
    const updatedPlanet: PlanetState = { ...found.planet, unitsByPlayer: { ...found.planet.unitsByPlayer, [action.playerId]: updatedStacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === toPlanetId ? updatedPlanet : p)) } } };
    events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: found.systemId, planetId: toPlanetId, unitType: "infantry", count, totalCost: 0 });
  }

  return { ok: true, state: nextState, events };
}

/**
 * Arborec "Letani Ospha" (agent): "ACTION: Exhaust this card and choose
 * a player's non-fighter ship; that player may replace that ship with
 * one from their reinforcements that costs up to 2 more than the
 * replaced ship." Confirmed (yjmrobert.com/tirules/factions/f_arborec):
 *  - The replaced ship is NOT destroyed (no downstream "destroyed"
 *    consequences); the replacing ship is NOT "produced" (Sarween
 *    Tools and similar cost-reduction effects don't apply — achieved
 *    simply by never invoking any cost-payment logic here at all, this
 *    is a pure swap).
 *  - If there are none of the replacement type left in reinforcements,
 *    the target may substitute one from any OTHER system that doesn't
 *    contain their own command token (same "steal from elsewhere"
 *    fallback as Freelancers/Dirzuga Rophal/Letani Miasmiala), placed
 *    undamaged.
 *  - A fighter MAY be the replacement (even though the ORIGINAL,
 *    replaced ship must be non-fighter).
 *  - This is the AGENT-BENEFITS-ANOTHER-PLAYER pattern (same as this
 *    project's own fixed Evelyn DeLouis/Viscount Unlenn) — ownerId
 *    (whoever holds Letani Ospha) is separate from targetPlayerId
 *    (whose ship actually gets replaced).
 */
export function useLetaniOspha(
  state: GameState,
  action: {
    type: "USE_LETANI_OSPHA";
    ownerId: PlayerId;
    targetPlayerId: PlayerId;
    systemId: SystemId;
    replacedUnitType: UnitType;
    newUnitType: UnitType;
    substituteSourceSystemId?: SystemId;
  },
  rules: RuleData,
): ActionResult {
  const owner = state.players[action.ownerId];
  const agentEntry = owner.leaders.find((l) => l.leaderId === ("arborec_agent" as never));
  if (!agentEntry) return { ok: false, error: "This player doesn't have Letani Ospha." };
  if (agentEntry.exhausted) return { ok: false, error: "Letani Ospha is already exhausted." };
  if (action.replacedUnitType === "fighter") return { ok: false, error: "Letani Ospha: the chosen ship must be non-fighter." };

  const target = state.players[action.targetPlayerId];
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  const stacks = system.spaceUnitsByPlayer[action.targetPlayerId] ?? [];
  const replacedStack = stacks.find((s) => s.unitType === action.replacedUnitType && s.count > 0);
  if (!replacedStack) return { ok: false, error: `That player has no ${action.replacedUnitType} in that system.` };

  const replacedStats = getUnitStats(rules, target.factionId, action.replacedUnitType, target.unitUpgrades);
  const newStats = getUnitStats(rules, target.factionId, action.newUnitType, target.unitUpgrades);
  if (!replacedStats || !newStats) return { ok: false, error: "Unknown unit stats." };
  if ((newStats.cost ?? 0) > (replacedStats.cost ?? 0) + 2) {
    return { ok: false, error: `Letani Ospha: the replacement can cost at most 2 more than ${action.replacedUnitType} (${(replacedStats.cost ?? 0) + 2}).` };
  }

  // Remove the replaced ship (not "destroyed" — just removed, no further consequence).
  const stacksAfterRemoval = stacks.map((s) => (s === replacedStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  let nextState: GameState = { ...state, systems: { ...state.systems, [action.systemId]: { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.targetPlayerId]: stacksAfterRemoval } } } };

  const reinforcementsCheck = checkReinforcementsAvailable(nextState, action.targetPlayerId, [{ unitType: action.newUnitType, count: 1 }]);
  if (!reinforcementsCheck.ok) {
    if (!action.substituteSourceSystemId) return reinforcementsCheck;
    const substituteSystem = nextState.systems[action.substituteSourceSystemId];
    if (!substituteSystem) return { ok: false, error: `No system ${action.substituteSourceSystemId}.` };
    if (target.commandTokens.onBoard.includes(action.substituteSourceSystemId)) {
      return { ok: false, error: "Letani Ospha: the substitute system cannot contain this player's own command token." };
    }
    const substituteStacks = substituteSystem.spaceUnitsByPlayer[action.targetPlayerId] ?? [];
    const substituteStack = substituteStacks.find((s) => s.unitType === action.newUnitType && s.count > 0);
    if (!substituteStack) return { ok: false, error: `No ${action.newUnitType} of this player's own in ${action.substituteSourceSystemId} to relocate.` };
    const updatedSubstituteStacks = substituteStacks.map((s) => (s === substituteStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
    nextState = { ...nextState, systems: { ...nextState.systems, [action.substituteSourceSystemId]: { ...substituteSystem, spaceUnitsByPlayer: { ...substituteSystem.spaceUnitsByPlayer, [action.targetPlayerId]: updatedSubstituteStacks } } } };
  }

  const destSystem = nextState.systems[action.systemId];
  const destStacks = destSystem.spaceUnitsByPlayer[action.targetPlayerId] ?? [];
  const existing = destStacks.find((s) => s.unitType === action.newUnitType);
  const updatedDestStacks = existing ? destStacks.map((s) => (s.unitType === action.newUnitType ? { ...s, count: s.count + 1 } : s)) : [...destStacks, { unitType: action.newUnitType, count: 1, damagedCount: 0 }];
  nextState = {
    ...nextState,
    systems: { ...nextState.systems, [action.systemId]: { ...destSystem, spaceUnitsByPlayer: { ...destSystem.spaceUnitsByPlayer, [action.targetPlayerId]: updatedDestStacks } } },
    players: { ...nextState.players, [action.ownerId]: { ...owner, leaders: owner.leaders.map((l) => (l.leaderId === ("arborec_agent" as never) ? { ...l, exhausted: true } : l)) } },
  };

  return { ok: true, state: nextState, events: [{ type: "UNITS_PRODUCED", playerId: action.targetPlayerId, systemId: action.systemId, unitType: action.newUnitType, count: 1, totalCost: 0 }] };
}

/**
 * Shared production-without-Production-ability logic for Arborec's own
 * Dirzuga Rophal (commander) and Letani Miasmiala (hero) below — both
 * confirmed (yjmrobert.com/tirules/factions/f_arborec) to: require full
 * payment (no Sarween Tools/War Machine/AI Development Algorithm, since
 * no actual Production ability is ever invoked); only allow a ship if no
 * OTHER player currently has ships in that system; allow ground forces
 * on any controlled planet in the system OR the space area; and permit
 * the same "steal from elsewhere" reinforcements-substitute fallback as
 * Letani Ospha/Freelancers.
 */
function produceWithoutProductionAbility(
  state: GameState,
  playerId: PlayerId,
  systemId: SystemId,
  requestedUnits: { unitType: UnitType; count: number }[],
  exhaustPlanetIdsForResources: PlanetId[],
  rules: RuleData,
  groundForceTargetPlanetId?: PlanetId,
): ActionResult {
  const player = state.players[playerId];
  const system = state.systems[systemId];
  if (!system) return { ok: false, error: `No system ${systemId}.` };

  const hasEnemyShips = Object.entries(system.spaceUnitsByPlayer).some(([pid, stacks]) => pid !== playerId && (stacks ?? []).some((s) => s.count > 0));
  const wantsShips = requestedUnits.some((u) => u.count > 0 && SHIP_TYPES.includes(u.unitType));
  if (wantsShips && hasEnemyShips) {
    return { ok: false, error: "A ship may only be produced here if no other player currently has ships in this system." };
  }

  let totalCost = 0;
  const resolvedUnits: { unitType: UnitType; count: number }[] = [];
  for (const { unitType, count } of requestedUnits) {
    if (count <= 0) continue;
    const stats = getUnitStats(rules, player.factionId, unitType, player.unitUpgrades);
    if (!stats) return { ok: false, error: `No stats for ${unitType}.` };
    if (stats.cost == null) return { ok: false, error: `RR 26.3: ${unitType} has no cost and cannot be produced this way.` };
    const perToken = stats.producesQuantity ?? 1;
    if (count % perToken !== 0) return { ok: false, error: `${unitType} is produced ${perToken} at a time.` };
    totalCost += (count / perToken) * stats.cost;
    resolvedUnits.push({ unitType, count });
  }
  if (resolvedUnits.length === 0) return { ok: false, error: "No units specified." };

  const reinforcementsCheck = checkReinforcementsAvailable(state, playerId, resolvedUnits);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const spend = spendForCost(state, playerId, totalCost, exhaustPlanetIdsForResources, rules);
  if (!spend.ok) return spend;

  let nextState = spend.state;
  const events: GameEvent[] = [];
  let updatedSpaceStacks = (nextState.systems[systemId]?.spaceUnitsByPlayer[playerId] ?? []).map((s) => ({ ...s }));
  let groundForceTargetPlanet: PlanetState | undefined;
  if (groundForceTargetPlanetId) {
    groundForceTargetPlanet = nextState.systems[systemId]?.planets.find((p) => p.planetId === groundForceTargetPlanetId);
    if (!groundForceTargetPlanet || groundForceTargetPlanet.controllerId !== playerId) {
      return { ok: false, error: "This player doesn't control that planet in this system." };
    }
  }
  for (const { unitType, count } of resolvedUnits) {
    const isGroundForce = GROUND_FORCE_TYPES.includes(unitType);
    if (isGroundForce && groundForceTargetPlanet) {
      const stacks = groundForceTargetPlanet.unitsByPlayer[playerId] ?? [];
      const existing = stacks.find((s) => s.unitType === unitType);
      const updatedStacks = existing ? stacks.map((s) => (s.unitType === unitType ? { ...s, count: s.count + count } : s)) : [...stacks, { unitType, count, damagedCount: 0 }];
      groundForceTargetPlanet = { ...groundForceTargetPlanet, unitsByPlayer: { ...groundForceTargetPlanet.unitsByPlayer, [playerId]: updatedStacks } };
    } else {
      const existing = updatedSpaceStacks.find((s) => s.unitType === unitType);
      if (existing) existing.count += count;
      else updatedSpaceStacks.push({ unitType, count, damagedCount: 0 });
    }
    events.push({ type: "UNITS_PRODUCED", playerId, systemId, unitType, count, totalCost: 0 });
  }
  const systemAfterSpace = { ...nextState.systems[systemId], spaceUnitsByPlayer: { ...nextState.systems[systemId].spaceUnitsByPlayer, [playerId]: updatedSpaceStacks } };
  const updatedSystem: SystemState = groundForceTargetPlanet
    ? { ...systemAfterSpace, planets: systemAfterSpace.planets.map((p) => (p.planetId === groundForceTargetPlanet!.planetId ? groundForceTargetPlanet! : p)) }
    : systemAfterSpace;
  nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: updatedSystem } };

  return { ok: true, state: nextState, events };
}

/**
 * Arborec "Dirzuga Rophal" (commander): "After another player activates
 * a system that contains 1 or more of your units that have PRODUCTION:
 * You may produce 1 unit in that system." Unlock: "Have 12 Ground
 * Forces on planets you control." Confirmed
 * (yjmrobert.com/tirules/factions/f_arborec):
 *  - Produced BEFORE ships move.
 *  - Even if the ONLY Production-capable unit present is this player's
 *    own space dock, they may still produce an INFANTRY this way —
 *    Dirzuga Rophal's own ability isn't the space dock's own Production,
 *    so MITOSIS's own restriction doesn't apply to it (achieved simply
 *    by this function never checking MITOSIS at all, unlike
 *    executeProduction).
 */
export function useDirzugaRophal(
  state: GameState,
  action: { type: "USE_DIRZUGA_ROPHAL"; playerId: PlayerId; systemId: SystemId; unitType: UnitType; count: number; exhaustPlanetIdsForResources: PlanetId[]; groundForceTargetPlanetId?: PlanetId },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const commanderEntry = player.leaders.find((l) => l.leaderId === ("arborec_commander" as never));
  if (!commanderEntry || commanderEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Dirzuga Rophal." };

  const system = state.systems[action.systemId];
  const hasOwnProductionUnitHere = (system?.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0 && getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades)?.abilities.includes("production"));
  if (!hasOwnProductionUnitHere) return { ok: false, error: "This player has no Production-capable unit of their own in that system." };
  if (action.count > 1) return { ok: false, error: "Dirzuga Rophal: can produce at most 1 unit." };

  return produceWithoutProductionAbility(state, action.playerId, action.systemId, [{ unitType: action.unitType, count: action.count }], action.exhaustPlanetIdsForResources, rules, action.groundForceTargetPlanetId);
}

/**
 * Arborec "Letani Miasmiala — ULTRASONIC EMITTER" (hero, single-use):
 * "ACTION: Produce any number of units in any number of systems that
 * contain 1 or more of your ground forces. Then, purge this card."
 * Confirmed (yjmrobert.com/tirules/factions/f_arborec): same "must be
 * paid for, no Production ability used, ship only if uncontested,
 * flexible ground-force placement, steal-from-elsewhere fallback" shape
 * as Dirzuga Rophal above — resolved here across POTENTIALLY MULTIPLE
 * systems in one go.
 */
export function useLetaniMiasmiala(
  state: GameState,
  action: {
    type: "USE_LETANI_MIASMIALA";
    playerId: PlayerId;
    productions: { systemId: SystemId; units: { unitType: UnitType; count: number }[]; exhaustPlanetIdsForResources: PlanetId[]; groundForceTargetPlanetId?: PlanetId }[];
  },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player.leaders.find((l) => l.leaderId === ("arborec_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Letani Miasmiala." };

  let nextState: GameState = state;
  const events: GameEvent[] = [];
  for (const production of action.productions) {
    const system = nextState.systems[production.systemId];
    const hasOwnGroundForcesHere = (system?.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0 && GROUND_FORCE_TYPES.includes(s.unitType)) || (system?.planets ?? []).some((p) => (p.unitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0 && GROUND_FORCE_TYPES.includes(s.unitType)));
    if (!hasOwnGroundForcesHere) return { ok: false, error: `This player has no ground forces of their own in ${production.systemId}.` };

    const result = produceWithoutProductionAbility(nextState, action.playerId, production.systemId, production.units, production.exhaustPlanetIdsForResources, rules, production.groundForceTargetPlanetId);
    if (!result.ok) return result;
    nextState = result.state;
    events.push(...result.events);
  }

  const updatedPlayer: Player = { ...nextState.players[action.playerId], leaders: nextState.players[action.playerId].leaders.filter((l) => l.leaderId !== ("arborec_hero" as never)) };
  return { ok: true, state: { ...nextState, players: { ...nextState.players, [action.playerId]: updatedPlayer } }, events };
}

/**
 * Arborec "Psychospore" (Breakthrough ability): "ACTION: Exhaust this
 * card to remove a command token from a system that contains 1 or more
 * of your infantry and return it to your reinforcements. Then, place 1
 * infantry in that system." No additional confirmed rulings beyond the
 * printed text.
 */
export function usePsychospore(
  state: GameState,
  action: { type: "USE_PSYCHOSPORE"; playerId: PlayerId; targetSystemId: SystemId },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.hasBreakthrough || player.factionId !== ("arborec" as never)) {
    return { ok: false, error: "This player doesn't have Psychospore." };
  }
  if (player.breakthroughExhausted) return { ok: false, error: "Psychospore is already exhausted." };
  if (!player.commandTokens.onBoard.includes(action.targetSystemId)) {
    return { ok: false, error: "This player has no command token in that system." };
  }
  const system = state.systems[action.targetSystemId];
  const hasOwnInfantryHere = (system?.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "infantry" && s.count > 0) || (system?.planets ?? []).some((p) => (p.unitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "infantry" && s.count > 0));
  if (!hasOwnInfantryHere) return { ok: false, error: "This player has no infantry of their own in that system." };

  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: "infantry", count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const spaceStacks = system.spaceUnitsByPlayer[action.playerId] ?? [];
  const existing = spaceStacks.find((s) => s.unitType === "infantry");
  const updatedSpaceStacks = existing ? spaceStacks.map((s) => (s.unitType === "infantry" ? { ...s, count: s.count + 1 } : s)) : [...spaceStacks, { unitType: "infantry" as const, count: 1, damagedCount: 0 }];
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedSpaceStacks } };

  const updatedPlayer: Player = { ...player, commandTokens: { ...player.commandTokens, onBoard: player.commandTokens.onBoard.filter((id) => id !== action.targetSystemId) }, breakthroughExhausted: true };

  return {
    ok: true,
    state: { ...state, systems: { ...state.systems, [action.targetSystemId]: updatedSystem }, players: { ...state.players, [action.playerId]: updatedPlayer } },
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.targetSystemId, unitType: "infantry", count: 1, totalCost: 0 }],
  };
}
