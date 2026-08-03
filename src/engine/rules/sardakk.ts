import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, asLeaderId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { unlockCommander } from "./leaders";
import { isDemilitarizedZone } from "../phases/agendaEffects";
import { getAdjacentSystems } from "./adjacency";

function findSardakkPlayerId(state: GameState): PlayerId | undefined {
  return Object.values(state.players).find((p) => p.factionId === ("sardakk" as never))?.id;
}

/**
 * Sardakk N'orr "Tekklar Legion" (promissory note): "At the start of an
 * invasion combat: apply +1 to the result of each of your unit's combat
 * rolls during this combat. If your opponent is the N'orr player, apply
 * -1 to the result of each of their unit's combat rolls during this
 * combat. Then, return this card to the N'orr player." Confirmed
 * (tirules2.com/F_norr): does NOT affect AFB/Bombardment/Space Cannon —
 * see rules/combat.ts's own buildGroundCombatEntries, which is exactly
 * where this gets applied and where that scoping is automatic. Played
 * once for the WHOLE invasion combat (round 1 only — not per-round like
 * most other reroll/bonus abilities in this project), affecting every
 * round of that same combat.
 */
export function useTekklarLegion(state: GameState, action: { type: "USE_TEKKLAR_LEGION"; playerId: PlayerId }): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("sardakk_promissory" as never)) {
    return { ok: false, error: "This player doesn't have Tekklar Legion in hand." };
  }
  const sardakkPlayerId = findSardakkPlayerId(state);
  if (!sardakkPlayerId) return { ok: false, error: "No Sardakk N'orr player in this game." };
  const pending = state.pendingTacticalAction;
  if (!pending || pending.step !== "invasion" || pending.combatRound !== undefined) {
    return { ok: false, error: 'Tekklar Legion: only usable "at the start of an invasion combat", before its own round 1 begins.' };
  }
  if (pending.tekklarLegionHolderIdThisCombat) {
    return { ok: false, error: "Tekklar Legion has already been played for this combat." };
  }

  const sardakkPlayer = state.players[sardakkPlayerId];
  const nextState: GameState = {
    ...state,
    pendingTacticalAction: { ...pending, tekklarLegionHolderIdThisCombat: action.playerId },
    players: {
      ...state.players,
      [sardakkPlayerId]: { ...sardakkPlayer, promissoryNotesInHand: [...sardakkPlayer.promissoryNotesInHand, "sardakk_promissory" as never] },
      [action.playerId]: { ...player, promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("sardakk_promissory" as never)) },
    },
  };
  return { ok: true, state: nextState, events: [] };
}

/**
 * Sardakk N'orr "Exotrireme II" (dreadnought upgrade, Self Destruct):
 * "After a round of space combat, you may destroy this unit to destroy
 * up to 2 ships in this system." Confirmed (tirules2.com/F_norr):
 *  - The N'orr player chooses which ships are destroyed — never their
 *    own (this action's own targets list is validated against the
 *    OPPONENT's own ships specifically).
 *  - Sustain Damage cannot prevent this destruction — bypasses the
 *    normal hit-assignment/flip mechanic entirely, these targets are
 *    just removed outright.
 *  - If the target player has already retreated (no longer present in
 *    this system), this naturally can't target them — enforced simply
 *    by requiring the targets to actually still be present here.
 */
