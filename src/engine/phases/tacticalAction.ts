import { GameState, Player, SystemState } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, SystemId, asTechId, asPlanetId } from "../types/ids";
import { STRUCTURE_TYPES, SHIP_TYPES, GROUND_FORCE_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { canShipReachSystem } from "../rules/movement";
import { maybeActivateWormholeNexus } from "../rules/adjacency";
import { resolveSpaceStationControl } from "../rules/spaceStations";
import { usesCodex4Version } from "../rules/gameMode";
import { playersWithShipsInSystem, getSpaceCannonOffenseEligiblePlayers } from "../rules/combat";
import { maybeReturnCapturedUnitsOnBlockade } from "../rules/capture";
import { computeSpaceCombatEntry, openCombatRoundStartWindowIfNeeded } from "./spaceCombat";
import { openInvasionStartWindowIfNeeded } from "./invasion";
import { actionPhaseWindowOrder } from "../rules/priorityWindow";
import { findControlledLegendaryPlanet, exhaustLegendaryAbility } from "./legendaryPlanets";
import { getMaxNonFighterShips } from "../rules/letnev";

/**
 * RR 78 STEP 1 — ACTIVATION.
 * RR 5.1/5.2: place a tactic-pool command token on a system the player
 * doesn't already have a token in. Sets up `pendingTacticalAction` so the
 * rest of the tactical action (movement, combat, invasion, production) can
 * be resolved across separate async submissions instead of one giant action.
 */
export function activateSystem(
  state: GameState,
  action: { type: "ACTIVATE_SYSTEM"; playerId: PlayerId; systemId: SystemId },
  rules: RuleData,
): ActionResult {
  if (state.phase !== "action") {
    return { ok: false, error: "RR 78: tactical actions only happen during the action phase." };
  }
  if (state.activePlayerId !== action.playerId) {
    return { ok: false, error: "RR 4: it is not this player's turn." };
  }
  if (state.pendingTacticalAction) {
    return { ok: false, error: "A tactical action is already in progress; resolve it before activating a new system." };
  }

  const player = state.players[action.playerId];
  if (player.hasPassed) {
    return { ok: false, error: "RR 3.3: this player has already passed for the action phase." };
  }
  if (player.commandTokens.tactic <= 0) {
    return { ok: false, error: "RR 78.1: no command tokens remaining in tactic pool." };
  }
  if (player.commandTokens.onBoard.includes(action.systemId)) {
    return { ok: false, error: "RR 5.2: a player cannot activate a system that already contains one of his command tokens." };
  }

  const updatedPlayer: Player = {
    ...player,
    commandTokens: {
      ...player.commandTokens,
      tactic: player.commandTokens.tactic - 1,
      onBoard: [...player.commandTokens.onBoard, action.systemId],
    },
  };

  // RR "Magen Defense Grid" ΩΩ (Codex 4): whenever ANY player activates a
  // system containing 1+ of a magen_defense_grid-owning player's own
  // structures — even the activating player's own system, even the
  // activating player themselves if it's their own structures — place 1
  // free infantry with EACH such structure. Not gated to the base
  // version's readied/exhaust state at all (this ΩΩ ability never
  // exhausts anything).
  const activatedSystem = state.systems[action.systemId];
  const updatedPlanets = activatedSystem
    ? activatedSystem.planets.map((planet) => {
        let updatedPlanet = planet;
        for (const [ownerId, stacks] of Object.entries(planet.unitsByPlayer)) {
          const ownerPlayer = state.players[ownerId as PlayerId];
          if (!ownerPlayer?.technologies.includes(asTechId("magen_defense_grid")) || !usesCodex4Version(state.mode)) continue;
          const structureCount = (stacks ?? []).filter((s) => STRUCTURE_TYPES.includes(s.unitType)).reduce((sum, s) => sum + s.count, 0);
          if (structureCount === 0) continue;
          const existingInfantry = (updatedPlanet.unitsByPlayer[ownerId as PlayerId] ?? []).find((s) => s.unitType === "infantry" && !s.upgradeId);
          const ownerStacks = updatedPlanet.unitsByPlayer[ownerId as PlayerId] ?? [];
          const newOwnerStacks = existingInfantry
            ? ownerStacks.map((s) => (s === existingInfantry ? { ...s, count: s.count + structureCount } : s))
            : [...ownerStacks, { unitType: "infantry" as const, count: structureCount, damagedCount: 0 }];
          updatedPlanet = { ...updatedPlanet, unitsByPlayer: { ...updatedPlanet.unitsByPlayer, [ownerId]: newOwnerStacks } };
        }
        return updatedPlanet;
      })
    : [];
  const systemsWithMagenDefenseGridInfantry = activatedSystem
    ? { ...state.systems, [action.systemId]: { ...activatedSystem, planets: updatedPlanets } }
    : state.systems;

  const nextState: GameState = {
    ...state,
    systems: systemsWithMagenDefenseGridInfantry,
    players: { ...state.players, [player.id]: updatedPlayer },
    pendingTacticalAction: {
      playerId: action.playerId,
      systemId: action.systemId,
      step: "movement",
    },
    // RR 52-adjacent: see GameState.ts's own doc comment on recentEvents —
    // a new tactical action starting is the reset point for that buffer.
    recentEvents: [],
    // RR 1.19/1.20: "when you activate a system" / "after you activate a
    // system" are 2 sequential windows (RR 1.16 — "when" resolves before
    // "after") for the SAME lone participant (the activating player — see
    // rules/priorityWindow.ts's own CHAINED_NEXT_KIND for how the 2nd
    // opens automatically once the 1st fully closes). Opened even though
    // only 1 player could ever act in either — the engine never decides
    // "nobody could plausibly want this" on a player's behalf; it always
    // asks, and a no-op window closes the instant that 1 player passes.
    pendingPriorityWindow: { kind: "system_activated", order: [action.playerId], currentIndex: 0, consecutivePasses: 0 },
  };

  return {
    ok: true,
    state: nextState,
    events: [{ type: "SYSTEM_ACTIVATED", playerId: action.playerId, systemId: action.systemId }],
  };
}

/**
 * RR 78 STEP 2 — MOVEMENT (RR 58.4 for the per-ship legality rules).
 * Validates and applies ship movement into the active system in one shot
 * (all of a player's moved ships move simultaneously per RR 58.6, so there's
 * no reason to split this into per-ship actions).
 *
 * Reachability (enemy-fleet blocking, RR 9 anomaly entry/pass-through rules,
 * Nebula's move-value clamp, Gravity Rift's move-value bonus) is delegated
 * to rules/movement.ts's canShipReachSystem — see that file for the exact
 * rules it enforces and the one thing it deliberately doesn't (Gravity
 * Rift's destruction die roll, parked pending an RNG-in-pure-engine design
 * decision shared with combat resolution).
 */
export function moveShips(
  state: GameState,
  action: {
    type: "MOVE_SHIPS";
    playerId: PlayerId;
    moves: { fromSystemId: SystemId; unitType: import("../types/enums").UnitType; count: number }[];
    transportedGroundForces?: { fromSystemId: SystemId; unitType: "infantry" | "mech"; count: number }[];
    transportedFighters?: { fromSystemId: SystemId; count: number }[];
    gravityDriveBoostFromSystemId?: SystemId;
    /** TE "Ionian Fuel Refinery" (Tempesta's own legendary planet ability): "exhaust this card after you activate a system to apply +1 to the move value of 1 of your ships during this tactical action" — same "identify the one moves-entry by its fromSystemId" shape as Gravity Drive above, but exhausts the legendary ability (once per its own ready cycle) rather than being a repeatable-every-turn tech. */
    ionianFuelRefineryBoostFromSystemId?: SystemId;
    /** Muaat "Stellar Genesis" breakthrough ability: if a war sun's own path this action visits Avernus's system — as its literal origin OR a mid-path hop, see this function's own warSunPassedThroughAvernusSystem tracking (canShipReachSystem's own mustPassThroughSystemId parameter) — setting this brings Avernus's token along to the final destination, never into a home system. */
    relocateAvernusWithWarSun?: boolean;
    /** RR "Dominus Orb" (relic): "Before you move units during a tactical action, you may purge this card to move and transport units that are in systems that contain 1 of your command tokens" — bypasses the normal reachability/adjacency check entirely for any move whose fromSystemId has this player's own command token. Purges the relic (one-time), applies to the WHOLE tactical action's movement, not per-move. */
    useDominusOrb?: boolean;
  },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "RR 78: no tactical action in progress for this player." };
  }
  if (pending.step !== "movement") {
    return { ok: false, error: `RR 78: expected step "movement", tactical action is at "${pending.step}".` };
  }
  if (
    state.pendingPriorityWindow?.kind === "system_activated" ||
    state.pendingPriorityWindow?.kind === "after_system_activated" ||
    state.pendingPriorityWindow?.kind === "after_another_player_activates_system"
  ) {
    return { ok: false, error: "RR 1.16/1.19: this player must be given (and decline) their chance to play a system-activation card before moving ships." };
  }

  const player = state.players[action.playerId];
  const activeSystemId = pending.systemId;

  if (action.useDominusOrb && !player.relics.includes("dominus_orb" as never)) {
    return { ok: false, error: "This player doesn't have Dominus Orb." };
  }

  let workingState = state;
  if (action.useDominusOrb) {
    workingState = { ...workingState, players: { ...workingState.players, [action.playerId]: { ...player, relics: player.relics.filter((id) => id !== ("dominus_orb" as never)) } } };
  }
  let usedGravityDrive = false;
  let usedIonianFuelRefinery = false;
  // Muaat "Stellar Genesis" breakthrough ability: "after you move 1 of your war suns out of OR THROUGH Avernus's system and into a non-home system, you may move the Avernus token with it" — found once upfront (its system doesn't change mid-loop; the token itself only actually relocates once, after every move this action resolves), then checked per war-sun move below using canShipReachSystem's own mustPassThroughSystemId parameter (properly covers a war sun's move whose PATH crosses Avernus's system, not just one that starts there).
  let avernusSystemId: SystemId | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    if (system.planets.some((p) => p.planetId === ("avernus" as never) && p.controllerId === player.id)) {
      avernusSystemId = systemId as SystemId;
      break;
    }
  }
  let warSunPassedThroughAvernusSystem = false;
  // Letnev "Gravleash Maneuvers" (breakthrough): "your non-fighter ships' move values are equal to the highest move value amongst moving ships in the system they started in." Confirmed (yjmrobert.com/tirules/factions/f_letnev): (1) a ship boosted by an ability like Gravity Drive raises the others to match the BOOSTED value, not just its own printed one; (2) a present Fighter II's own move value counts too, even though fighters themselves aren't "non-fighter ships" and so never get raised by this ability themselves. Computed as a pre-pass here (BASE move values + Gravity Drive's own +1, the two contributors this project's own confirmed rulings call out) grouped by fromSystemId, since the main validation loop below processes one move at a time and wouldn't otherwise know about a DIFFERENT move's own value.
  const gravleashMaxMoveByOrigin = new Map<SystemId, number>();
  if (player.hasBreakthrough && player.factionId === ("letnev" as never)) {
    for (const move of action.moves) {
      const moveStats = getUnitStats(rules, player.factionId, move.unitType, player.unitUpgrades);
      if (moveStats?.move == null) continue;
      let ownValue = moveStats.move;
      if (action.gravityDriveBoostFromSystemId === move.fromSystemId && player.technologies.includes(asTechId("gravity_drive"))) ownValue += 1;
      const current = gravleashMaxMoveByOrigin.get(move.fromSystemId) ?? 0;
      if (ownValue > current) gravleashMaxMoveByOrigin.set(move.fromSystemId, ownValue);
    }
  }
  // RR 84.1: each move's own final effective move value (after Gravity Drive/Flank Speed/Ionian Fuel Refinery bonuses), kept around for the cargo-pickup pass-through check below — a cargo pickup at a mid-path hop is only legal if SOME ship making this move can actually reach that hop within its OWN move budget on the way to activeSystemId.
  const moveEffectiveValues: { fromSystemId: SystemId; unitType: import("../types/enums").UnitType; effectiveMove: number }[] = [];

  for (const move of action.moves) {
    if (move.fromSystemId === activeSystemId) continue; // already there, nothing to validate

    // RR 49.4 bullet: cannot move ships out of a system containing one of the player's own command tokens.
    if (player.commandTokens.onBoard.includes(move.fromSystemId)) {
      return {
        ok: false,
        error: `RR 49.4: cannot move ships out of ${move.fromSystemId} — it contains this player's own command token.`,
      };
    }

    const stats = getUnitStats(rules, player.factionId, move.unitType, player.unitUpgrades);
    if (!stats || stats.move === null) {
      return { ok: false, error: `${move.unitType} has no move value and cannot move.` };
    }

    // RR "Gravity Drive": +1 move value for whichever ONE moves-entry the
    // player picked (identified by fromSystemId), if they own the tech —
    // repeatable every tactical action, does NOT exhaust (confirmed: this
    // one is a plain passive-on-request bonus, unlike most other
    // technologies in this same "after you activate a system" family).
    let effectiveMove = stats.move;
    if (action.gravityDriveBoostFromSystemId === move.fromSystemId && !usedGravityDrive) {
      const techId = asTechId("gravity_drive");
      if (!player.technologies.includes(techId)) {
        return { ok: false, error: "This player doesn't own Gravity Drive." };
      }
      effectiveMove += 1;
      usedGravityDrive = true;
    }
    // "Flank Speed": +1 move value for EVERY one of this player's ships this tactical action (unlike Gravity Drive, not limited to one moves-entry).
    if (pending.flankSpeedPlayerId === action.playerId) {
      effectiveMove += 1;
    }
    // TE "Ionian Fuel Refinery" (Tempesta's own legendary planet ability): same "+1 to one specific moves-entry" shape as Gravity Drive, but exhausts the ability card instead of being a repeatable tech.
    if (action.ionianFuelRefineryBoostFromSystemId === move.fromSystemId && !usedIonianFuelRefinery) {
      const found = findControlledLegendaryPlanet(workingState, action.playerId, asPlanetId("tempesta"));
      if ("error" in found) return { ok: false, error: found.error };
      effectiveMove += 1;
      usedIonianFuelRefinery = true;
      workingState = exhaustLegendaryAbility(workingState, found.systemId, asPlanetId("tempesta"));
    }

    // Letnev "Gravleash Maneuvers": applied LAST (after Gravity Drive/Flank Speed/Ionian Fuel Refinery above), and only to non-fighter ships — a fighter's own move value is never raised by this ability, even though a Fighter II's OWN value is one of the things that can raise OTHER ships.
    if (move.unitType !== "fighter") {
      const gravleashMax = gravleashMaxMoveByOrigin.get(move.fromSystemId);
      if (gravleashMax !== undefined && gravleashMax > effectiveMove) effectiveMove = gravleashMax;
    }
    moveEffectiveValues.push({ fromSystemId: move.fromSystemId, unitType: move.unitType, effectiveMove });

    // RR "Dominus Orb" (relic): bypasses the reachability check entirely for this move if its source system has this player's own command token.
    const dominusOrbBypass = action.useDominusOrb && player.commandTokens.onBoard.includes(move.fromSystemId);
    if (
      !dominusOrbBypass &&
      !canShipReachSystem(workingState, player.id, move.fromSystemId, activeSystemId, effectiveMove, {
        ignoreAsteroidFields: player.technologies.includes(asTechId("antimass_deflectors")),
        // "In the Silence of Space": scoped to ships whose move ORIGINATES from the chosen system — Light Wave Deflector's own version below has no such scoping.
        ignoreEnemyFleets: player.technologies.includes(asTechId("light_wave_deflector")) || pending.passThroughEnemiesFromSystemId === move.fromSystemId,
        // "Nav Suite": ignores every anomaly effect (asteroid/supernova blocking, nebula's move clamp, even the gravity rift bonus — see canShipReachSystem's own doc comment on that last part) for this player's whole movement step.
        ignoreAllAnomalyEffects: pending.navSuiteActive && action.playerId === pending.playerId,
        // RR "Circlet of the Void" (relic): same asteroid/supernova/nebula bypass as Nav Suite, but explicitly KEEPS the gravity rift movement bonus (canShipReachSystem's own doc comment covers the distinction) — a standing passive effect, not gated on the relic being exhausted or not.
        circletOfTheVoidActive: player.relics.includes("circlet_of_the_void" as never),
      }, rules)
    ) {
      return {
        ok: false,
        error: `RR 58.4: ${move.unitType} at ${move.fromSystemId} cannot reach ${activeSystemId} (move value ${effectiveMove}) — blocked by an anomaly, an enemy fleet along the way, or simply out of range.`,
      };
    }

    // Muaat "Stellar Genesis": does THIS war sun's move have a valid path (within the same move value / techs it's actually using) that visits Avernus's system somewhere along the way — either as the literal origin, or as a mid-path hop?
    if (move.unitType === "war_sun" && avernusSystemId && !warSunPassedThroughAvernusSystem) {
      const passesThroughAvernus = canShipReachSystem(
        workingState,
        player.id,
        move.fromSystemId,
        activeSystemId,
        effectiveMove,
        {
          ignoreAsteroidFields: player.technologies.includes(asTechId("antimass_deflectors")),
          ignoreEnemyFleets: player.technologies.includes(asTechId("light_wave_deflector")) || pending.passThroughEnemiesFromSystemId === move.fromSystemId,
          ignoreAllAnomalyEffects: pending.navSuiteActive && action.playerId === pending.playerId,
          circletOfTheVoidActive: player.relics.includes("circlet_of_the_void" as never),
        },
        rules,
        avernusSystemId,
      );
      if (passesThroughAvernus) warSunPassedThroughAvernusSystem = true;
    }

    const originSystem = workingState.systems[move.fromSystemId];
    const originStack = originSystem?.spaceUnitsByPlayer[player.id]?.find((s) => s.unitType === move.unitType);
    if (!originStack || originStack.count < move.count) {
      return { ok: false, error: `Not enough ${move.unitType} at ${move.fromSystemId} to move ${move.count}.` };
    }

    workingState = removeFromSystem(workingState, move.fromSystemId, player.id, move.unitType, move.count);
    workingState = addToSystem(workingState, activeSystemId, player.id, move.unitType, move.count);
  }

  // Muaat "Stellar Genesis": actually relocate the Avernus token, if a war sun's path this action visited its system (either as the literal origin or a mid-path hop — see warSunPassedThroughAvernusSystem's own computation above) and the player chose to bring it along — never into a home system (matches the ability's own "into a non-home system" wording).
  if (warSunPassedThroughAvernusSystem && action.relocateAvernusWithWarSun && avernusSystemId) {
    if (Object.values(rules.homeSystemByFaction).includes(activeSystemId)) {
      return { ok: false, error: 'Muaat "Stellar Genesis": Avernus cannot be relocated into a home system.' };
    }
    const avernusPlanet = workingState.systems[avernusSystemId]?.planets.find((p) => p.planetId === ("avernus" as never) && p.controllerId === player.id);
    if (avernusPlanet) {
      const sourceSystem = workingState.systems[avernusSystemId];
      const destSystem = workingState.systems[activeSystemId];
      workingState = {
        ...workingState,
        systems: {
          ...workingState.systems,
          [avernusSystemId]: { ...sourceSystem, planets: sourceSystem.planets.filter((p) => p.planetId !== ("avernus" as never)) },
          [activeSystemId]: { ...destSystem, planets: [...destSystem.planets, avernusPlanet] },
        },
      };
    }
  }

  // RR 84.1 — cargo (ground forces + fighters) riding along with the
  // moving ships. Previously each cargo entry had to originate from the
  // SAME system as one of this action's own `moves` entries directly —
  // fixed to also allow picking up cargo at an intermediate hop mid-path,
  // by checking (via canShipReachSystem's own mustPassThroughSystemId
  // parameter, the same machinery Muaat's own Avernus relocation uses)
  // whether AT LEAST ONE of this action's moving ships has a path that
  // actually visits the cargo's own system on its way to activeSystemId,
  // within that specific ship's own effective move value. Capacity itself
  // (RR 16.3, total cargo can't exceed the combined capacity of the ships
  // making this move) IS enforced separately — see the check right after
  // this loop.
  // RR 84.1: cargo can only ever be carried by a ship that actually HAS
  // capacity (Carrier/Cruiser/Dreadnought/War Sun/etc., never a
  // Destroyer/Fighter, which are always 0) — so both the direct-origin
  // case and the pass-through case below need to filter down to moves
  // whose OWN unit type has capacity > 0, not just any move whatsoever.
  // Previously (both before and immediately after this project's own
  // pass-through fix) neither case actually checked this.
  const hasCapacity = (unitType: import("../types/enums").UnitType): boolean => {
    const stats = getUnitStats(rules, player.factionId, unitType, player.unitUpgrades);
    return (stats?.capacity ?? 0) > 0;
  };
  const capacityBearingMoves = moveEffectiveValues.filter((m) => hasCapacity(m.unitType));
  const cargoPickupReachable = (systemId: SystemId): boolean => {
    if (capacityBearingMoves.some((m) => m.fromSystemId === systemId)) return true;
    return capacityBearingMoves.some((m) =>
      canShipReachSystem(
        workingState,
        player.id,
        m.fromSystemId,
        activeSystemId,
        m.effectiveMove,
        {
          ignoreAsteroidFields: player.technologies.includes(asTechId("antimass_deflectors")),
          ignoreEnemyFleets: player.technologies.includes(asTechId("light_wave_deflector")) || pending.passThroughEnemiesFromSystemId === m.fromSystemId,
          ignoreAllAnomalyEffects: pending.navSuiteActive && action.playerId === pending.playerId,
          circletOfTheVoidActive: player.relics.includes("circlet_of_the_void" as never),
        },
        rules,
        systemId,
      ),
    );
  };

  for (const cargo of action.transportedGroundForces ?? []) {
    if (!cargoPickupReachable(cargo.fromSystemId)) {
      return {
        ok: false,
        error: `RR 84.1: transported ground forces must come from a system on the path of a ship this action is moving (no such ship's route passes through ${cargo.fromSystemId}).`,
      };
    }
    const originStack = workingState.systems[cargo.fromSystemId]?.spaceUnitsByPlayer[player.id]?.find(
      (s) => s.unitType === cargo.unitType,
    );
    if (!originStack || originStack.count < cargo.count) {
      return { ok: false, error: `Not enough ${cargo.unitType} at ${cargo.fromSystemId} to transport ${cargo.count}.` };
    }
    workingState = removeFromSystem(workingState, cargo.fromSystemId, player.id, cargo.unitType, cargo.count);
    workingState = addToSystem(workingState, activeSystemId, player.id, cargo.unitType, cargo.count);
  }

  for (const cargo of action.transportedFighters ?? []) {
    if (!cargoPickupReachable(cargo.fromSystemId)) {
      return {
        ok: false,
        error: `RR 84.1: transported fighters must come from a system on the path of a ship this action is moving (no such ship's route passes through ${cargo.fromSystemId}).`,
      };
    }
    const originStack = workingState.systems[cargo.fromSystemId]?.spaceUnitsByPlayer[player.id]?.find(
      (s) => s.unitType === "fighter",
    );
    if (!originStack || originStack.count < cargo.count) {
      return { ok: false, error: `Not enough fighters at ${cargo.fromSystemId} to transport ${cargo.count}.` };
    }
    workingState = removeFromSystem(workingState, cargo.fromSystemId, player.id, "fighter", cargo.count);
    workingState = addToSystem(workingState, activeSystemId, player.id, "fighter", cargo.count);
  }

  // RR 37.1/76.2: a player's non-fighter ships in ONE system can never
  // exceed the number of tokens in their own fleet pool — checked here
  // as an upfront validation against the system this move would leave
  // them in, rather than the reactive "choose and remove excess ships"
  // RR 37.3 describes; this project has no such pending-choice
  // infrastructure yet, and rejecting the move outright before any state
  // changes is the cleaner fit for MOVE_SHIPS specifically (unlike, say,
  // Warfare's own token redistribution shrinking the pool AFTER ships are
  // already parked there, which this check doesn't — and can't — cover).
  const nonFighterShipsAfterMove = (workingState.systems[activeSystemId]?.spaceUnitsByPlayer[player.id] ?? []).filter((s) => SHIP_TYPES.includes(s.unitType) && s.unitType !== "fighter").reduce((sum, s) => sum + s.count, 0);
  const maxNonFighterShips = getMaxNonFighterShips(player);
  if (nonFighterShipsAfterMove > maxNonFighterShips) {
    return { ok: false, error: `RR 37.1: this move would leave ${nonFighterShipsAfterMove} non-fighter ships in ${activeSystemId}, exceeding this player's fleet pool (${maxNonFighterShips}).` };
  }

  // RR 16.3: this player's combined fighters + ground forces sitting in
  // the active system's space area can never exceed the combined
  // capacity of all their OWN ships there — previously flagged as an
  // acknowledged gap right in this function's own header comment above;
  // implemented here the same way as the fleet-pool check just above it
  // (upfront rejection, not a reactive "choose which excess unit to
  // remove" prompt).
  const activeSystemStacksAfterMove = workingState.systems[activeSystemId]?.spaceUnitsByPlayer[player.id] ?? [];
  const totalCapacity = activeSystemStacksAfterMove.reduce((sum, s) => {
    if (s.count <= 0 || !SHIP_TYPES.includes(s.unitType)) return sum;
    const shipStats = getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades);
    return sum + (shipStats?.capacity ?? 0) * s.count;
  }, 0);
  const totalCargo = activeSystemStacksAfterMove.reduce((sum, s) => (s.unitType === "fighter" || GROUND_FORCE_TYPES.includes(s.unitType) ? sum + s.count : sum), 0);
  if (totalCargo > totalCapacity) {
    return { ok: false, error: `RR 16.3: this move would leave ${totalCargo} fighters/ground forces in ${activeSystemId}'s space area, exceeding this player's combined ship capacity there (${totalCapacity}).` };
  }

  // RR 78.2: after moving, ANY player with a qualifying PDS may use Space
  // Cannon Offense against the active player's ships before combat (RR
  // 77) — not just this player's own units, and not gated on whether
  // space combat will even happen (a lone PDS owner passing through with
  // no stake in this system can still fire). If nobody qualifies, skip
  // straight through to spaceCombat/invasion as before.
  // RR PoK "Wormhole Nexus": if this move just brought a ship there for the
  // first time, it flips active at the END of this step (not mid-move) —
  // hence doing this last, right before returning.
  workingState = maybeActivateWormholeNexus(workingState, rules, activeSystemId);
  // RR "Capture": ship movement is the only way blockade state can change
  // in this engine, so this is the natural place to auto-return any
  // captured non-fighter ship/mech whose original owner is now
  // blockading the capturing player's own space dock.
  workingState = maybeReturnCapturedUnitsOnBlockade(workingState);

  // TE "Rescue": "After another player moves ships into a system that
  // contains your ships" — checked right after movement resolves, before
  // Space Cannon Offense even begins (RR 1.19's own "after X" priority
  // windows resolve before the next scripted step), for every OTHER
  // player who already has ships in the just-activated system.
  const rescueEligible = Object.keys(workingState.systems[activeSystemId]?.spaceUnitsByPlayer ?? {})
    .filter((id) => id !== player.id && (workingState.systems[activeSystemId]?.spaceUnitsByPlayer[id as PlayerId] ?? []).some((s) => s.count > 0))
    .filter((id) => !workingState.players[id as PlayerId]?.eliminated) as PlayerId[];
  const rescueOrder = actionPhaseWindowOrder(workingState, player.id, rescueEligible);
  if (rescueOrder.length > 0) {
    workingState = { ...workingState, pendingPriorityWindow: { kind: "after_ships_moved_in", order: rescueOrder, currentIndex: 0, consecutivePasses: 0 } };
  }

  const spaceCannonResponders = getSpaceCannonOffenseEligiblePlayers(workingState, rules, activeSystemId, player.id);
  const willHaveCombat = playersWithShipsInSystem(workingState, activeSystemId).length > 1;

  workingState = {
    ...workingState,
    pendingTacticalAction:
      spaceCannonResponders.length > 0
        ? { ...pending, step: "spaceCannonOffense", spaceCannonOffenseRespondersRemaining: spaceCannonResponders }
        : willHaveCombat
          ? { ...pending, step: "spaceCombat", ...computeSpaceCombatEntry(workingState, rules, activeSystemId, player.id) }
          : { ...pending, step: "invasion" },
  };
  workingState = openInvasionStartWindowIfNeeded(openCombatRoundStartWindowIfNeeded(workingState));

  // TE SPACE STATIONS: check every system this move touched — the
  // destination (where a player could newly become the sole ship-owner)
  // and every origin (where departing ships could leave exactly 1 other
  // owner behind) — for a fresh sole-owner control gain. A no-op
  // wherever there's no space station planet, or no exactly-1-owner
  // situation.
  const touchedSystemIds = new Set([activeSystemId, ...action.moves.map((m) => m.fromSystemId)]);
  for (const touchedSystemId of touchedSystemIds) {
    workingState = resolveSpaceStationControl(workingState, touchedSystemId);
  }

  return {
    ok: true,
    state: workingState,
    events: [{ type: "SHIPS_MOVED", playerId: action.playerId, toSystemId: activeSystemId }],
  };
}

