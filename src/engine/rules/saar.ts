import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, asTechId, asLeaderId } from "../types/ids";
import { UnitType, SHIP_TYPES, GROUND_FORCE_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { isBlockaded } from "./capture";
import { checkReinforcementsAvailable } from "./reinforcements";
import { spendForCost } from "../phases/technology";
import { getMaxNonFighterShips } from "./letnev";
import { canUseAgent, exhaustLeader, purgeHero } from "./leaders";
import { getAdjacentSystems } from "./adjacency";

/**
 * Clan of Saar "Floating Factory" (Space Placement): "If this unit is
 * blockaded, it is destroyed." Confirmed (tirules2.com/F_saar,
 * twilight-imperium.fandom.com/wiki/The_Clan_of_Saar) — a real, Saar-
 * specific penalty distinct from RR 14's own generic "a blockaded
 * Production-capable unit cannot produce ships" rule (which every
 * faction's normal space dock already has via phases/production.ts —
 * that rule alone never destroys anything). Ship movement is the only
 * way blockade state can change in this engine (same reasoning as
 * rules/capture.ts's own maybeReturnCapturedUnitsOnBlockade), so this is
 * called from the exact same post-movement hook in
 * phases/tacticalAction.ts, right alongside that function.
 *
 * Uses rules/capture.ts's own isBlockaded (a system is blockaded for a
 * player if they have no ships of their own there but at least 1 other
 * player does) rather than a bespoke check — same definition of
 * "blockaded" this project already uses everywhere else.
 */
export function maybeDestroyBlockadedFloatingFactories(state: GameState): GameState {
  let systems = state.systems;
  let anyChanged = false;
  for (const [systemId, system] of Object.entries(state.systems)) {
    for (const [playerId, stacks] of Object.entries(system.spaceUnitsByPlayer)) {
      const player = state.players[playerId as PlayerId];
      if (!player || player.factionId !== ("saar" as never)) continue;
      const floatingFactoryCount = (stacks ?? []).filter((s) => s.unitType === "space_dock").reduce((sum, s) => sum + s.count, 0);
      if (floatingFactoryCount <= 0) continue;
      if (!isBlockaded(state, playerId as PlayerId, systemId as SystemId)) continue;

      const remainingStacks = (stacks ?? []).filter((s) => s.unitType !== "space_dock");
      systems = { ...systems, [systemId]: { ...systems[systemId as SystemId], spaceUnitsByPlayer: { ...systems[systemId as SystemId].spaceUnitsByPlayer, [playerId]: remainingStacks } } };
      anyChanged = true;
    }
  }
  return anyChanged ? { ...state, systems } : state;
}

/**
 * Clan of Saar "Chaos Mapping" (faction technology), 2nd half: "At the
 * start of your turn during the action phase, you may produce 1 unit in
 * a system that contains at least 1 of your units that has PRODUCTION."
 * Confirmed (boardgamegeek.com/thread/2466368): usable before EVERY
 * action this player takes this turn (tactical, strategic, component, or
 * even passing) — not just once per round — but Sarween Tools/War
 * Machine do NOT apply, since this is its own standalone PERMISSION to
 * produce, distinct from "using a unit's own Production ability" (which
 * is what those 2 reductions are actually keyed on) — full listed cost,
 * always, for exactly 1 individual unit (not the normal per-token pair
 * for infantry/fighters). Ground forces get the same "space area or a
 * controlled planet in this system" choice as Floating Factory's own
 * production (phases/production.ts's own executeProduction) — no
 * narrower restriction is printed here, and Saar's own Production
 * source is itself frequently the space-placed Floating Factory.
 *
 * The 1st half of Chaos Mapping ("Other players cannot activate asteroid
 * fields that contain 1 or more of your ships") lives in
 * phases/tacticalAction.ts's own activateSystem instead — a validation
 * check on someone ELSE's action, not something this player invokes.
 */
export function useChaosMapping(
  state: GameState,
  action: {
    type: "USE_CHAOS_MAPPING";
    playerId: PlayerId;
    systemId: SystemId;
    unitType: UnitType;
    groundForceDestinationPlanetId?: PlanetId;
    exhaustPlanetIdsForResources?: PlanetId[];
  },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  if (!player || player.factionId !== ("saar" as never) || !player.technologies.includes(asTechId("chaos_mapping"))) {
    return { ok: false, error: "This player doesn't have Chaos Mapping." };
  }
  if (state.phase !== "action") {
    return { ok: false, error: "Chaos Mapping is only usable during the action phase." };
  }
  if (state.activePlayerId !== action.playerId) {
    return { ok: false, error: "Chaos Mapping: only usable at the start of this player's own turn." };
  }
  if (state.usedChaosMappingForActivePlayerTurn) {
    return { ok: false, error: "Chaos Mapping has already been used before this turn's action." };
  }
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `Unknown system ${action.systemId}.` };
  const hasProducerHere =
    (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0 && getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades)?.abilities.includes("production")) ||
    system.planets.some((p) => (p.unitsByPlayer[action.playerId] ?? []).some((s) => s.count > 0 && getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades)?.abilities.includes("production")));
  if (!hasProducerHere) {
    return { ok: false, error: `This player has no unit with Production in ${action.systemId}.` };
  }

  const stats = getUnitStats(rules, player.factionId, action.unitType, player.unitUpgrades);
  if (!stats) return { ok: false, error: `No stats for ${action.unitType}.` };
  if (stats.cost == null) {
    return { ok: false, error: `RR 26.3: ${action.unitType} has no cost and cannot be produced this way.` };
  }
  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: action.unitType, count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  const isShip = SHIP_TYPES.includes(action.unitType);
  if (isShip && action.unitType !== "fighter") {
    const existingNonFighterShips = (system.spaceUnitsByPlayer[action.playerId] ?? []).filter((s) => SHIP_TYPES.includes(s.unitType) && s.unitType !== "fighter").reduce((sum, s) => sum + s.count, 0);
    if (existingNonFighterShips + 1 > getMaxNonFighterShips(player)) {
      return { ok: false, error: "RR 37.1: producing this ship would exceed this player's fleet pool." };
    }
  }
  if (action.unitType === "fighter") {
    const existingCargo = (system.spaceUnitsByPlayer[action.playerId] ?? []).reduce((sum, s) => (s.unitType === "fighter" || GROUND_FORCE_TYPES.includes(s.unitType) ? sum + s.count : sum), 0);
    const existingCapacity = (system.spaceUnitsByPlayer[action.playerId] ?? []).reduce((sum, s) => {
      if (!SHIP_TYPES.includes(s.unitType)) return sum;
      const shipStats = getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades);
      return sum + (shipStats?.capacity ?? 0) * s.count;
    }, 0);
    if (existingCargo + 1 > existingCapacity) {
      return { ok: false, error: `RR 16.3: producing this fighter would exceed this player's combined ship capacity in ${action.systemId}.` };
    }
  }

  const spend = spendForCost(state, action.playerId, stats.cost, action.exhaustPlanetIdsForResources ?? [], rules);
  if (!spend.ok) return spend;
  let nextState = spend.state;

  let groundForceDestinationPlanet: PlanetState | undefined;
  if (!isShip && action.groundForceDestinationPlanetId) {
    groundForceDestinationPlanet = system.planets.find((p) => p.planetId === action.groundForceDestinationPlanetId);
    if (!groundForceDestinationPlanet || groundForceDestinationPlanet.controllerId !== action.playerId) {
      return { ok: false, error: `This player doesn't control ${action.groundForceDestinationPlanetId} in ${action.systemId}.` };
    }
  }

  const nextSystem = nextState.systems[action.systemId];
  if (isShip || !groundForceDestinationPlanet) {
    const stacks = (nextSystem.spaceUnitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
    const existing = stacks.find((s) => s.unitType === action.unitType && !s.upgradeId);
    if (existing) existing.count += 1;
    else stacks.push({ unitType: action.unitType, count: 1, damagedCount: 0 });
    nextState = { ...nextState, systems: { ...nextState.systems, [action.systemId]: { ...nextSystem, spaceUnitsByPlayer: { ...nextSystem.spaceUnitsByPlayer, [action.playerId]: stacks } } } };
  } else {
    const stacks = (groundForceDestinationPlanet.unitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
    const existing = stacks.find((s) => s.unitType === action.unitType && !s.upgradeId);
    if (existing) existing.count += 1;
    else stacks.push({ unitType: action.unitType, count: 1, damagedCount: 0 });
    const updatedPlanet: PlanetState = { ...groundForceDestinationPlanet, unitsByPlayer: { ...groundForceDestinationPlanet.unitsByPlayer, [action.playerId]: stacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [action.systemId]: { ...nextSystem, planets: nextSystem.planets.map((p) => (p.planetId === groundForceDestinationPlanet!.planetId ? updatedPlanet : p)) } } };
  }

  return {
    ok: true,
    state: { ...nextState, usedChaosMappingForActivePlayerTurn: true },
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: action.systemId, planetId: groundForceDestinationPlanet?.planetId, unitType: action.unitType, count: 1, totalCost: stats.cost }],
  };
}