export function useExotriremeIISelfDestruct(
  state: GameState,
  action: { type: "USE_EXOTRIREME_II_SELF_DESTRUCT"; playerId: PlayerId; systemId: SystemId; targets: { playerId: PlayerId; unitType: import("../types/enums").UnitType; count: number }[] },
): ActionResult {
  const player = state.players[action.playerId];
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  const ownStacks = system.spaceUnitsByPlayer[action.playerId] ?? [];
  const exoStack = ownStacks.find((s) => s.unitType === "dreadnought" && s.upgradeId === ("exotrireme_ii" as never) && s.count > 0);
  if (!exoStack) return { ok: false, error: "This player has no Exotrireme II in that system." };

  const totalTargeted = action.targets.reduce((sum, t) => sum + t.count, 0);
  if (totalTargeted > 2) return { ok: false, error: "Can destroy at most 2 ships with Self Destruct." };
  if (action.targets.some((t) => t.playerId === action.playerId)) {
    return { ok: false, error: "Cannot target this player's own ships with Self Destruct." };
  }

  let systems = state.systems;
  for (const target of action.targets) {
    const targetSystem = systems[action.systemId];
    const targetStacks = targetSystem.spaceUnitsByPlayer[target.playerId] ?? [];
    const targetStack = targetStacks.find((s) => s.unitType === target.unitType);
    if (!targetStack || targetStack.count < target.count) {
      return { ok: false, error: `Target player doesn't have ${target.count} ${target.unitType}(s) in that system.` };
    }
    const updatedTargetStacks = targetStacks.map((s) => (s.unitType === target.unitType ? { ...s, count: s.count - target.count } : s)).filter((s) => s.count > 0);
    systems = { ...systems, [action.systemId]: { ...targetSystem, spaceUnitsByPlayer: { ...targetSystem.spaceUnitsByPlayer, [target.playerId]: updatedTargetStacks } } };
  }

  const finalSystem = systems[action.systemId];
  const updatedOwnStacks = (finalSystem.spaceUnitsByPlayer[action.playerId] ?? []).map((s) => (s === exoStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  systems = { ...systems, [action.systemId]: { ...finalSystem, spaceUnitsByPlayer: { ...finalSystem.spaceUnitsByPlayer, [action.playerId]: updatedOwnStacks } } };

  const events: GameEvent[] = [{ type: "UNITS_DESTROYED", playerId: action.playerId, systemId: action.systemId, unitType: "dreadnought", count: 1 }];
  for (const target of action.targets) {
    events.push({ type: "UNITS_DESTROYED", playerId: target.playerId, systemId: action.systemId, unitType: target.unitType, count: target.count });
  }
  return { ok: true, state: { ...state, systems }, events };
}

/**
 * Sardakk N'orr "T'ro" (agent): "At the end of a player's tactical
 * action: You may exhaust this card; if you do, that player may place 2
 * infantry from their reinforcements on a planet they control in the
 * active system." A genuinely 2-party choice — N'orr decides whether to
 * offer it, and the target player separately decides whether to accept
 * — bundled into this single action (the target player's own choice is
 * simply "did they pass a targetPlanetId or not").
 */
export function useTro(
  state: GameState,
  action: { type: "USE_TRO"; playerId: PlayerId; targetPlanetId?: PlanetId },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const agentEntry = player.leaders.find((l) => l.leaderId === ("sardakk_agent" as never));
  if (!agentEntry) return { ok: false, error: "This player doesn't have T'ro." };
  if (agentEntry.exhausted) return { ok: false, error: "T'ro is already exhausted." };

  const last = state.lastCompletedTacticalAction;
  if (!last) return { ok: false, error: "T'ro: no tactical action has just ended." };

  let nextState: GameState = { ...state, players: { ...state.players, [action.playerId]: { ...player, leaders: player.leaders.map((l) => (l.leaderId === ("sardakk_agent" as never) ? { ...l, exhausted: true } : l)) } } };
  const events: GameEvent[] = [];

  if (action.targetPlanetId) {
    let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
    for (const [systemId, system] of Object.entries(nextState.systems)) {
      if (systemId !== last.systemId) continue;
      const planet = system.planets.find((p) => p.planetId === action.targetPlanetId);
      if (planet) {
        found = { systemId: systemId as SystemId, system, planet };
        break;
      }
    }
    if (!found || found.planet.controllerId !== last.playerId) {
      return { ok: false, error: "That player doesn't control that planet in the active system." };
    }
    const stacks = found.planet.unitsByPlayer[last.playerId] ?? [];
    const existing = stacks.find((s) => s.unitType === "infantry");
    const updatedStacks = existing ? stacks.map((s) => (s.unitType === "infantry" ? { ...s, count: s.count + 2 } : s)) : [...stacks, { unitType: "infantry" as const, count: 2, damagedCount: 0 }];
    const updatedPlanet: PlanetState = { ...found.planet, unitsByPlayer: { ...found.planet.unitsByPlayer, [last.playerId]: updatedStacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)) } } };
    events.push({ type: "UNITS_PRODUCED", playerId: last.playerId, systemId: found.systemId, planetId: action.targetPlanetId, unitType: "infantry", count: 2, totalCost: 0 });
  }

  return { ok: true, state: nextState, events };
}

/**
 * Sardakk N'orr "N'orr Supremacy" (Breakthrough ability): "After you win
 * a combat, either gain 1 command token or research a unit upgrade
 * technology." Confirmed (tirules2.com/F_norr): "the N'orr player must
 * meet the prerequisites of the unit upgrade technology they research"
 * — a normal "research" (respecting prerequisites/synergy), not a "gain"
 * that bypasses them, unlike some other breakthrough/relic sources of
 * free technology elsewhere in this project. Since that half is
 * therefore just this project's own ordinary RESEARCH_UNIT_UPGRADE
 * action with nothing special to add, THIS function only ever handles
 * the OTHER choice (gaining a command token) — a player choosing to
 * research instead simply submits that normal action directly.
 *
 * KNOWN SIMPLIFICATION: this project has no generic "you just won a
 * combat" event hook threaded through every combat-resolution path yet
 * — the caller is trusted to only submit this right after an actual
 * combat win of their own, same category as other "immediately after X"
 * simplifications already accepted elsewhere in this project (Rear
 * Admiral Farran's own Sustain Damage trigger, for one).
 */