// --- helpers -------------------------------------------------------------

function removeFromSystem(
  state: GameState,
  systemId: SystemId,
  playerId: PlayerId,
  unitType: import("../types/enums").UnitType,
  count: number,
): GameState {
  const system = state.systems[systemId];
  const stacks = system.spaceUnitsByPlayer[playerId] ?? [];
  const updatedStacks = stacks
    .map((s) => (s.unitType === unitType ? { ...s, count: s.count - count } : s))
    .filter((s) => s.count > 0);

  const updatedSystem: SystemState = {
    ...system,
    spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [playerId]: updatedStacks },
  };
  return { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
}

function addToSystem(
  state: GameState,
  systemId: SystemId,
  playerId: PlayerId,
  unitType: import("../types/enums").UnitType,
  count: number,
): GameState {
  const system = state.systems[systemId];
  const stacks = system.spaceUnitsByPlayer[playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === unitType && !s.upgradeId);
  const updatedStacks = existing
    ? stacks.map((s) => (s === existing ? { ...s, count: s.count + count } : s))
    : [...stacks, { unitType, count, damagedCount: 0 }];

  const updatedSystem: SystemState = {
    ...system,
    spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [playerId]: updatedStacks },
  };
  return { ...state, systems: { ...state.systems, [systemId]: updatedSystem } };
}