/**
 * Clan of Saar "Ragh's Call" (promissory note): "After you commit 1 or
 * more units to land on a planet: Remove all of the Saar player's
 * ground forces from that planet and place them on a planet controlled
 * by the Saar player. Then, return this card to the Saar player."
 * Confirmed (tirules2.com/F_saar): "Playing Ragh's Call will prevent
 * ground combat from occurring on that planet. Any PDS on the planet
 * remain [and] might produce hits during the Space Cannon Defense
 * step"; "All of the Saar player's ground forces must be placed on the
 * same [destination] planet." The RECIPIENT (whoever committed ground
 * forces there) already holds this in hand from an earlier transaction —
 * playerId here is the SAAR player playing it, not the recipient.
 */
export function useRaghsCall(
  state: GameState,
  action: { type: "USE_RAGHS_CALL"; playerId: PlayerId; targetPlanetId: PlanetId; destinationPlanetId: PlanetId },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player || player.factionId !== ("saar" as never)) return { ok: false, error: "Only the Saar player has Ragh's Call." };
  if (!player.promissoryNotesInHand.includes("saar_promissory" as never)) {
    return { ok: false, error: "This player doesn't have Ragh's Call in hand." };
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
  const ownStacks = found.planet.unitsByPlayer[action.playerId] ?? [];
  if (!ownStacks.some((s) => GROUND_FORCE_TYPES.includes(s.unitType) && s.count > 0)) {
    return { ok: false, error: "This player has no ground forces on that planet to evacuate." };
  }
  const otherPlayerJustLanded = Object.entries(found.planet.unitsByPlayer).some(
    ([pid, stacks]) => pid !== action.playerId && (stacks ?? []).some((s) => GROUND_FORCE_TYPES.includes(s.unitType) && s.count > 0),
  );
  if (!otherPlayerJustLanded) {
    return { ok: false, error: "Ragh's Call: only usable after another player commits ground forces to land on this planet." };
  }

  let destFound: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === action.destinationPlanetId);
    if (planet) {
      destFound = { systemId: systemId as SystemId, system, planet };
      break;
    }
  }
  if (!destFound || destFound.planet.controllerId !== action.playerId) {
    return { ok: false, error: "This player doesn't control the destination planet." };
  }
  if (destFound.planet.planetId === found.planet.planetId) {
    return { ok: false, error: "Ragh's Call: the destination must be a different planet." };
  }

  const evacuated = ownStacks.filter((s) => GROUND_FORCE_TYPES.includes(s.unitType) && s.count > 0);
  const remainingSourceStacks = ownStacks.filter((s) => !GROUND_FORCE_TYPES.includes(s.unitType) || s.count <= 0);
  const updatedSourcePlanet: PlanetState = { ...found.planet, unitsByPlayer: { ...found.planet.unitsByPlayer, [action.playerId]: remainingSourceStacks } };

  const destStacks = (destFound.planet.unitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));
  for (const moved of evacuated) {
    // Confirmed (yjmrobert.com/tirules/factions/f_saar): "Any damaged
    // mechs remain damaged." Previously merging into an EXISTING stack
    // only added `count`, silently dropping `damagedCount` — a damaged
    // mech evacuated onto a planet that already had undamaged mechs of
    // the same type would lose its damaged status entirely.
    const existing = destStacks.find((s) => s.unitType === moved.unitType && s.upgradeId === moved.upgradeId);
    if (existing) {
      existing.count += moved.count;
      existing.damagedCount = (existing.damagedCount ?? 0) + (moved.damagedCount ?? 0);
    } else {
      destStacks.push({ ...moved });
    }
  }
  const updatedDestPlanet: PlanetState = { ...destFound.planet, unitsByPlayer: { ...destFound.planet.unitsByPlayer, [action.playerId]: destStacks } };

  let systems = { ...state.systems };
  systems[found.systemId] = { ...systems[found.systemId], planets: systems[found.systemId].planets.map((p) => (p.planetId === found!.planet.planetId ? updatedSourcePlanet : p)) };
  systems[destFound.systemId] = { ...systems[destFound.systemId], planets: systems[destFound.systemId].planets.map((p) => (p.planetId === destFound!.planet.planetId ? updatedDestPlanet : p)) };

  return {
    ok: true,
    state: { ...state, systems, players: { ...state.players, [action.playerId]: { ...player, promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("saar_promissory" as never)) } } },
    events: [],
  };
}

