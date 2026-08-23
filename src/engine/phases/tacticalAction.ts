import { GameState, Player, SystemState } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, SystemId, asTechId, asPlanetId, asAbilityId } from "../types/ids";
import { hasAbility } from "../rules/abilities";
import { STRUCTURE_TYPES, SHIP_TYPES, GROUND_FORCE_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { canShipReachSystem } from "../rules/movement";
import { maybeActivateWormholeNexus } from "../rules/adjacency";
import { resolveSpaceStationControl } from "../rules/spaceStations";
import { usesCodex4Version } from "../rules/gameMode";
import { playersWithShipsInSystem, getSpaceCannonOffenseEligiblePlayers } from "../rules/combat";
import { maybeReturnCapturedUnitsOnBlockade } from "../rules/capture";
import { maybeDestroyBlockadedFloatingFactories } from "../rules/saar";
import { computeSpaceCombatEntry, openCombatRoundStartWindowIfNeeded } from "./spaceCombat";
import { openInvasionStartWindowIfNeeded } from "./invasion";
import { actionPhaseWindowOrder } from "../rules/priorityWindow";
import { findControlledLegendaryPlanet, exhaustLegendaryAbility } from "./legendaryPlanets";
import { getMaxNonFighterShips } from "../rules/letnev";
import { maybeReturnTradeConvoys } from "../rules/hacan";
import { maybeReturnStymie } from "../rules/arborec";
import { maybeReturnPromiseOfProtection, getMentakCruiserStats } from "../rules/mentak";
import { canMoveThroughSupernova } from "../rules/muaat";
import { hasGravityRift, getGravityRiftDestructionCheck } from "../rules/anomalies";

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
  /**
   * Naalu Collective "Z'eu Ω" (agent, Codex version): "ACTION: Exhaust
   * this card and choose a player; that player may perform a tactical
   * action in a non-home system without placing a command token; that
   * system still counts as being activated." Confirmed
   * (yjmrobert.com/tirules/factions/f_naalu): "all other rules applying
   * to tactical actions apply, other than placing a command token —
   * the system cannot already contain a command token for the
   * performing player" (checked below same as normal), "the chosen
   * player is considered the active player" (this parameter lets
   * rules/naalu.ts's own useZeuOmega bypass the normal `state.activePlayerId
   * !== action.playerId` check, since Z'eu Ω explicitly lets a
   * NON-active player act), and "counts for the purposes of returning
   * promissory notes and other similar effects" — achieved for free
   * since every OTHER trigger in this function below still runs exactly
   * as normal, only the token-placement/tactic-pool-deduction itself is
   * skipped.
   */
  skipCommandToken = false,
): ActionResult {
  if (state.phase !== "action") {
    return { ok: false, error: "RR 78: tactical actions only happen during the action phase." };
  }
  if (!skipCommandToken && state.activePlayerId !== action.playerId) {
    return { ok: false, error: "RR 4: it is not this player's turn." };
  }
  if (state.pendingTacticalAction) {
    return { ok: false, error: "A tactical action is already in progress; resolve it before activating a new system." };
  }

  const player = state.players[action.playerId];
  if (!skipCommandToken && player.hasPassed) {
    return { ok: false, error: "RR 3.3: this player has already passed for the action phase." };
  }
  if (!skipCommandToken && player.commandTokens.tactic <= 0) {
    return { ok: false, error: "RR 78.1: no command tokens remaining in tactic pool." };
  }
  if (player.commandTokens.onBoard.includes(action.systemId)) {
    return { ok: false, error: "RR 5.2: a player cannot activate a system that already contains one of his command tokens." };
  }
  if (skipCommandToken && rules.homeSystemByFaction[player.factionId] === action.systemId) {
    return { ok: false, error: "Z'eu Ω: cannot be used to activate this player's own home system." };
  }
  // Clan of Saar "Chaos Mapping" (faction tech): "Other players cannot
  // activate asteroid fields that contain 1 or more of your ships."
  // Confirmed (yjmrobert.com/tirules/factions/f_saar): "If an asteroid
  // field contains only non-ship units belonging to the Saar player, it
  // may still be activated by other players" — a Floating Factory alone
  // (unitType "space_dock", not in SHIP_TYPES) does NOT trigger this
  // block on its own; previously this checked "any unit at all" in the
  // space area, incorrectly including a lone Floating Factory. Checked
  // regardless of who owns Chaos Mapping among all OTHER players (a
  // system could in principle contain multiple different players' ships,
  // any one of whom owning this tech blocks activation by someone else).
  {
    const targetSystem = state.systems[action.systemId];
    const hasAsteroidField = targetSystem?.anomalies.includes("asteroid_field" as never) ?? false;
    if (hasAsteroidField) {
      const blockedBySaar = Object.values(state.players).some(
        (p) =>
          p.id !== action.playerId &&
          p.factionId === ("saar" as never) &&
          p.technologies.includes("chaos_mapping" as never) &&
          (targetSystem.spaceUnitsByPlayer[p.id] ?? []).some((s) => s.count > 0 && SHIP_TYPES.includes(s.unitType)),
      );
      if (blockedBySaar) {
        return { ok: false, error: "Clan of Saar \"Chaos Mapping\": this asteroid field contains their ships and cannot be activated by another player." };
      }
    }
  }

  const updatedPlayer: Player = skipCommandToken
    ? player
    : {
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

  // Jol-Nar "E-Res Siphons" (faction tech): "After another player
  // activates a system that contains 1 or more of your ships, gain 4
  // trade goods." Confirmed (tirules2.com/F_jol_nar): triggers
  // regardless of hostile intent — just presence — but ONLY for an
  // actual tactical-action system activation (not other ways a command
  // token could land in a system, like Diplomacy's own primary ability,
  // which never calls this function at all).
  let players = state.players;
  if (activatedSystem) {
    for (const [ownerId, stacks] of Object.entries(activatedSystem.spaceUnitsByPlayer)) {
      if (ownerId === action.playerId) continue;
      const ownerPlayer = players[ownerId as PlayerId];
      if (!ownerPlayer?.technologies.includes("e_res_siphons" as never)) continue;
      if (!(stacks ?? []).some((s) => s.count > 0)) continue;
      players = { ...players, [ownerId]: { ...ownerPlayer, tradeGoods: ownerPlayer.tradeGoods + 4 } };
    }
  }

  // Hacan "Trade Convoys" (promissory note): "if you [the activating player] activate a system that contains 1 or more of the Hacan player's units, return this card to the Hacan player." Confirmed (tirules2.com/F_hacan): returned even for a structures-only system (space dock/PDS, tracked on the PLANET side, not just ships in the system's own space area) — checked across BOTH.
  const activatedSystemHasHacanUnits = (() => {
    const hacanPlayerId = Object.values(players).find((p) => p.factionId === ("hacan" as never))?.id;
    if (!hacanPlayerId || !activatedSystem) return false;
    if ((activatedSystem.spaceUnitsByPlayer[hacanPlayerId] ?? []).some((s) => s.count > 0)) return true;
    return activatedSystem.planets.some((p) => (p.unitsByPlayer[hacanPlayerId] ?? []).some((s) => s.count > 0));
  })();
  players = maybeReturnTradeConvoys({ ...state, players }, action.playerId, activatedSystemHasHacanUnits).players;

  // Arborec "Stymie" (promissory note): same "returned on ANY activation of a system with the owner's own units" shape as Trade Convoys above — see rules/arborec.ts's own maybeReturnStymie for the full doc comment.
  const activatedSystemHasArborecUnits = (() => {
    const arborecPlayerId = Object.values(players).find((p) => p.factionId === ("arborec" as never))?.id;
    if (!arborecPlayerId || !activatedSystem) return false;
    if ((activatedSystem.spaceUnitsByPlayer[arborecPlayerId] ?? []).some((s) => s.count > 0)) return true;
    return activatedSystem.planets.some((p) => (p.unitsByPlayer[arborecPlayerId] ?? []).some((s) => s.count > 0));
  })();
  players = maybeReturnStymie({ ...state, players }, action.playerId, activatedSystemHasArborecUnits).players;

  // Mentak Coalition "Promise of Protection" (promissory note): same "returned on ANY activation of a system with the owner's own units" shape as Trade Convoys/Stymie above — see rules/mentak.ts's own maybeReturnPromiseOfProtection for the full doc comment.
  const activatedSystemHasMentakUnits = (() => {
    const mentakPlayerId = Object.values(players).find((p) => p.factionId === ("mentak" as never))?.id;
    if (!mentakPlayerId || !activatedSystem) return false;
    if ((activatedSystem.spaceUnitsByPlayer[mentakPlayerId] ?? []).some((s) => s.count > 0)) return true;
    return activatedSystem.planets.some((p) => (p.unitsByPlayer[mentakPlayerId] ?? []).some((s) => s.count > 0));
  })();
  players = maybeReturnPromiseOfProtection({ ...state, players }, action.playerId, activatedSystemHasMentakUnits).players;

  const nextState: GameState = {
    ...state,
    systems: systemsWithMagenDefenseGridInfantry,
    players: { ...players, [player.id]: updatedPlayer },
    pendingTacticalAction: {
      playerId: action.playerId,
      systemId: action.systemId,
      step: "movement",
      // Arborec "Duha Menaimon" (flagship): "the flagship must be in the system when it is activated for its effect to trigger — it will not trigger if it is moved into the active system later in the turn." Confirmed (yjmrobert.com/tirules/factions/f_arborec). Snapshotted right here, at activation, since this player's own units could change a lot before Production actually resolves.
      duhaMenaimonPresentAtActivation: (activatedSystem?.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "flagship" && s.count > 0) && players[action.playerId]?.factionId === ("arborec" as never),
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
    moves: { fromSystemId: SystemId; unitType: import("../types/enums").UnitType; count: number; passesThroughRiftSystemIds?: SystemId[] }[];
    transportedGroundForces?: { fromSystemId: SystemId; unitType: "infantry" | "mech"; count: number }[];
    transportedFighters?: { fromSystemId: SystemId; count: number }[];
    gravityDriveBoostFromSystemId?: SystemId;
    /** TE "Ionian Fuel Refinery" (Tempesta's own legendary planet ability): "exhaust this card after you activate a system to apply +1 to the move value of 1 of your ships during this tactical action" — same "identify the one moves-entry by its fromSystemId" shape as Gravity Drive above, but exhausts the legendary ability (once per its own ready cycle) rather than being a repeatable-every-turn tech. */
    ionianFuelRefineryBoostFromSystemId?: SystemId;
    /** Muaat "Stellar Genesis" breakthrough ability: if a war sun's own path this action visits Avernus's system — as its literal origin OR a mid-path hop, see this function's own warSunPassedThroughAvernusSystem tracking (canShipReachSystem's own mustPassThroughSystemId parameter) — setting this brings Avernus's token along to the final destination, never into a home system. */
    relocateAvernusWithWarSun?: boolean;
    /** RR "Dominus Orb" (relic): "Before you move units during a tactical action, you may purge this card to move and transport units that are in systems that contain 1 of your command tokens" — bypasses the normal reachability/adjacency check entirely for any move whose fromSystemId has this player's own command token. Purges the relic (one-time), applies to the WHOLE tactical action's movement, not per-move. */
    useDominusOrb?: boolean;
    /** RR "Gravity Rift" (anomaly): see types/Actions.ts's own doc comment on this same field for the full explanation — one entry per (fromSystemId, unitType, riftSystemId) combination that applies. */
    gravityRiftDieRolls?: { fromSystemId: SystemId; unitType: import("../types/enums").UnitType; riftSystemId: SystemId; rolls: number[] }[];
    /** RR "Gravity Rift", note 2 — see types/Actions.ts's own doc comment on this same field for the full explanation. */
    gravityRiftCargoAssignments?: {
      fromSystemId: SystemId;
      carrierUnitType: import("../types/enums").UnitType;
      cargo: { unitType: "fighter" | "infantry" | "mech"; countsPerShip: number[] }[];
    }[];
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
  // RR "Gravity Rift" (anomaly): keyed by `${fromSystemId}::${unitType}`, accumulating WHICH individual ship-indices (0..count-1) end up destroyed across every rift instance that move passes through — see this function's own applicableRiftSystemIds computation and where this map is consumed further below.
  const riftDestroyedIndicesByMove = new Map<string, Set<number>>();

  for (const move of action.moves) {
    if (move.fromSystemId === activeSystemId) continue; // already there, nothing to validate

    // RR 49.4 bullet: cannot move ships out of a system containing one of the player's own command tokens.
    if (player.commandTokens.onBoard.includes(move.fromSystemId)) {
      return {
        ok: false,
        error: `RR 49.4: cannot move ships out of ${move.fromSystemId} — it contains this player's own command token.`,
      };
    }

    // RR 89: "Fighters and infantry, unless otherwise specified, cannot
    // move through space without being transported" — must go through
    // action.transportedFighters instead. Confirmed against the actual
    // data: base Fighter has move: null (requires transport); Fighter
    // II (generic) and Naalu Collective's own Hybrid Crystal Fighter II
    // both have move: 2 printed directly (can move independently) —
    // Hybrid Crystal Fighter I, like the base fighter, has move: null.
    // The very next check below (stats.move === null) already
    // implements this exact distinction correctly for every fighter
    // variant uniformly — nothing extra needed here.

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
    // Clan of Saar "Captain Mendosa" (agent): the fixed override computed
    // at activation time — applied BEFORE Gravity Drive/Flank Speed/Ionian
    // Fuel Refinery below, so those still stack on top of it as normal
    // (see this field's own doc comment on GameState.ts for the confirmed
    // ruling on why).
    if (pending.mendosaMoveOverride?.unitType === move.unitType && pending.mendosaMoveOverride.fromSystemId === move.fromSystemId) {
      effectiveMove = pending.mendosaMoveOverride.moveValue;
    }
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
    // Ghosts of Creuss "SLIPSTREAM" (faction ability): "During your
    // tactical actions, apply +1 to the move value of each of your
    // ships that starts its movement in your home system or in a
    // system that contains either an alpha or beta wormhole."
    // Confirmed (yjmrobert.com/tirules/factions/f_creuss): "does NOT
    // apply to the Creuss Gate, to the Hil Colish, or to gamma
    // wormholes" — the Creuss Gate itself contains a DELTA wormhole
    // (not alpha/beta), so it's naturally excluded here without any
    // special Gate-detection needed; the Hil Colish is excluded via its
    // own unitType check.
    if (move.unitType !== "flagship" && player.factionId === ("creuss" as never) && hasAbility(player, asAbilityId("slipstream"))) {
      const originSystem = workingState.systems[move.fromSystemId];
      const isHomeSystem = rules.homeSystemByFaction[player.factionId] === move.fromSystemId;
      const hasAlphaOrBeta = originSystem?.wormholes.some((w) => w === "alpha" || w === "beta");
      if (isHomeSystem || hasAlphaOrBeta) {
        effectiveMove += 1;
      }
    }

    // Letnev "Gravleash Maneuvers": applied LAST (after Gravity Drive/Flank Speed/Ionian Fuel Refinery above), and only to non-fighter ships — a fighter's own move value is never raised by this ability, even though a Fighter II's OWN value is one of the things that can raise OTHER ships.
    if (move.unitType !== "fighter") {
      const gravleashMax = gravleashMaxMoveByOrigin.get(move.fromSystemId);
      if (gravleashMax !== undefined && gravleashMax > effectiveMove) effectiveMove = gravleashMax;
    }
    moveEffectiveValues.push({ fromSystemId: move.fromSystemId, unitType: move.unitType, effectiveMove });

    // RR "Dominus Orb" (relic): bypasses the reachability check entirely for this move if its source system has this player's own command token.
    const dominusOrbBypass = action.useDominusOrb && player.commandTokens.onBoard.includes(move.fromSystemId);
    const moveTechs = {
      ignoreAsteroidFields: player.technologies.includes(asTechId("antimass_deflectors")),
      // "In the Silence of Space": scoped to ships whose move ORIGINATES from the chosen system — Light Wave Deflector's own version below has no such scoping. Yssaril Tribes "Y'sia Y'ssrila" (flagship, "Move Through"): "this ship can move through systems that contain other players' ships" — confirmed (tirules2.com/F_yssaril) redundant with, and having NO additional effect alongside, this same player's own Light/Wave Deflector tech (both grant the identical bypass for this same unit, hence the OR below).
      ignoreEnemyFleets: player.technologies.includes(asTechId("light_wave_deflector")) || pending.passThroughEnemiesFromSystemId === move.fromSystemId || (move.unitType === "flagship" && player.factionId === ("yssaril" as never)),
      // "Nav Suite": ignores every anomaly effect (asteroid/supernova blocking, nebula's move clamp, even the gravity rift bonus — see canShipReachSystem's own doc comment on that last part) for this player's whole movement step.
      ignoreAllAnomalyEffects: pending.navSuiteActive && action.playerId === pending.playerId,
      // RR "Circlet of the Void" (relic): same asteroid/supernova/nebula bypass as Nav Suite, but explicitly KEEPS the gravity rift movement bonus (canShipReachSystem's own doc comment covers the distinction) — a standing passive effect, not gated on the relic being exhausted or not.
      circletOfTheVoidActive: player.relics.includes("circlet_of_the_void" as never),
      // Embers of Muaat "GASHLAI PHYSIOLOGY"/"Magmus Reactor" (either grants this): "your ships can move through/into supernovas" -- see rules/muaat.ts's own canMoveThroughSupernova.
      canMoveThroughSupernova: canMoveThroughSupernova(player),
      // Clan of Saar "Captain Mendosa": see canShipReachSystem's own doc comment on this flag — Mendosa's fixed override value beats Nebula's own clamp for this specific move.
      mendosaOverrideActive: pending.mendosaMoveOverride?.unitType === move.unitType && pending.mendosaMoveOverride.fromSystemId === move.fromSystemId,
    };
    if (
      !dominusOrbBypass &&
      !canShipReachSystem(workingState, player.id, move.fromSystemId, activeSystemId, effectiveMove, moveTechs, rules)
    ) {
      return {
        ok: false,
        error: `RR 58.4: ${move.unitType} at ${move.fromSystemId} cannot reach ${activeSystemId} (move value ${effectiveMove}) — blocked by an anomaly, an enemy fleet along the way, or simply out of range.`,
      };
    }

    // RR "Gravity Rift" (yjmrobert.com/tirules/rules/r_gravity_rift):
    // "For each ship that would move out of or through a gravity rift,
    // one die is rolled... on a result of 1-3, that ship is removed."
    // Every applicable rift instance for THIS move — its own origin (if
    // it has a rift) plus any declared, validated mid-path hops — is
    // processed here; the actual removal is applied further below, once
    // all movement has resolved (this file's own riftDestroyedIndices
    // accumulator).
    const originAnomalies = workingState.systems[move.fromSystemId]?.anomalies ?? [];
    const applicableRiftSystemIds: SystemId[] = [];
    if (hasGravityRift(originAnomalies)) applicableRiftSystemIds.push(move.fromSystemId);

    // Is passing through some OTHER (non-origin) rift actually MANDATORY
    // for this move — i.e. is there NO rift-free route within this same
    // move's own effective budget/techs — or is it a genuine, avoidable
    // choice? Computed by the engine itself (not merely trusted from the
    // caller's own passesThroughRiftSystemIds below), per the confirmed
    // requirement that the player must be asked/forced to declare a
    // mid-path rift whenever it's the ONLY way to make the trip, rather
    // than silently letting a caller omit it and skip the dice roll.
    const mandatoryMidPathRift = !dominusOrbBypass && !canShipReachSystem(workingState, player.id, move.fromSystemId, activeSystemId, effectiveMove, { ...moveTechs, forbidGravityRiftsBeyondOrigin: true }, rules);
    if (mandatoryMidPathRift && (move.passesThroughRiftSystemIds ?? []).length === 0) {
      return {
        ok: false,
        error: `RR "Gravity Rift": ${move.unitType} at ${move.fromSystemId} can only reach ${activeSystemId} by passing through a gravity rift somewhere along the way — declare which system via passesThroughRiftSystemIds (this player's route has no rift-free alternative of the same length).`,
      };
    }

    for (const waypointId of move.passesThroughRiftSystemIds ?? []) {
      if (waypointId === move.fromSystemId || waypointId === activeSystemId) continue; // already covered by the origin/destination-specific checks
      const waypointAnomalies = workingState.systems[waypointId]?.anomalies ?? [];
      if (!hasGravityRift(waypointAnomalies)) {
        return { ok: false, error: `RR "Gravity Rift": ${waypointId} doesn't actually contain a gravity rift.` };
      }
      // Confirmed reachable as an actual waypoint within this SAME move's own effective budget/techs — trusted as "plausible", same as this project's other caller-supplied path claims, since the literal path taken isn't otherwise tracked.
      const reachableAsWaypoint = canShipReachSystem(workingState, player.id, move.fromSystemId, activeSystemId, effectiveMove, moveTechs, rules, waypointId);
      if (!reachableAsWaypoint) {
        return { ok: false, error: `RR "Gravity Rift": ${move.unitType} at ${move.fromSystemId} has no valid path to ${activeSystemId} that actually visits ${waypointId} within its own move budget.` };
      }
      applicableRiftSystemIds.push(waypointId);
    }

    if (applicableRiftSystemIds.length > 0) {
      const moveKey = `${move.fromSystemId}::${move.unitType}`;
      const destroyedIndices = riftDestroyedIndicesByMove.get(moveKey) ?? new Set<number>();
      for (const riftSystemId of applicableRiftSystemIds) {
        const rollEntry = action.gravityRiftDieRolls?.find((r) => r.fromSystemId === move.fromSystemId && r.unitType === move.unitType && r.riftSystemId === riftSystemId);
        if (!rollEntry || rollEntry.rolls.length !== move.count) {
          return { ok: false, error: `RR "Gravity Rift": need exactly ${move.count} gravityRiftDieRolls for this player's ${move.unitType} from ${move.fromSystemId} passing through ${riftSystemId}.` };
        }
        const destroyOnRollLessOrEqual = getGravityRiftDestructionCheck(workingState.systems[riftSystemId]?.anomalies ?? [])?.destroyOnRollLessOrEqual ?? 3;
        rollEntry.rolls.forEach((roll, i) => {
          if (roll <= destroyOnRollLessOrEqual) destroyedIndices.add(i);
        });
      }
      riftDestroyedIndicesByMove.set(moveKey, destroyedIndices);
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
        // Embers of Muaat "GASHLAI PHYSIOLOGY"/"Magmus Reactor" (either grants this): "your ships can move through/into supernovas" -- see rules/muaat.ts's own canMoveThroughSupernova.
        canMoveThroughSupernova: canMoveThroughSupernova(player),
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

  // RR "Gravity Rift" (yjmrobert.com/tirules/rules/r_gravity_rift):
  // RR "Gravity Rift" (yjmrobert.com/tirules/rules/r_gravity_rift):
  // "one die is rolled immediately before it exits the gravity rift
  // system" / "a ship that is removed by a gravity rift will not count
  // toward the fleet limit in the destination system" — applied HERE,
  // right after every move places its units at activeSystemId but
  // BEFORE the fleet-pool/capacity checks further below, so a ship lost
  // to the rift correctly never counts against either limit. Previously
  // this had no implementation anywhere in the project at all (see this
  // file's own now-corrected comment near the Hil Colish/declaration-
  // order note, which used to cite this as a known gap) — and an
  // earlier draft of this exact fix mistakenly applied the destruction
  // AFTER those limit checks instead, which would have rejected some
  // legal moves outright (the pre-rift-loss count exceeding a limit the
  // post-loss count would have respected).
  //
  // Note 2 on that same rules page — "units being transported are
  // removed from the board if the ship transporting them is removed" —
  // is now handled too, via action.gravityRiftCargoAssignments' own
  // per-ship-index cargo declaration (see types/Actions.ts's own doc
  // comment on that field for the full explanation of why this needs an
  // explicit caller declaration rather than being inferred).
  if (riftDestroyedIndicesByMove.size > 0) {
    const destSystem = workingState.systems[activeSystemId];
    let destStacks = (destSystem.spaceUnitsByPlayer[player.id] ?? []).map((s) => ({ ...s }));
    const cargoLosses = new Map<string, number>();
    for (const [moveKey, destroyedIndices] of riftDestroyedIndicesByMove.entries()) {
      if (destroyedIndices.size === 0) continue;
      const [fromSystemId, unitType] = moveKey.split("::") as [SystemId, import("../types/enums").UnitType];
      const stack = destStacks.find((s) => s.unitType === unitType && s.count > 0);
      if (stack) {
        const destroyed = Math.min(destroyedIndices.size, stack.count);
        stack.count -= destroyed;
        if ((stack.damagedCount ?? 0) > stack.count) stack.damagedCount = stack.count;
      }
      const cargoAssignment = action.gravityRiftCargoAssignments?.find((a) => a.fromSystemId === fromSystemId && a.carrierUnitType === unitType);
      if (cargoAssignment) {
        for (const cargo of cargoAssignment.cargo) {
          let lost = 0;
          for (const i of destroyedIndices) lost += cargo.countsPerShip[i] ?? 0;
          if (lost > 0) cargoLosses.set(cargo.unitType, (cargoLosses.get(cargo.unitType) ?? 0) + lost);
        }
      }
    }
    for (const [cargoUnitType, lost] of cargoLosses.entries()) {
      const stack = destStacks.find((s) => s.unitType === cargoUnitType && s.count > 0);
      if (!stack) continue;
      const destroyed = Math.min(lost, stack.count);
      stack.count -= destroyed;
      if ((stack.damagedCount ?? 0) > stack.count) stack.damagedCount = stack.count;
    }
    destStacks = destStacks.filter((s) => s.count > 0);
    workingState = { ...workingState, systems: { ...workingState.systems, [activeSystemId]: { ...destSystem, spaceUnitsByPlayer: { ...destSystem.spaceUnitsByPlayer, [player.id]: destStacks } } } };
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
          ignoreEnemyFleets: player.technologies.includes(asTechId("light_wave_deflector")) || pending.passThroughEnemiesFromSystemId === m.fromSystemId || (m.unitType === "flagship" && player.factionId === ("yssaril" as never)),
          ignoreAllAnomalyEffects: pending.navSuiteActive && action.playerId === pending.playerId,
          circletOfTheVoidActive: player.relics.includes("circlet_of_the_void" as never),
        // Embers of Muaat "GASHLAI PHYSIOLOGY"/"Magmus Reactor" (either grants this): "your ships can move through/into supernovas" -- see rules/muaat.ts's own canMoveThroughSupernova.
        canMoveThroughSupernova: canMoveThroughSupernova(player),
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
    // Mentak Coalition "The Table's Grace"/Corsair: capacity 2, not Cruiser II's own 3 — see rules/mentak.ts's own getMentakCruiserStats.
    const shipStats = s.unitType === "cruiser" ? getMentakCruiserStats(rules, player) : getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades);
    return sum + (shipStats?.capacity ?? 0) * s.count;
  }, 0);
  const totalCargo = activeSystemStacksAfterMove.reduce((sum, s) => (s.unitType === "fighter" || GROUND_FORCE_TYPES.includes(s.unitType) ? sum + s.count : sum), 0);
  if (totalCargo > totalCapacity) {
    // Naalu Collective "Hybrid Crystal Fighter II" (Half Fleet Count):
    // "Each fighter in excess of your ships' capacity counts as 1/2 of
    // a ship against your fleet pool." Confirmed text
    // (data/factions/naalu.json). Rather than rejecting outright like
    // the general RR 16.3 case above, excess FIGHTERS specifically (not
    // ground forces — those still can't exceed capacity at all) are
    // allowed if this player's OWN fighter is this upgrade, folded into
    // the SAME fleet-pool check as non-fighter ships above, at a 0.5
    // rate each.
    const fighterStack = activeSystemStacksAfterMove.find((s) => s.unitType === "fighter");
    const fighterStats = getUnitStats(rules, player.factionId, "fighter", player.unitUpgrades);
    const hasHalfFleetCount = fighterStats?.abilities.includes("halfFleetCount" as never);
    const nonFighterCargo = activeSystemStacksAfterMove.reduce((sum, s) => (GROUND_FORCE_TYPES.includes(s.unitType) ? sum + s.count : sum), 0);
    if (!hasHalfFleetCount || nonFighterCargo > totalCapacity) {
      return { ok: false, error: `RR 16.3: this move would leave ${totalCargo} fighters/ground forces in ${activeSystemId}'s space area, exceeding this player's combined ship capacity there (${totalCapacity}).` };
    }
    const excessFighters = (fighterStack?.count ?? 0) - Math.max(0, totalCapacity - nonFighterCargo);
    const halfFleetCost = Math.ceil(excessFighters / 2);
    if (nonFighterShipsAfterMove + halfFleetCost > maxNonFighterShips) {
      return {
        ok: false,
        error: `RR 16.3/Half Fleet Count: ${excessFighters} excess fighters would need ${halfFleetCost} more fleet pool slots (at 1/2 each), putting this player over their own fleet pool of ${maxNonFighterShips}.`,
      };
    }
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

  // Ghosts of Creuss "Hil Colish" (flagship, delta wormhole): "This
  // ship's system contains a delta wormhole. During movement, this
  // ship may move before or after your other ships." Confirmed
  // (https://www.yjmrobert.com/tirules/factions/f_creuss/):
  //  - "The delta wormhole moves WITH the Hil Colish; it cannot move
  //    back to its origin system using its own delta wormhole" —
  //    IMPLEMENTED below via dynamic recomputation (not a static
  //    token): clear "delta" from wherever it previously tracked the
  //    ship, add it to wherever the ship is now.
  //  - "Does not generate a second Space Cannon Offense step" if moved
  //    separately from the rest of this player's fleet — IMPLEMENTED
  //    via pending.spaceCannonOffenseResolvedThisAction just above.
  //  - "A unit with Deep Space Cannon may produce hits in systems
  //    adjacent to that unit via the delta wormhole in Hil Colish's
  //    system" — CORRECTED from an earlier note here that wrongly
  //    called this "a faction ability not yet implemented": "Deep Space
  //    Cannon" isn't a distinct ability at all — it's the community's
  //    own nickname (used even by tirules2.com/yjmrobert.com) for PDS
  //    II's own printed Space Cannon "rangesToAdjacent" behavior, which
  //    IS already implemented (rules/combat.ts's own
  //    spaceCannonEntriesForPlayer). Since it already reads
  //    system.wormholes via getAdjacentSystems, and that now correctly
  //    includes "delta" for Hil Colish's own current system, this
  //    interaction is IMPLEMENTED, not a forward note. Separately, this
  //    same investigation also surfaced and fixed a real gap: that
  //    getAdjacentSystems call didn't thread forPlayerId at all, so
  //    Ghosts of Creuss's own QUANTUM ENTANGLEMENT never boosted their
  //    own Deep Space Cannon reach either (confirmed by community
  //    consensus — "you are Creuss and built [PDS II] on a planet
  //    that's on the same hex as a wormhole, thus threatening another
  //    three hexes because of your quantum entanglement") — now fixed
  //    there too.
  //  - KNOWN SCOPE LIMIT (declaration order + gravity rift): "The
  //    Creuss player must declare ALL ships that will be moving BEFORE
  //    they move the Hil Colish or their other ships... cannot wait to
  //    see the result of their other ships' gravity rift rolls before
  //    deciding to move the Hil Colish... if the Hil Colish is moved
  //    first and destroyed by a gravity rift, other declared ships that
  //    CAN still reach the destination must do so, even through that
  //    same gravity rift." This project's own moveShips is a single
  //    atomic call per invocation, with no "declare now, execute in 2
  //    batches later" structure, and (as already noted separately for
  //    Naalu's own Foresight) no gravity-rift-removal-roll mechanism
  //    exists anywhere in this project yet either. Modeling the full
  //    declare-then-execute sequencing here would need much deeper
  //    changes to the movement system than this pass covers — the
  //    CALLER is trusted to submit Hil Colish's own move (via a
  //    separate moveShips call, before or after the rest of the fleet)
  //    in a way that respects these ordering rules, same "trusted
  //    timing" convention used elsewhere in this project for similar
  //    gaps, rather than silently claiming this is fully enforced.
  if (player.factionId === ("creuss" as never)) {
    const previousDeltaSystemId = workingState.hilColishDeltaWormholeSystemId;
    if (previousDeltaSystemId && previousDeltaSystemId !== activeSystemId) {
      const prevSystem = workingState.systems[previousDeltaSystemId];
      const stillHasHilColishThere = (prevSystem?.spaceUnitsByPlayer[player.id] ?? []).some((s) => s.unitType === "flagship" && s.count > 0);
      if (prevSystem && !stillHasHilColishThere) {
        workingState = { ...workingState, systems: { ...workingState.systems, [previousDeltaSystemId]: { ...prevSystem, wormholes: prevSystem.wormholes.filter((w) => w !== "delta") } } };
      }
    }
    const hilColishNowHere = (workingState.systems[activeSystemId]?.spaceUnitsByPlayer[player.id] ?? []).some((s) => s.unitType === "flagship" && s.count > 0);
    if (hilColishNowHere) {
      const destSystem = workingState.systems[activeSystemId];
      if (!destSystem.wormholes.includes("delta")) {
        workingState = { ...workingState, systems: { ...workingState.systems, [activeSystemId]: { ...destSystem, wormholes: [...destSystem.wormholes, "delta"] } } };
      }
      workingState = { ...workingState, hilColishDeltaWormholeSystemId: activeSystemId };
    } else if (workingState.hilColishDeltaWormholeSystemId === previousDeltaSystemId) {
      workingState = { ...workingState, hilColishDeltaWormholeSystemId: undefined };
    }
  }

  // RR "Capture": ship movement is the only way blockade state can change
  // in this engine, so this is the natural place to auto-return any
  // captured non-fighter ship/mech whose original owner is now
  // blockading the capturing player's own space dock.
  workingState = maybeReturnCapturedUnitsOnBlockade(workingState);
  // Clan of Saar "Floating Factory": "If this unit is blockaded, it is
  // destroyed" — same "ship movement is the only way blockade state can
  // change" reasoning as the capture-return call directly above.
  workingState = maybeDestroyBlockadedFloatingFactories(workingState);

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

  // Ghosts of Creuss "Hil Colish": if this player already resolved (or
  // skipped) Space Cannon Offense earlier in THIS SAME tactical action
  // — i.e. they're moving the Hil Colish separately, before or after
  // their other ships, per that ship's own ability — don't trigger it
  // a second time; go straight to spaceCombat/invasion instead.
  const spaceCannonAlreadyResolved = pending.spaceCannonOffenseResolvedThisAction === true;
  const spaceCannonResponders = spaceCannonAlreadyResolved ? [] : getSpaceCannonOffenseEligiblePlayers(workingState, rules, activeSystemId, player.id);
  const willHaveCombat = playersWithShipsInSystem(workingState, activeSystemId).length > 1;

  workingState = {
    ...workingState,
    pendingTacticalAction:
      spaceCannonResponders.length > 0
        ? { ...pending, step: "spaceCannonOffense", spaceCannonOffenseRespondersRemaining: spaceCannonResponders, spaceCannonOffenseResolvedThisAction: true }
        : willHaveCombat
          ? { ...pending, step: "spaceCombat", spaceCannonOffenseResolvedThisAction: true, ...computeSpaceCombatEntry(workingState, rules, activeSystemId, player.id) }
          : { ...pending, step: "invasion", spaceCannonOffenseResolvedThisAction: true },
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
