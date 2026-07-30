import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, asAbilityId, asLeaderId } from "../types/ids";
import { RuleData, getUnitStats } from "../types/RuleData";
import { hasAbility } from "./abilities";
import { checkReinforcementsAvailable } from "./reinforcements";
import { unlockCommander, purgeHero } from "./leaders";

function findPlanet(state: GameState, planetId: PlanetId): { systemId: SystemId; system: SystemState; planet: PlanetState } | null {
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === planetId);
    if (planet) return { systemId: systemId as SystemId, system, planet };
  }
  return null;
}

function addPlanetUnits(planet: PlanetState, playerId: PlayerId, unitType: "infantry" | "mech", count: number): PlanetState {
  const stacks = planet.unitsByPlayer[playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === unitType);
  const updatedStacks = existing ? stacks.map((s) => (s.unitType === unitType ? { ...s, count: s.count + count } : s)) : [...stacks, { unitType, count, damagedCount: 0 }];
  return { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [playerId]: updatedStacks } };
}

/**
 * Sol "ORBITAL DROP" (faction ability): "ACTION: Spend 1 token from your
 * strategy pool to place 2 infantry from your reinforcements on 1 planet
 * you control." A generic component action, no other timing restriction.
 */
export function useOrbitalDrop(state: GameState, action: { type: "USE_ORBITAL_DROP"; playerId: PlayerId; targetPlanetId: PlanetId }): ActionResult {
  const player = state.players[action.playerId];
  if (!hasAbility(player, asAbilityId("orbital_drop"))) return { ok: false, error: "This player doesn't have ORBITAL DROP." };
  if (player.commandTokens.strategy <= 0) return { ok: false, error: "No command token in this player's strategy pool to spend." };

  const found = findPlanet(state, action.targetPlanetId);
  if (!found || found.planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };
  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: "infantry", count: 2 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const updatedPlayer: Player = { ...player, commandTokens: { ...player.commandTokens, strategy: player.commandTokens.strategy - 1 } };
  const updatedPlanet = addPlanetUnits(found.planet, action.playerId, "infantry", 2);
  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)) };

  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer }, systems: { ...state.systems, [found.systemId]: updatedSystem } },
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: found.systemId, planetId: action.targetPlanetId, unitType: "infantry", count: 2, totalCost: 0 }],
  };
}

/**
 * Sol "ZS Thunderbolt M2" (mech, DEPLOY): "After you use your ORBITAL
 * DROP faction ability, you may spend 3 resources to place 1 mech on
 * that planet." A player's own choice, immediately following (not
 * bundled into) USE_ORBITAL_DROP — the caller is expected to submit this
 * right after, targeting the SAME planet Orbital Drop just placed
 * infantry on. Not strictly enforced here that it's literally the very
 * next action (this project's own general timing simplification, same
 * category as other "immediately after X" Deploy abilities elsewhere).
 */
export function useZsThunderboltM2Deploy(
  state: GameState,
  action: { type: "USE_ZS_THUNDERBOLT_M2_DEPLOY"; playerId: PlayerId; targetPlanetId: PlanetId; exhaustPlanetIdsForResources: PlanetId[] },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const found = findPlanet(state, action.targetPlanetId);
  if (!found || found.planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };
  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: "mech", count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  let totalResources = 0;
  let systems = state.systems;
  for (const planetId of action.exhaustPlanetIdsForResources) {
    const f = findPlanet(state, planetId);
    if (!f || f.planet.controllerId !== action.playerId || f.planet.exhausted) return { ok: false, error: `Cannot exhaust ${planetId} for resources.` };
    totalResources += rules.planets[planetId]?.resources ?? 0;
    const updatedPlanet: PlanetState = { ...f.planet, exhausted: true };
    systems = { ...systems, [f.systemId]: { ...f.system, planets: f.system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } };
  }
  if (totalResources < 3) return { ok: false, error: "Not enough resources from the exhausted planets (need 3)." };

  const targetSystem = systems[found.systemId];
  const targetPlanet = targetSystem.planets.find((p) => p.planetId === action.targetPlanetId)!;
  const updatedPlanet = addPlanetUnits(targetPlanet, action.playerId, "mech", 1);
  systems = { ...systems, [found.systemId]: { ...targetSystem, planets: targetSystem.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)) } };

  return {
    ok: true,
    state: { ...state, systems },
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: found.systemId, planetId: action.targetPlanetId, unitType: "mech", count: 1, totalCost: 3 }],
  };
}