/**
 * Clan of Saar "Captain Mendosa" (agent): "After a player activates a
 * system: You may exhaust this card to increase the move value of 1 of
 * that player's ships to match the move value of the ship on the game
 * board that has the highest move value." See GameState.ts's own
 * mendosaMoveOverride doc comment for the confirmed timing/stacking
 * rulings — this function only computes and banks the fixed value;
 * phases/tacticalAction.ts's own moveShips actually applies it.
 */
export function useMendosa(
  state: GameState,
  action: { type: "USE_MENDOSA"; playerId: PlayerId; targetPlayerId: PlayerId; unitType: UnitType; fromSystemId: SystemId },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const agentCheck = canUseAgent(player, asLeaderId("saar_agent"));
  if (!agentCheck.ok) return agentCheck;
  if (!state.pendingTacticalAction || state.pendingTacticalAction.playerId !== action.targetPlayerId) {
    return { ok: false, error: "Captain Mendosa: only usable right after this player activated a system." };
  }
  const targetSystem = state.systems[action.fromSystemId];
  const stack = targetSystem?.spaceUnitsByPlayer[action.targetPlayerId]?.find((s) => s.unitType === action.unitType && s.count > 0);
  if (!stack) return { ok: false, error: `That player has no ${action.unitType} in ${action.fromSystemId}.` };

  let highestMove = 0;
  for (const system of Object.values(state.systems)) {
    for (const [pid, stacks] of Object.entries(system.spaceUnitsByPlayer)) {
      const owner = state.players[pid as PlayerId];
      if (!owner) continue;
      for (const s of stacks ?? []) {
        if (s.count <= 0) continue;
        const stats = getUnitStats(rules, owner.factionId, s.unitType, owner.unitUpgrades);
        if (stats?.move != null && stats.move > highestMove) highestMove = stats.move;
      }
    }
  }

  const updatedPlayer = exhaustLeader(player, asLeaderId("saar_agent"));
  return {
    ok: true,
    state: {
      ...state,
      players: { ...state.players, [action.playerId]: updatedPlayer },
      pendingTacticalAction: { ...state.pendingTacticalAction, mendosaMoveOverride: { unitType: action.unitType, fromSystemId: action.fromSystemId, moveValue: highestMove } },
    },
    events: [],
  };
}