export function useNorrSupremacy(
  state: GameState,
  action: { type: "USE_NORR_SUPREMACY"; playerId: PlayerId; commandTokenPool: "tactic" | "fleet" | "strategy" },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player.hasBreakthrough || player.factionId !== ("sardakk" as never)) {
    return { ok: false, error: "This player doesn't have N'orr Supremacy." };
  }
  const { tactic, fleet, strategy, onBoard } = player.commandTokens;
  if (tactic + fleet + strategy + onBoard.length >= 16) {
    return { ok: false, error: "This player already has all 16 of their command tokens in play." };
  }
  const updatedPlayer: Player = { ...player, commandTokens: { ...player.commandTokens, [action.commandTokenPool]: player.commandTokens[action.commandTokenPool] + 1 } };
  return { ok: true, state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } }, events: [] };
}

/**
 * Sardakk N'orr "G'hom Sek'kus" (commander): "During the 'Commit Ground
 * Forces' step: You can commit up to 1 ground force from each planet in
 * the active system and each planet in adjacent systems that do not
 * contain 1 of your command tokens." Unlock: "Control 5 planets in
 * non-home systems." Confirmed rulings (tirules2.com/F_norr) implemented
 * here:
 *  1. Planets in an ELIMINATED player's own home system don't count
 *     toward this unlock — checked via rules.planets[...].homeFactionId
 *     being set at all (regardless of whether that faction is currently
 *     eliminated or even still in the game).
 *  2. Works even with NO ships of this player's own in the active
 *     system — this function never checks for that at all.
 *  4. Up to 1 GF per ELIGIBLE PLANET, per invasion-step call — the
 *     caller lists 1 source planet per entry; nothing stops them from
 *     calling this again for a DIFFERENT target planet in the same
 *     tactical action, each time drawing fresh from every eligible
 *     source (this project doesn't track "already used THIS source for
 *     THIS target" separately, since re-submitting the SAME source
 *     planet a second time would already fail on "not enough units
 *     left there").
 *  5. Only the active player (pending.playerId) may use this — checked.
 *  9. Works regardless of who (if anyone) controls the target planet —
 *     no controller check here at all.
 * 12. Demilitarized Zone exclusion on the TARGET planet — checked.
 *
 * KNOWN SIMPLIFICATIONS (flagged, not silently skipped): ruling 8's own
 * "must legally be able to move into the destination system" is
 * approximated as plain adjacency (source = active system or directly
 * adjacent) without a full anomaly/wormhole path-legality check per
 * source system, EXCEPT the one sub-point this project can already
 * check cheaply — "Enforced Travel Ban" blocking wormhole-only adjacency
 * — which IS enforced (getAdjacentSystems already excludes wormhole
 * links when that law is active). NOT enforced: gravity-rift removal
 * rolls for forces sourced from a rift system, the Mirage-specific
 * asteroid-field/supernova exclusions, and the Ceasefire/Dominus Orb/
 * Parley interactions (each a narrow edge case tied to mechanics —
 * other promissory notes, a specific relic, a specific special planet —
 * this pass didn't chase down).
 */