/**
 * Sol "Genesis" (flagship): "the Sol player might need to remove an
 * infantry or fighter to meet capacity limits" (confirmed,
 * yjmrobert.com/tirules/factions/f_sol) — the player's own choice of
 * WHICH unit type to remove, resolving the pending overflow set by the
 * mandatory Infantry Spawn placement (actionPhase.ts's own
 * runStatusPhaseBookkeeping).
 */
export function resolveGenesisCapacityOverflow(
  state: GameState,
  action: { type: "RESOLVE_GENESIS_CAPACITY_OVERFLOW"; playerId: PlayerId; systemId: SystemId; unitTypeToRemove: "infantry" | "fighter" },
): ActionResult {
  const pending = state.pendingGenesisCapacityOverflow ?? [];
  const entry = pending.find((p) => p.playerId === action.playerId && p.systemId === action.systemId);
  if (!entry) return { ok: false, error: "No pending Genesis capacity overflow for this player/system." };

  const system = state.systems[action.systemId];
  const stacks = system?.spaceUnitsByPlayer[action.playerId] ?? [];
  const stack = stacks.find((s) => s.unitType === action.unitTypeToRemove && s.count > 0);
  if (!stack) return { ok: false, error: `No ${action.unitTypeToRemove} to remove.` };

  const updatedStacks = stacks.map((s) => (s === stack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  const updatedSystem: SystemState = { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.playerId]: updatedStacks } };
  const nextState: GameState = {
    ...state,
    systems: { ...state.systems, [action.systemId]: updatedSystem },
    pendingGenesisCapacityOverflow: pending.filter((p) => p !== entry),
  };
  return { ok: true, state: nextState, events: [{ type: "UNITS_DESTROYED", playerId: action.playerId, systemId: action.systemId, unitType: action.unitTypeToRemove, count: 1 }] };
}

/**
 * Sol "Military Support" (promissory note): "At the start of the Sol
 * player's turn: Remove 1 token from the Sol player's strategy pool, if
 * able, and return it to their reinforcements. Then, you may place 2
 * infantry from your reinforcements on any planet you control. Then,
 * return this card to the Sol player." Confirmed rulings
 * (yjmrobert.com/tirules/factions/f_sol):
 *  - Playable BEFORE Sol may use Orbital Drop (no ordering enforcement
 *    needed here beyond that this doesn't require Sol to have not yet
 *    acted — it's the HOLDER's own reactive opportunity, independent).
 *  - Playable even the turn Sol passes.
 *  - Playable even with 0 tokens in Sol's strategy pool ("if able" — the
 *    token-removal step just doesn't happen then, everything else still
 *    does).
 *  - Cannot be played twice in the same "start of Sol's turn" window,
 *    even if the holder somehow regains it via a transaction with Sol in
 *    between (tracked via usedMilitarySupportForActivePlayerTurn below).
 */
export function useMilitarySupport(
  state: GameState,
  action: { type: "USE_MILITARY_SUPPORT"; playerId: PlayerId; placeInfantry?: { targetPlanetId: PlanetId; count: number } },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("military_support" as never)) {
    return { ok: false, error: "This player doesn't have Military Support in hand." };
  }
  const solPlayerId = Object.values(state.players).find((p) => p.factionId === ("sol" as never))?.id;
  if (!solPlayerId || state.activePlayerId !== solPlayerId) {
    return { ok: false, error: 'Military Support: only usable "at the start of the Sol player\'s turn".' };
  }
  if (state.usedMilitarySupportForActivePlayerTurn) {
    return { ok: false, error: "Military Support has already been played this turn." };
  }

  const solPlayer = state.players[solPlayerId];
  const updatedSolPlayer: Player = solPlayer.commandTokens.strategy > 0 ? { ...solPlayer, commandTokens: { ...solPlayer.commandTokens, strategy: solPlayer.commandTokens.strategy - 1 } } : solPlayer;

  let nextState: GameState = {
    ...state,
    usedMilitarySupportForActivePlayerTurn: true,
    players: {
      ...state.players,
      [solPlayerId]: { ...updatedSolPlayer, promissoryNotesInHand: [...updatedSolPlayer.promissoryNotesInHand, "military_support" as never] },
      [action.playerId]: { ...player, promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("military_support" as never)) },
    },
  };
  const events: GameEvent[] = [];

  if (action.placeInfantry) {
    if (action.placeInfantry.count > 2) return { ok: false, error: "Can place at most 2 infantry." };
    let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
    for (const [systemId, system] of Object.entries(nextState.systems)) {
      const planet = system.planets.find((p) => p.planetId === action.placeInfantry!.targetPlanetId);
      if (planet) {
        found = { systemId: systemId as SystemId, system, planet };
        break;
      }
    }
    if (!found || found.planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };
    const reinforcementsCheck = checkReinforcementsAvailable(nextState, action.playerId, [{ unitType: "infantry", count: action.placeInfantry.count }]);
    if (!reinforcementsCheck.ok) return reinforcementsCheck;
    const updatedPlanet = addPlanetUnits(found.planet, action.playerId, "infantry", action.placeInfantry.count);
    const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.placeInfantry!.targetPlanetId ? updatedPlanet : p)) };
    nextState = { ...nextState, systems: { ...nextState.systems, [found.systemId]: updatedSystem } };
    events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: found.systemId, planetId: action.placeInfantry.targetPlanetId, unitType: "infantry", count: action.placeInfantry.count, totalCost: 0 });
  }

  return { ok: true, state: nextState, events };
}