/**
 * Clan of Saar "Rowl Sarrig" (commander): "When you produce fighters or
 * infantry: You may place each of those units at any of your space
 * docks that are not blockaded." Unlock: "Have 3 space docks on the
 * game board" — a passive, count-based condition (not tied to a
 * triggering event) re-checked fresh on every use here, rather than a
 * persisted unlock flag, since nothing else in this project currently
 * has a hook for "a 3rd space dock just got placed" to unlock it at.
 * Modeled as its own follow-up relocation step (called right after the
 * normal production already placed these units at their default
 * location) rather than a parameter threaded through
 * phases/production.ts's own executeProduction, since the destination
 * here can be a WHOLE DIFFERENT SYSTEM (any of this player's own space
 * docks board-wide), unlike every other production-destination choice
 * this project already models (all scoped to the same system).
 */
export function useRowlSarrig(
  state: GameState,
  action: {
    type: "USE_ROWL_SARRIG";
    playerId: PlayerId;
    sourceSystemId: SystemId;
    sourcePlanetId?: PlanetId;
    unitType: "fighter" | "infantry";
    count: number;
    destinationSystemId: SystemId;
    destinationPlanetId?: PlanetId;
  },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player || player.factionId !== ("saar" as never)) return { ok: false, error: "Only the Saar player has Rowl Sarrig." };
  let spaceDockCount = 0;
  for (const system of Object.values(state.systems)) {
    spaceDockCount += (system.spaceUnitsByPlayer[action.playerId] ?? []).filter((s) => s.unitType === "space_dock").reduce((sum, s) => sum + s.count, 0);
    for (const planet of system.planets) {
      spaceDockCount += (planet.unitsByPlayer[action.playerId] ?? []).filter((s) => s.unitType === "space_dock").reduce((sum, s) => sum + s.count, 0);
    }
  }
  if (spaceDockCount < 3) return { ok: false, error: "Rowl Sarrig: this player needs 3 space docks on the game board." };

  const sourceSystem = state.systems[action.sourceSystemId];
  if (!sourceSystem) return { ok: false, error: `Unknown system ${action.sourceSystemId}.` };
  const sourcePlanet = action.sourcePlanetId ? sourceSystem.planets.find((p) => p.planetId === action.sourcePlanetId) : undefined;
  const sourceStacks = sourcePlanet ? sourcePlanet.unitsByPlayer[action.playerId] ?? [] : sourceSystem.spaceUnitsByPlayer[action.playerId] ?? [];
  const sourceStack = sourceStacks.find((s) => s.unitType === action.unitType);
  if (!sourceStack || sourceStack.count < action.count) {
    return { ok: false, error: `Not enough ${action.unitType} at the source to relocate ${action.count}.` };
  }

  const destSystem = state.systems[action.destinationSystemId];
  if (!destSystem) return { ok: false, error: `Unknown system ${action.destinationSystemId}.` };
  const destPlanet = action.destinationPlanetId ? destSystem.planets.find((p) => p.planetId === action.destinationPlanetId) : undefined;
  const destHasOwnSpaceDock = destPlanet
    ? (destPlanet.unitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "space_dock" && s.count > 0)
    : (destSystem.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "space_dock" && s.count > 0);
  if (!destHasOwnSpaceDock) return { ok: false, error: "The destination doesn't have one of this player's own space docks." };
  if (isBlockaded(state, action.playerId, action.destinationSystemId)) {
    return { ok: false, error: "Rowl Sarrig: that destination is currently blockaded." };
  }

  const updatedSourceStacks = sourceStacks.map((s) => (s === sourceStack ? { ...s, count: s.count - action.count } : s)).filter((s) => s.count > 0);
  const destStacksBase = destPlanet ? destPlanet.unitsByPlayer[action.playerId] ?? [] : destSystem.spaceUnitsByPlayer[action.playerId] ?? [];
  const destStacks = destStacksBase.map((s) => ({ ...s }));
  const existingDest = destStacks.find((s) => s.unitType === action.unitType && !s.upgradeId);
  if (existingDest) existingDest.count += action.count;
  else destStacks.push({ unitType: action.unitType, count: action.count, damagedCount: 0 });

  let systems = { ...state.systems };
  systems[action.sourceSystemId] = sourcePlanet
    ? { ...sourceSystem, planets: sourceSystem.planets.map((p) => (p.planetId === sourcePlanet.planetId ? { ...sourcePlanet, unitsByPlayer: { ...sourcePlanet.unitsByPlayer, [action.playerId]: updatedSourceStacks } } : p)) }
    : { ...sourceSystem, spaceUnitsByPlayer: { ...sourceSystem.spaceUnitsByPlayer, [action.playerId]: updatedSourceStacks } };
  const finalDestSystem = systems[action.destinationSystemId];
  systems[action.destinationSystemId] = destPlanet
    ? { ...finalDestSystem, planets: finalDestSystem.planets.map((p) => (p.planetId === destPlanet.planetId ? { ...destPlanet, unitsByPlayer: { ...destPlanet.unitsByPlayer, [action.playerId]: destStacks } } : p)) }
    : { ...finalDestSystem, spaceUnitsByPlayer: { ...finalDestSystem.spaceUnitsByPlayer, [action.playerId]: destStacks } };

  return { ok: true, state: { ...state, systems }, events: [] };
}