export function useGhomSekkus(
  state: GameState,
  action: {
    type: "USE_GHOM_SEKKUS";
    playerId: PlayerId;
    targetPlanetId: PlanetId;
    sources: { planetId: PlanetId; unitType: "infantry" | "mech" }[];
  },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const commanderEntry = player.leaders.find((l) => l.leaderId === ("sardakk_commander" as never));
  if (!commanderEntry) return { ok: false, error: "This player doesn't have G'hom Sek'kus." };

  let workingState = state;
  if (commanderEntry.locked) {
    // Ruling 1: an eliminated player's own home-system planets don't count.
    const nonHomeControlledCount = Object.values(state.systems)
      .flatMap((sys) => sys.planets)
      .filter((p) => p.controllerId === action.playerId && !rules.planets[p.planetId]?.homeFactionId).length;
    if (nonHomeControlledCount < 5) return { ok: false, error: "This player doesn't have an unlocked G'hom Sek'kus." };
    workingState = { ...state, players: { ...state.players, [action.playerId]: unlockCommander(player, asLeaderId("sardakk_commander")) } };
  }

  const pending = workingState.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId || pending.step !== "invasion") {
    return { ok: false, error: "G'hom Sek'kus: only usable during this player's own Commit Ground Forces step, as the active player." };
  }
  const activeSystemId = pending.systemId;
  const activeSystem = workingState.systems[activeSystemId];
  const targetPlanet = activeSystem?.planets.find((p) => p.planetId === action.targetPlanetId);
  if (!targetPlanet) return { ok: false, error: `${action.targetPlanetId} isn't in the active system.` };
  if (isDemilitarizedZone(targetPlanet)) return { ok: false, error: 'RR "Demilitarized Zone": units cannot land on this planet.' };

  const adjacentSystemIds = new Set(getAdjacentSystems(workingState, activeSystemId, rules));
  const eligibleSystemIds = new Set([activeSystemId, ...adjacentSystemIds]);

  let systems = workingState.systems;
  const events: GameEvent[] = [];
  for (const source of action.sources) {
    let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
    for (const [systemId, system] of Object.entries(systems)) {
      const planet = system.planets.find((p) => p.planetId === source.planetId);
      if (planet) {
        found = { systemId: systemId as SystemId, system, planet };
        break;
      }
    }
    if (!found) return { ok: false, error: `No planet ${source.planetId}.` };
    if (!eligibleSystemIds.has(found.systemId)) {
      return { ok: false, error: `${source.planetId} isn't in the active system or an adjacent one.` };
    }
    if (found.systemId !== activeSystemId && player.commandTokens.onBoard.includes(found.systemId)) {
      return { ok: false, error: `${found.systemId} contains this player's own command token — cannot source ground forces from it.` };
    }
    const stack = (found.planet.unitsByPlayer[action.playerId] ?? []).find((s) => s.unitType === source.unitType && s.count > 0);
    if (!stack) return { ok: false, error: `This player has no ${source.unitType} on ${source.planetId}.` };

    const updatedSourcePlanet: PlanetState = {
      ...found.planet,
      unitsByPlayer: { ...found.planet.unitsByPlayer, [action.playerId]: (found.planet.unitsByPlayer[action.playerId] ?? []).map((s) => (s === stack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0) },
    };
    systems = { ...systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === source.planetId ? updatedSourcePlanet : p)) } };

    const currentTargetPlanet = systems[activeSystemId].planets.find((p) => p.planetId === action.targetPlanetId)!;
    const targetStacks = currentTargetPlanet.unitsByPlayer[action.playerId] ?? [];
    const existing = targetStacks.find((s) => s.unitType === source.unitType);
    const updatedTargetStacks = existing ? targetStacks.map((s) => (s.unitType === source.unitType ? { ...s, count: s.count + 1 } : s)) : [...targetStacks, { unitType: source.unitType, count: 1, damagedCount: 0 }];
    const updatedTargetPlanet: PlanetState = { ...currentTargetPlanet, unitsByPlayer: { ...currentTargetPlanet.unitsByPlayer, [action.playerId]: updatedTargetStacks } };
    systems = { ...systems, [activeSystemId]: { ...systems[activeSystemId], planets: systems[activeSystemId].planets.map((p) => (p.planetId === action.targetPlanetId ? updatedTargetPlanet : p)) } };

    events.push({ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: activeSystemId, planetId: action.targetPlanetId, unitType: source.unitType, count: 1, totalCost: 0 });
  }

  return { ok: true, state: { ...workingState, systems }, events };
}

/**
 * Sardakk N'orr "Sh'val, Harbinger — TEKKLAR CONDITIONING" (hero):
 * "After you move ships into the active system: You may skip directly
 * to the 'Commit Ground Forces' step." Confirmed (tirules2.com/F_norr):
 * (2) Space Cannon Offense, Space Combat, AND Bombardment are ALL
 * skipped entirely — not just one of them; (3) Space Cannon DEFENSE
 * still applies normally against whatever gets committed afterward
 * (nothing special needed here, since this just transitions straight
 * into the SAME "invasion" step every other path already uses, and that
 * step's own existing Space Cannon Defense logic doesn't care how it
 * got there); (4) "after you move ships..." reactive abilities can't
 * trigger following this — this project has no such generic hook
 * threaded through movement yet to explicitly suppress, but skipping
 * straight past the steps where such abilities would normally get
 * offered a window already achieves the same practical effect for
 * every window this project actually opens after movement.
 *
 * The actual purge-and-return-ships-to-reinforcements half is handled
 * separately, once commits actually finish — see phases/invasion.ts's
 * own finishInvasionCommits.
 */
export function useShvalHarbinger(state: GameState, action: { type: "USE_SHVAL_HARBINGER"; playerId: PlayerId } ): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player.leaders.find((l) => l.leaderId === ("sardakk_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Sh'val, Harbinger." };

  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) return { ok: false, error: "No tactical action in progress for this player." };
  if (pending.step !== "spaceCannonOffense" && pending.step !== "spaceCombat" && pending.step !== "invasion") {
    return { ok: false, error: "Sh'val, Harbinger is only usable right after moving ships into the active system." };
  }

  const nextState: GameState = {
    ...state,
    pendingTacticalAction: { playerId: pending.playerId, systemId: pending.systemId, step: "invasion", shvalHarbingerActive: true },
  };
  return { ok: true, state: nextState, events: [] };
}