/**
 * Sol "Claire Gibson" (commander, PASSIVE — no exhaust/ready cycle at
 * all, unlike agents): "At the start of a ground combat on a planet you
 * control: you may place 1 infantry from your reinforcements on that
 * planet." Unlock: "control planets that have a combined total of at
 * least 12 resources." Confirmed rulings (yjmrobert.com/tirules/factions/f_sol):
 *  - Multiple planets under combat in the same invasion each get their
 *    OWN trigger (1 infantry each), not just once for the whole system.
 *  - Doesn't trigger at all if this player has no ground forces on that
 *    planet to begin with (no ground combat occurs there in the first
 *    place).
 *  - "Start of ground combat" is specifically the moment right before
 *    round 1 (after Space Cannon Defense/Magen Defense Grid have both
 *    resolved) — checked here via pending.combatRound being undefined,
 *    the same condition invasion.ts's own openGroundCombatRoundStartWindowIfNeeded
 *    uses for "has round 1 not been assigned a number yet". If every
 *    committed ground force was wiped out during Space Cannon Defense
 *    (ground combat skipped entirely on that planet), this never becomes
 *    true, so the ability correctly never triggers either.
 */
export function useClaireGibson(state: GameState, action: { type: "USE_CLAIRE_GIBSON"; playerId: PlayerId; targetPlanetId: PlanetId }, rules: RuleData): ActionResult {
  const player = state.players[action.playerId];
  const commanderEntry = player.leaders.find((l) => l.leaderId === ("claire_gibson" as never));
  if (!commanderEntry) return { ok: false, error: "This player doesn't have Claire Gibson." };

  // Sol "Claire Gibson" unlock: "control planets that have a combined total of at least 12 resources." Faction-specific (deferred by rules/leaders.ts's own generic plumbing) — checked here, auto-unlocking permanently the moment it's first met.
  let workingState = state;
  if (commanderEntry.locked) {
    const combinedResources = Object.values(state.systems)
      .flatMap((s) => s.planets)
      .filter((p) => p.controllerId === action.playerId)
      .reduce((sum, p) => sum + (rules.planets[p.planetId]?.resources ?? 0), 0);
    if (combinedResources < 12) return { ok: false, error: "This player doesn't have an unlocked Claire Gibson." };
    workingState = { ...state, players: { ...state.players, [action.playerId]: unlockCommander(player, asLeaderId("claire_gibson")) } };
  }

  const pending = workingState.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || pending.currentInvasionPlanetId !== action.targetPlanetId || pending.combatRound !== undefined) {
    return { ok: false, error: 'Claire Gibson: only usable at the exact start of ground combat on this planet, before its own round 1 begins.' };
  }
  const found = findPlanet(workingState, action.targetPlanetId);
  if (!found || found.planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };
  const hasOwnGroundForces = (found.planet.unitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0 && (s.unitType === "infantry" || s.unitType === "mech"));
  if (!hasOwnGroundForces) return { ok: false, error: "This player has no ground forces on that planet." };
  const reinforcementsCheck = checkReinforcementsAvailable(workingState, action.playerId, [{ unitType: "infantry", count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const updatedPlanet = addPlanetUnits(found.planet, action.playerId, "infantry", 1);
  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)) };
  return {
    ok: true,
    state: { ...workingState, systems: { ...workingState.systems, [found.systemId]: updatedSystem } },
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: found.systemId, planetId: action.targetPlanetId, unitType: "infantry", count: 1, totalCost: 0 }],
  };
}