/**
 * Clan of Saar "Gurno Aggero" (hero): "ARMAGEDDON RELAY — ACTION: Choose
 * 1 system that is adjacent to 1 of your space docks. Destroy all other
 * players' infantry and fighters in that system." A normal component
 * ACTION (usable on this player's own turn, no reactive trigger),
 * matching the same "as your action" shape as every other component-
 * action hero in this project.
 */
export function useGurnoAggero(state: GameState, action: { type: "USE_GURNO_AGGERO"; playerId: PlayerId; targetSystemId: SystemId }, rules: RuleData): ActionResult {
  if (state.phase !== "action") return { ok: false, error: "Gurno Aggero is only usable during the action phase." };
  if (state.activePlayerId !== action.playerId) return { ok: false, error: "RR 4: it isn't this player's turn." };
  const player = state.players[action.playerId];
  const heroEntry = player?.leaders.find((l) => l.leaderId === ("saar_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Gurno Aggero." };

  const hasAdjacentOwnSpaceDock = getAdjacentSystems(state, action.targetSystemId, rules).some((id) => {
    const s = state.systems[id];
    if (!s) return false;
    const inSpace = (s.spaceUnitsByPlayer[action.playerId] ?? []).some((u) => u.unitType === "space_dock" && u.count > 0);
    const onPlanet = s.planets.some((p) => (p.unitsByPlayer[action.playerId] ?? []).some((u) => u.unitType === "space_dock" && u.count > 0));
    return inSpace || onPlanet;
  });
  if (!hasAdjacentOwnSpaceDock) return { ok: false, error: "Gurno Aggero: the target system isn't adjacent to any of this player's own space docks." };

  const targetSystem = state.systems[action.targetSystemId];
  if (!targetSystem) return { ok: false, error: `Unknown system ${action.targetSystemId}.` };

  const updatedSpaceUnitsByPlayer: SystemState["spaceUnitsByPlayer"] = { ...targetSystem.spaceUnitsByPlayer };
  for (const [pid, stacks] of Object.entries(targetSystem.spaceUnitsByPlayer)) {
    if (pid === action.playerId) continue;
    updatedSpaceUnitsByPlayer[pid as PlayerId] = (stacks ?? []).filter((s) => s.unitType !== "fighter");
  }
  const updatedPlanets = targetSystem.planets.map((p) => ({
    ...p,
    unitsByPlayer: Object.fromEntries(Object.entries(p.unitsByPlayer).map(([pid, stacks]) => [pid, pid === action.playerId ? stacks : (stacks ?? []).filter((s) => s.unitType !== "infantry")])),
  }));
  const updatedSystem: SystemState = { ...targetSystem, spaceUnitsByPlayer: updatedSpaceUnitsByPlayer, planets: updatedPlanets };

  const updatedPlayer = purgeHero(player, asLeaderId("saar_hero"));
  return {
    ok: true,
    state: { ...state, systems: { ...state.systems, [action.targetSystemId]: updatedSystem }, players: { ...state.players, [action.playerId]: updatedPlayer } },
    events: [],
  };
}

/**
 * Clan of Saar "Deorbit Barrage" (Breakthrough ability): "ACTION:
 * Exhaust this card and spend any amount of resources to choose a
 * planet up to 2 systems away from an asteroid field that contains your
 * ships; roll a number of dice equal to the amount spent, and assign 1
 * hit to a ground force on that planet for each roll of 4 or greater."
 * Confirmed die-rolling convention (this project's own "trusted-RNG,
 * caller supplies pre-rolled dice" pattern, same as rules/sol.ts's own
 * checkSpecOpsRespawn) — the caller passes exactly `resourcesSpent`
 * pre-rolled dice.
 */
export function useDeorbitBarrage(
  state: GameState,
  action: {
    type: "USE_DEORBIT_BARRAGE";
    playerId: PlayerId;
    sourceAsteroidFieldSystemId: SystemId;
    targetPlanetId: PlanetId;
    resourcesSpent: number;
    dieRolls: number[];
    hitAssignments: { unitType: UnitType }[];
    exhaustPlanetIdsForResources?: PlanetId[];
  },
  rules: RuleData,
): ActionResult {
  if (state.phase !== "action") return { ok: false, error: "Deorbit Barrage is only usable during the action phase." };
  if (state.activePlayerId !== action.playerId) return { ok: false, error: "RR 4: it isn't this player's turn." };
  const player = state.players[action.playerId];
  if (!player || player.factionId !== ("saar" as never) || !player.hasBreakthrough) {
    return { ok: false, error: "This player doesn't have Deorbit Barrage." };
  }
  if (player.breakthroughExhausted) {
    return { ok: false, error: "Deorbit Barrage is already exhausted." };
  }
  const sourceSystem = state.systems[action.sourceAsteroidFieldSystemId];
  const isAsteroidField = sourceSystem?.anomalies.includes("asteroid_field" as never) ?? false;
  const hasShipsHere = (sourceSystem?.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => SHIP_TYPES.includes(s.unitType) && s.count > 0);
  if (!isAsteroidField || !hasShipsHere) {
    return { ok: false, error: "Deorbit Barrage: this player needs ships in an asteroid field system." };
  }

  let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === action.targetPlanetId);
    if (planet) {
      found = { systemId: systemId as SystemId, system, planet };
      break;
    }
  }
  if (!found) return { ok: false, error: `Unknown planet ${action.targetPlanetId}.` };
  if (!isWithinNSystemHops(state, rules, action.sourceAsteroidFieldSystemId, found.systemId, 2)) {
    return { ok: false, error: "Deorbit Barrage: the target planet must be within 2 systems of the asteroid field." };
  }
  if (action.resourcesSpent <= 0) return { ok: false, error: "Deorbit Barrage: must spend at least 1 resource." };
  if (action.dieRolls.length !== action.resourcesSpent) {
    return { ok: false, error: "Deorbit Barrage: must supply exactly 1 die roll per resource spent." };
  }

  const spend = spendForCost(state, action.playerId, action.resourcesSpent, action.exhaustPlanetIdsForResources ?? [], rules);
  if (!spend.ok) return spend;
  let nextState = spend.state;

  const hitCount = action.dieRolls.filter((r) => r >= 4).length;
  if (hitCount > 0 && action.hitAssignments.length > 0) {
    const currentPlanet = nextState.systems[found.systemId].planets.find((p) => p.planetId === action.targetPlanetId)!;
    const owningPlayerId = Object.keys(currentPlanet.unitsByPlayer).find((pid) => (currentPlanet.unitsByPlayer[pid as PlayerId] ?? []).some((s) => GROUND_FORCE_TYPES.includes(s.unitType) && s.count > 0)) as PlayerId | undefined;
    if (owningPlayerId) {
      const owningPlayer = nextState.players[owningPlayerId];
      let planetStacks = (currentPlanet.unitsByPlayer[owningPlayerId] ?? []).map((s) => ({ ...s }));
      let hitsLeft = Math.min(hitCount, action.hitAssignments.length);
      for (const assignment of action.hitAssignments) {
        if (hitsLeft <= 0) break;
        const stack = planetStacks.find((s) => s.unitType === assignment.unitType && s.count > 0);
        if (!stack) continue;
        // Confirmed (yjmrobert.com/tirules/factions/f_saar): "If the
        // chosen unit has the Sustain Damage ability, it may be used to
        // cancel the hit. The Saar player may assign multiple hits to
        // the same unit." — the FIRST hit against a not-yet-damaged
        // Sustain-Damage-capable unit (a mech, typically) marks it
        // damaged instead of destroying it; a SECOND hit against an
        // already-damaged copy (or any hit against a unit without
        // Sustain Damage) actually destroys it. Previously this always
        // destroyed on the first hit, ignoring Sustain Damage entirely.
        const stats = getUnitStats(rules, owningPlayer.factionId, stack.unitType, owningPlayer.unitUpgrades);
        const hasSustainDamage = stats?.abilities.includes("sustainDamage") ?? false;
        if (hasSustainDamage && (stack.damagedCount ?? 0) < stack.count) {
          stack.damagedCount = (stack.damagedCount ?? 0) + 1;
        } else {
          stack.count -= 1;
          if ((stack.damagedCount ?? 0) > stack.count) stack.damagedCount = stack.count;
        }
        hitsLeft -= 1;
      }
      planetStacks = planetStacks.filter((s) => s.count > 0);
      const updatedPlanet: PlanetState = { ...currentPlanet, unitsByPlayer: { ...currentPlanet.unitsByPlayer, [owningPlayerId]: planetStacks } };
      nextState = { ...nextState, systems: { ...nextState.systems, [found.systemId]: { ...nextState.systems[found.systemId], planets: nextState.systems[found.systemId].planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)) } } };
    }
  }

  return {
    ok: true,
    state: { ...nextState, players: { ...nextState.players, [action.playerId]: { ...nextState.players[action.playerId], breakthroughExhausted: true } } },
    events: [],
  };
}

/** Simple bounded BFS — is `toSystemId` reachable from `fromSystemId` within `maxHops` system-to-system adjacency steps? Used by Deorbit Barrage's own "up to 2 systems away" range check; this project has no existing general N-hop distance helper (every other range-limited ability so far only ever needed a direct getAdjacentSystems() 1-hop check). */
function isWithinNSystemHops(state: GameState, rules: RuleData, fromSystemId: SystemId, toSystemId: SystemId, maxHops: number): boolean {
  if (fromSystemId === toSystemId) return true;
  let frontier = new Set<SystemId>([fromSystemId]);
  const visited = new Set<SystemId>([fromSystemId]);
  for (let hop = 0; hop < maxHops; hop++) {
    const next = new Set<SystemId>();
    for (const id of frontier) {
      for (const adj of getAdjacentSystems(state, id, rules)) {
        if (adj === toSystemId) return true;
        if (!visited.has(adj)) {
          visited.add(adj);
          next.add(adj);
        }
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * Clan of Saar "Scavenger Zeta" (mech, Deploy): the pending-choice half —
 * "After you gain control of a planet, you may spend 1 trade good to
 * place 1 mech on that planet." Queued by phases/invasion.ts's own
 * setPlanetController (GameState.pendingScavengerZetaDeploy), resolved
 * here — declining (action.use === false) just clears the pending entry
 * with no other effect, matching the card's own "may".
 */
export function resolveScavengerZetaDeploy(
  state: GameState,
  action: { type: "RESOLVE_SCAVENGER_ZETA_DEPLOY"; playerId: PlayerId; planetId: PlanetId; use: boolean },
): ActionResult {
  const pending = state.pendingScavengerZetaDeploy ?? [];
  const entry = pending.find((e) => e.playerId === action.playerId && e.planetId === action.planetId);
  if (!entry) return { ok: false, error: "This player has no pending Scavenger Zeta Deploy for that planet." };
  const remainingPending = pending.filter((e) => e !== entry);

  if (!action.use) {
    return { ok: true, state: { ...state, pendingScavengerZetaDeploy: remainingPending.length > 0 ? remainingPending : undefined }, events: [] };
  }

  const player = state.players[action.playerId];
  if (player.tradeGoods < 1) return { ok: false, error: "This player doesn't have 1 trade good to spend." };
  const reinforcementsCheck = checkReinforcementsAvailable(state, action.playerId, [{ unitType: "mech", count: 1 }]);
  if (!reinforcementsCheck.ok) return reinforcementsCheck;

  let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === action.planetId);
    if (planet) {
      found = { systemId: systemId as SystemId, system, planet };
      break;
    }
  }
  if (!found || found.planet.controllerId !== action.playerId) {
    return { ok: false, error: "This player no longer controls that planet." };
  }

  const stacks = found.planet.unitsByPlayer[action.playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === "mech" && !s.upgradeId);
  const updatedStacks = existing ? stacks.map((s) => (s === existing ? { ...s, count: s.count + 1 } : s)) : [...stacks, { unitType: "mech" as const, count: 1, damagedCount: 0 }];
  const updatedPlanet: PlanetState = { ...found.planet, unitsByPlayer: { ...found.planet.unitsByPlayer, [action.playerId]: updatedStacks } };
  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };

  const updatedPlayer: Player = { ...player, tradeGoods: player.tradeGoods - 1 };
  return {
    ok: true,
    state: {
      ...state,
      systems: { ...state.systems, [found.systemId]: updatedSystem },
      players: { ...state.players, [action.playerId]: updatedPlayer },
      pendingScavengerZetaDeploy: remainingPending.length > 0 ? remainingPending : undefined,
    },
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: found.systemId, planetId: action.planetId, unitType: "mech", count: 1, totalCost: 0 }],
  };
}