/**
 * Sol "Jace X. 4th Air Legion — HELIO COMMAND ARRAY" (hero, single-use):
 * "ACTION: Remove each of your command tokens from the game board and
 * return them to your reinforcements. Then, purge this card." Unlock:
 * "Have 3 Scored Objectives." Purged (removed from Player.leaders
 * entirely) after use, unlike agents/commanders.
 */
export function useJaceX(state: GameState, action: { type: "USE_JACE_X"; playerId: PlayerId }): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player.leaders.find((l) => l.leaderId === ("jace_x" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Jace X." };

  const returnedCount = player.commandTokens.onBoard.length;
  const updatedPlayer: Player = purgeHero({ ...player, commandTokens: { ...player.commandTokens, onBoard: [] } }, asLeaderId("jace_x"));
  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } },
    events: [{ type: "COMMAND_TOKENS_RETURNED_TO_REINFORCEMENTS", playerId: action.playerId, count: returnedCount }],
  };
}

/**
 * Sol "Spec Ops II" (infantry upgrade, RESPAWN): "After this unit is
 * destroyed, roll 1 die. If the result is 5 or greater, place the unit
 * on this card." Checked once per DESTROYED infantry, for whichever of
 * this project's own hit-assignment call sites the caller invokes this
 * from — the caller supplies 1 pre-rolled die per destroyed Spec Ops II
 * infantry (trusted-RNG, same convention as every other roll in this
 * project). Units that pass the roll go to Player.specOpsOnCard (a
 * simple count — RR doesn't track WHICH specific infantry, just how
 * many are waiting) instead of being fully removed from the game.
 *
 * KNOWN GAP: only wired into ground combat's own hit-assignment call
 * site (phases/invasion.ts's own assignGroundCombatHits) in this pass —
 * Bombardment and Space Cannon Defense also destroy infantry and could
 * in principle also trigger this, but aren't hooked up here yet.
 */
export function checkSpecOpsRespawn(
  state: GameState,
  playerId: PlayerId,
  destroyedInfantryCount: number,
  dieRolls: number[],
  rules: RuleData,
): GameState {
  if (destroyedInfantryCount <= 0) return state;
  const player = state.players[playerId];
  if (player.factionId !== ("sol" as never)) return state;
  const stats = getUnitStats(rules, player.factionId, "infantry", player.unitUpgrades);
  if (!stats?.abilities.includes("respawn" as never)) return state;
  if (dieRolls.length !== destroyedInfantryCount) return state;

  const respawnedCount = dieRolls.filter((r) => r >= 5).length;
  if (respawnedCount <= 0) return state;
  return { ...state, players: { ...state.players, [playerId]: { ...player, specOpsOnCard: (player.specOpsOnCard ?? 0) + respawnedCount } } };
}

/**
 * Sol "Spec Ops II" (RESPAWN, other half): "At the start of your next
 * turn, place each unit that is on this card on a planet you control in
 * your home system." Called from actionPhase.ts's own advanceActivePlayer,
 * right when this player becomes active again.
 */
export function placeRespawnedSpecOps(state: GameState, playerId: PlayerId, rules: RuleData): GameState {
  const player = state.players[playerId];
  const count = player.specOpsOnCard ?? 0;
  if (count <= 0) return state;

  const homeSystemId = rules.homeSystemByFaction[player.factionId] as SystemId | undefined;
  const homeSystem = homeSystemId ? state.systems[homeSystemId] : undefined;
  const targetPlanet = homeSystem?.planets.find((p) => p.controllerId === playerId);
  if (!homeSystemId || !homeSystem || !targetPlanet) {
    // No planet in the home system currently controlled by this player — RR doesn't cover this edge case explicitly; the units just stay on the card rather than being invented a different destination.
    return state;
  }

  const updatedPlanet = addPlanetUnits(targetPlanet, playerId, "infantry", count);
  const updatedSystem: SystemState = { ...homeSystem, planets: homeSystem.planets.map((p) => (p.planetId === targetPlanet.planetId ? updatedPlanet : p)) };
  return {
    ...state,
    systems: { ...state.systems, [homeSystemId]: updatedSystem },
    players: { ...state.players, [playerId]: { ...player, specOpsOnCard: 0 } },
  };
}
