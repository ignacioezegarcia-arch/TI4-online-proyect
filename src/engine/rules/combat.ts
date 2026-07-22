import { GameState, Player, PlanetState, UnitStack } from "../types/GameState";
import { PlayerId, SystemId, FactionId, UnitUpgradeId, AgendaId, asTechId } from "../types/ids";
import { GROUND_FORCE_TYPES, SHIP_TYPES, UnitType } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { getDefenderCombatBonus } from "./anomalies";
import { getAdjacentSystems } from "./adjacency";
import { usesCodex4Version } from "./gameMode";
import { getEffectiveUnitAbilities, getLawOwner } from "../phases/agendaEffects";

/**
 * RR 61 (space combat) / RR 38 (ground combat) — presence queries.
 *
 * Ported from the original class-based src/engine/combatAreas.js
 * (SpaceArea/GroundArea). Most of that file's actual job is now done by
 * GameState's plain data shape directly — SystemState.spaceUnitsByPlayer and
 * PlanetState.unitsByPlayer already ARE the "who has units here" map that
 * SpaceArea/GroundArea used to wrap in a class. These are the two presence
 * queries still worth having as named, shared functions rather than
 * re-writing the same filter/reduce at every call site.
 */

/** Players with at least one ship (any type, including fighters) in this system's space area. */
export function playersWithShipsInSystem(state: GameState, systemId: SystemId): PlayerId[] {
  const system = state.systems[systemId];
  if (!system) return [];
  return Object.entries(system.spaceUnitsByPlayer)
    .filter(([, stacks]) => (stacks as UnitStack[]).some((s) => s.count > 0))
    .map(([playerId]) => playerId as PlayerId);
}

/** RR 78.3: space combat happens once movement resolves if 2+ players have ships in the active system. */
export function hasSpaceCombat(state: GameState, systemId: SystemId): boolean {
  return playersWithShipsInSystem(state, systemId).length > 1;
}

/** Players with at least one ground force (infantry/mech — NOT pds/space_dock, RR 38.1) on this planet. */
export function playersWithGroundForces(planet: PlanetState): PlayerId[] {
  return Object.entries(planet.unitsByPlayer)
    .filter(([, stacks]) => (stacks as UnitStack[] | undefined ?? []).some((s) => GROUND_FORCE_TYPES.includes(s.unitType) && s.count > 0))
    .map(([playerId]) => playerId as PlayerId);
}

/** RR 44.4 / 38: ground combat happens on a planet if 2+ players have ground forces there once the Invasion step's "commit ground forces" is done. */
export function hasGroundCombat(planet: PlanetState): boolean {
  return playersWithGroundForces(planet).length > 1;
}

// ---------------------------------------------------------------------
// RR 67 (space combat) / RR 38 (ground combat) — dice resolution.
//
// Both use the exact same mechanic (each unit rolls `combatDiceCount` dice,
// a result >= its combat value is a hit), so one generic function serves
// both instead of writing it twice.
//
// RNG NOTE: this engine's reducer (GameEngine.applyAction) is pure — it
// never calls Math.random() itself. Dice are rolled by whichever trusted
// context applies the action (the Supabase Edge Function, using its own
// secure RNG) and handed in as already-rolled numbers via the action's
// `diceRolls` field. The client can roll its own numbers locally to render
// an instant "you rolled..." animation, but the Edge Function's numbers are
// the ones that actually get persisted — same optimistic-then-reconciled
// pattern as the rest of this architecture, just not silently pretending
// the client's guess is authoritative for something a client could bias in
// its own favor.
// ---------------------------------------------------------------------

/** One player's dice pool for one group of same-type units in a combat round. */
export interface CombatUnitEntry {
  playerId: PlayerId;
  /** Total dice this entry rolls (already = count * combatDiceCount for the stack). */
  diceCount: number;
  /** Effective threshold AFTER modifiers (e.g. Nebula's defender bonus already subtracted) — a die result >= this scores a hit. */
  hitOn: number;
  /** RR "The Crown of Thalnos": which unit type this entry's dice belong to — every entry built by buildSpaceCombatEntries/buildGroundCombatEntries already corresponds to exactly ONE (player, unitType) pair (stacks are already split by type), so this is populated there. Optional/undefined for entries where per-type tracking doesn't matter (bombardment, Space Cannon, AFB — none of those are ever rerollable). */
  unitType?: UnitType;
}

export interface CombatRoundResult {
  /** Hits *scored by* each player's units this round (i.e. what that player did to their opponent(s) — the caller decides who those hits land on). */
  hitsScoredByPlayer: Partial<Record<PlayerId, number>>;
  /** RR "The Crown of Thalnos": how many of THIS player's OWN dice, per unit type, did NOT score a hit this round — needed so its owner can choose how many of a given type to reroll afterward. Only populated for entries that carried a `unitType` (i.e. normal space/ground combat dice). */
  missedDiceByPlayerAndType: Partial<Record<PlayerId, Partial<Record<UnitType, number>>>>;
}

export function resolveCombatRound(entries: CombatUnitEntry[], diceRolls: number[]): CombatRoundResult {
  const totalDice = entries.reduce((sum, e) => sum + e.diceCount, 0);
  if (diceRolls.length !== totalDice) {
    throw new Error(`RR 67.5/38.1: se esperaban ${totalDice} dados para esta ronda, llegaron ${diceRolls.length}.`);
  }

  const hitsScoredByPlayer: Partial<Record<PlayerId, number>> = {};
  const missedDiceByPlayerAndType: Partial<Record<PlayerId, Partial<Record<UnitType, number>>>> = {};
  let i = 0;
  for (const entry of entries) {
    for (let d = 0; d < entry.diceCount; d++) {
      const roll = diceRolls[i++];
      if (roll >= entry.hitOn) {
        hitsScoredByPlayer[entry.playerId] = (hitsScoredByPlayer[entry.playerId] ?? 0) + 1;
      } else if (entry.unitType) {
        const byType = missedDiceByPlayerAndType[entry.playerId] ?? {};
        byType[entry.unitType] = (byType[entry.unitType] ?? 0) + 1;
        missedDiceByPlayerAndType[entry.playerId] = byType;
      }
    }
  }
  return { hitsScoredByPlayer, missedDiceByPlayerAndType };
}

/**
 * Builds this round's dice-pool entries for a system's SPACE combat.
 * Restricted to exactly 2 players in the system for now — TI4 does allow
 * 3+ players' ships to end up in the same system in rare cases, and the
 * rulebook has the active player choose one opponent to resolve against
 * first; that choice isn't modeled yet, so this throws rather than silently
 * picking one for you.
 *
 * NOT accounted for yet, flagged rather than silently wrong:
 *  - Anti-Fighter Barrage's separate pre-round dice pool (RR 67.1, round 1
 *    only, fighters only) — a unit's *normal* combat dice (this function)
 *    fire every round regardless.
 *  - Anything from action cards, technologies, or faction/leader abilities
 *    that modifies combat: extra dice (e.g. Jol-Nar's Spektral tech gear),
 *    reroll effects (Fighter Prototype), per-roll +/-1 modifiers (Sardakk
 *    N'orr's Unrelenting, Morale Boost), or hit prevention (Fragile /
 *    Wormhole Generator-adjacent tricks) — none of this exists yet. This
 *    function only computes each unit's *base sheet* combat value and dice
 *    count. Same deliberate scope cut as the ~300 action/agenda/objective
 *    cards (see project plan: incremental, per phase) — applies here too,
 *    not just to standalone card effects. The natural hook point when that
 *    work starts: a modifiers list passed into this function that adjusts
 *    `hitOn`/`diceCount` per entry before dice are rolled, rather than
 *    reworking resolveCombatRound itself.
 */
export function buildSpaceCombatEntries(
  state: GameState,
  rules: RuleData,
  systemId: SystemId,
  activePlayerId: PlayerId,
): CombatUnitEntry[] {
  const system = state.systems[systemId];
  if (!system) return [];

  const playerIds = playersWithShipsInSystem(state, systemId);
  if (playerIds.length !== 2) {
    throw new Error(
      `RR 67: se esperan exactamente 2 jugadores en combate espacial en ${systemId}, hay ${playerIds.length}. Combates de 3+ bandos no están soportados todavía.`,
    );
  }

  const anomalyBonus = getDefenderCombatBonus(system.anomalies); // RR 9 Nebula: +1 to defenders' rolls
  const entries: CombatUnitEntry[] = [];

  for (const playerId of playerIds) {
    const isDefender = playerId !== activePlayerId;
    const player = state.players[playerId];
    const stacks = (system.spaceUnitsByPlayer[playerId] ?? []) as UnitStack[];

    for (const stack of stacks) {
      if (!SHIP_TYPES.includes(stack.unitType) || stack.count <= 0) continue;
      const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
      if (!stats || stats.combat == null) continue; // e.g. a transported ground force accidentally in the space stack list — shouldn't happen, but no combat value means no dice

      const diceCountPerUnit = stats.combatDiceCount ?? 1;
      // RR "Prophecy of Ixth": the owner's fighters get +1 to their combat
      // roll result — expressed here as -1 to hitOn (mathematically
      // identical, same convention as this file's other die-modifier
      // agendas/techs, e.g. Antimass Deflectors).
      const prophecyOfIxthBonus = stack.unitType === "fighter" && getLawOwner(state, "prophecy_of_ixth" as AgendaId) === playerId ? 1 : 0;
      const hitOn = (isDefender ? stats.combat - anomalyBonus : stats.combat) - prophecyOfIxthBonus;

      entries.push({
        playerId,
        diceCount: stack.count * diceCountPerUnit,
        hitOn,
        unitType: stack.unitType,
      });
    }
  }

  return entries;
}

/**
 * RR 38 GROUND COMBAT entries for one planet. No anomaly-style modifier
 * here — Nebula's defender bonus is space-combat-only. Same "exactly 2
 * players" and "no action cards/tech/faction abilities yet" limits as
 * buildSpaceCombatEntries above.
 */
export function buildGroundCombatEntries(
  state: GameState,
  rules: RuleData,
  planet: PlanetState,
  /** RR "Magen Defense Grid" (base version): if the defender used it this round, the attacker can't roll any combat dice at all — excluded here entirely rather than zeroed out per-unit. */
  blockedPlayerId?: PlayerId,
): CombatUnitEntry[] {
  const playerIds = playersWithGroundForces(planet);
  if (playerIds.length !== 2) {
    throw new Error(
      `RR 38: se esperan exactamente 2 jugadores en combate terrestre en ${planet.planetId}, hay ${playerIds.length}.`,
    );
  }

  const entries: CombatUnitEntry[] = [];
  for (const playerId of playerIds) {
    if (playerId === blockedPlayerId) continue;
    const player = state.players[playerId];
    const stacks = (planet.unitsByPlayer[playerId] ?? []) as UnitStack[];
    for (const stack of stacks) {
      if (!GROUND_FORCE_TYPES.includes(stack.unitType) || stack.count <= 0) continue;
      const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
      if (!stats || stats.combat == null) continue;
      // RR "X-89 Bacterial Weapon" ΩΩ (Codex 4): doubles the hits produced
      // by this player's own ground combat rolls — modeled as doubling the
      // dice count (proportionally the same effect on average hits),
      // consistent with how this project's other dice-count bonuses work.
      // See useX89BacterialWeapon's own note on the OTHER, unimplemented
      // half of this version's text.
      const diceMultiplier =
        usesCodex4Version(state.mode) && player.technologies.includes(asTechId("x89_bacterial_weapon")) ? 2 : 1;
      entries.push({ playerId, diceCount: stack.count * (stats.combatDiceCount ?? 1) * diceMultiplier, hitOn: stats.combat, unitType: stack.unitType });
    }
  }
  return entries;
}

/**
 * RR 44.1 / 15 BOMBARDMENT — the attacker's own bombardment-capable ships
 * firing at a planet, single-sided (unlike space/ground combat's mutual
 * fire). Doesn't check Planetary Shield here — that's the caller's job
 * (see planetHasShield), since whether Bombardment is even legal against
 * this planet is a precondition, not something this function should decide.
 */
export function buildBombardmentEntries(
  state: GameState,
  rules: RuleData,
  systemId: SystemId,
  attackerId: PlayerId,
  /** RR "Plasma Scoring": which of the attacker's own Bombardment-capable unit types gets the +1 die — the player's own choice (matters when they have more than one qualifying type with different hitOn values), so the caller must supply it explicitly rather than this function guessing. Ignored if the player doesn't own the tech, or doesn't actually have that unit type bombarding here. */
  plasmaScoringUnitType?: UnitType,
): CombatUnitEntry[] {
  const system = state.systems[systemId];
  if (!system) return [];
  const player = state.players[attackerId];
  const stacks = (system.spaceUnitsByPlayer[attackerId] ?? []) as UnitStack[];
  const applyPlasmaScoringTo = player.technologies.includes(asTechId("plasma_scoring")) ? plasmaScoringUnitType : undefined;
  // RR "X-89 Bacterial Weapon" ΩΩ (Codex 4): doubles the hits produced by
  // this player's own Bombardment rolls — modeled as doubling the dice
  // count, same reasoning as the ground-combat half in
  // buildGroundCombatEntries above.
  const bombardmentDiceMultiplier =
    usesCodex4Version(state.mode) && player.technologies.includes(asTechId("x89_bacterial_weapon")) ? 2 : 1;

  const entries: CombatUnitEntry[] = [];
  for (const stack of stacks) {
    if (stack.count <= 0) continue;
    const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
    const bombardment = stats?.abilityValues?.bombardment;
    if (!bombardment) continue;
    let diceCount = stack.count * bombardment.dice * bombardmentDiceMultiplier;
    if (applyPlasmaScoringTo === stack.unitType) {
      diceCount += 1;
    }
    entries.push({ playerId: attackerId, diceCount, hitOn: bombardment.value });
  }
  return entries;
}

/** RR 15/44.1: true if `defenderId` has an undamaged, un-destroyed Planetary Shield unit (a PDS, normally) on this planet — Bombardment can't target it at all while true. */
export function planetHasShield(
  planet: PlanetState,
  defenderId: PlayerId,
  defenderFactionId: FactionId,
  defenderUnitUpgrades: UnitUpgradeId[],
  rules: RuleData,
): boolean {
  const stacks = (planet.unitsByPlayer[defenderId] ?? []) as UnitStack[];
  return stacks.some((s) => {
    if (s.count <= 0) return false;
    const stats = getUnitStats(rules, defenderFactionId, s.unitType, defenderUnitUpgrades);
    return stats?.abilities.includes("planetaryShield") ?? false;
  });
}

// ---------------------------------------------------------------------
// RR 67.6 / 38.2 / 44.1 — hit assignment, shared by space combat, ground
// combat, and bombardment (they only differ in which UnitStack[] the hits
// come out of and who owns it).
// ---------------------------------------------------------------------

export interface HitAssignment {
  unitType: UnitType;
  outcome: "destroy" | "flip";
}

export type ApplyHitAssignmentsResult =
  | { ok: true; stacks: UnitStack[]; destroyed: Map<UnitType, number>; flipped: Map<UnitType, number> }
  | { ok: false; error: string };

/**
 * Applies a player's chosen hit assignments to their own stacks. This is
 * where Sustain Damage's flip-vs-destroy is a REAL per-unit choice the
 * caller (the player) makes — see ASSIGN_HITS's own doc comment for why
 * that matters (an earlier version of this auto-flipped, which silently
 * took away a real decision).
 */
export function applyHitAssignments(
  state: GameState,
  stacks: UnitStack[],
  assignments: HitAssignment[],
  hitsOwed: number,
  factionId: FactionId,
  ownedUnitUpgrades: UnitUpgradeId[],
  rules: RuleData,
): ApplyHitAssignmentsResult {
  const updated = stacks.map((s) => ({ ...s }));
  const unitsLeft = updated.reduce((sum, s) => sum + s.count, 0);
  // RR 67.6/38.2: if hits exceed the units left, every remaining unit is
  // destroyed/flipped and the extra hits are simply lost.
  const required = Math.min(hitsOwed, unitsLeft);
  if (assignments.length !== required) {
    return {
      ok: false,
      error: `${hitsOwed} hit(s) owed, ${unitsLeft} unit(s) left — expected ${required} assignment(s), got ${assignments.length}.`,
    };
  }

  const destroyed = new Map<UnitType, number>();
  const flipped = new Map<UnitType, number>();

  for (const { unitType, outcome } of assignments) {
    const stack = updated.find((s) => s.unitType === unitType && s.count > 0);
    if (!stack) return { ok: false, error: `No ${unitType} left to assign a hit to.` };

    if (outcome === "flip") {
      const effectiveAbilities = getEffectiveUnitAbilities(state, rules, factionId, unitType, ownedUnitUpgrades);
      if (!effectiveAbilities.includes("sustainDamage")) {
        return { ok: false, error: `RR 76: ${unitType} doesn't have Sustain Damage.` };
      }
      if (stack.damagedCount >= stack.count) {
        return { ok: false, error: `RR 76: every ${unitType} in this stack is already damaged — this hit must destroy one.` };
      }
      stack.damagedCount += 1;
      flipped.set(unitType, (flipped.get(unitType) ?? 0) + 1);
    } else {
      // Prefer removing an already-damaged unit first — it was one hit from
      // death anyway, so this preserves the stack's remaining sustain buffer.
      if (stack.damagedCount > 0) stack.damagedCount -= 1;
      stack.count -= 1;
      destroyed.set(unitType, (destroyed.get(unitType) ?? 0) + 1);
    }
  }

  return { ok: true, stacks: updated.filter((s) => s.count > 0), destroyed, flipped };
}

/**
 * RR "Self-Assembly Routines"'s OTHER ability (passive, no exhaust — the
 * card's first ability is the only exhaustable one, see
 * phases/technologyAbilities.ts's useSelfAssemblyRoutines): gain 1 trade
 * good per mech destroyed. A mech can be destroyed via space combat,
 * ground combat, bombardment, Space Cannon Offense, or Space Cannon
 * Defense — every one of those call sites' own hit-assignment handler
 * calls this right after computing `destroyed` from applyHitAssignments,
 * rather than duplicating the "does this player own the tech" check in
 * six different files.
 */
export function applySelfAssemblyRoutinesMechBonus(player: Player, destroyed: Map<UnitType, number>): Player {
  const mechsDestroyed = destroyed.get("mech") ?? 0;
  if (mechsDestroyed === 0 || !player.technologies.includes(asTechId("self_assembly_routines"))) return player;
  return { ...player, tradeGoods: player.tradeGoods + mechsDestroyed };
}

// ---------------------------------------------------------------------
// RR 77 SPACE CANNON OFFENSE — after movement, ANY player (not just the
// active player's opponent — even one with no ships in this system at all)
// may independently fire their qualifying PDS at the active player's ships.
// Qualifying = a PDS physically on a planet in the target system, OR a PDS
// with the PDS II upgrade's `rangesToAdjacent` flag on a planet in an
// ADJACENT system. Both helpers below share the same per-player dice-pool
// logic so "is this player eligible" and "here's their actual dice pool"
// can never disagree with each other.
// ---------------------------------------------------------------------

/**
 * This one player's Space Cannon dice pools against a given target system,
 * one CombatUnitEntry PER qualifying unit type (not combined into one) —
 * Space Cannon isn't PDS-exclusive (some faction units carry it too, per
 * their own sheet), and two different unit types can have different
 * hitOn/dice values, so they can't share a single entry the way same-type
 * PDS stacks can.
 */
function spaceCannonEntriesForPlayer(
  state: GameState,
  rules: RuleData,
  firingPlayerId: PlayerId,
  targetSystemId: SystemId,
  targetPlayerId: PlayerId,
  plasmaScoringUnitType?: UnitType,
): CombatUnitEntry[] {
  const player = state.players[firingPlayerId];
  if (!player) return [];

  const perType = new Map<UnitType, { diceCount: number; hitOn: number }>();

  const scanSystem = (systemId: SystemId, requireRangesToAdjacent: boolean) => {
    const system = state.systems[systemId];
    if (!system) return;
    for (const planet of system.planets) {
      const stacks = (planet.unitsByPlayer[firingPlayerId] ?? []) as UnitStack[];
      for (const stack of stacks) {
        if (stack.count <= 0) continue;
        const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
        const sc = stats?.abilityValues?.spaceCannon;
        if (!sc) continue;
        if (requireRangesToAdjacent && !sc.rangesToAdjacent) continue;
        const existing = perType.get(stack.unitType);
        if (existing) existing.diceCount += stack.count * sc.dice;
        else perType.set(stack.unitType, { diceCount: stack.count * sc.dice, hitOn: sc.value });
      }
    }
  };

  scanSystem(targetSystemId, false);
  for (const adjId of getAdjacentSystems(state, targetSystemId)) {
    scanSystem(adjId, true);
  }

  if (perType.size === 0) return [];

  // RR "Antimass Deflectors": if the TARGET owns it, apply -1 to each
  // attacking die (expressed here as +1 to the shooter's hitOn threshold —
  // mathematically identical, and keeps resolveCombatRound's own dice-vs-
  // threshold model the single source of truth for what counts as a hit).
  const antimassBonus = state.players[targetPlayerId]?.technologies.includes(asTechId("antimass_deflectors")) ? 1 : 0;
  // RR "Plasma Scoring": the FIRING player's own choice of which qualifying
  // unit type gets the +1 die — matters whenever they have 2+ types with
  // different hitOn values, so the caller must supply it explicitly (see
  // this function's own callers) rather than guessing which one benefits most.
  const applyPlasmaScoringTo = player.technologies.includes(asTechId("plasma_scoring")) ? plasmaScoringUnitType : undefined;

  const entries: CombatUnitEntry[] = [];
  for (const [unitType, { diceCount, hitOn }] of perType) {
    entries.push({
      playerId: firingPlayerId,
      diceCount: diceCount + (applyPlasmaScoringTo === unitType ? 1 : 0),
      hitOn: hitOn + antimassBonus,
    });
  }
  return entries;
}

/** RR 77: every player (excluding the active player themselves) with at least one qualifying Space-Cannon-capable unit — in the system, or range-upgraded (e.g. PDS II) in an adjacent one. */
export function getSpaceCannonOffenseEligiblePlayers(
  state: GameState,
  rules: RuleData,
  targetSystemId: SystemId,
  activePlayerId: PlayerId,
): PlayerId[] {
  return Object.keys(state.players)
    .filter((id): id is PlayerId => id !== activePlayerId && !state.players[id as PlayerId].eliminated)
    .filter((id) => spaceCannonEntriesForPlayer(state, rules, id, targetSystemId, activePlayerId).length > 0);
}

/** This one player's full Space Cannon Offense dice pool (rules.combat.ts) — see spaceCannonEntriesForPlayer for why this can be more than one entry. */
export function buildSpaceCannonOffenseEntries(
  state: GameState,
  rules: RuleData,
  firingPlayerId: PlayerId,
  targetSystemId: SystemId,
  targetPlayerId: PlayerId,
  plasmaScoringUnitType?: UnitType,
): CombatUnitEntry[] {
  return spaceCannonEntriesForPlayer(state, rules, firingPlayerId, targetSystemId, targetPlayerId, plasmaScoringUnitType);
}

// ---------------------------------------------------------------------
// RR 67.1 ANTI-FIGHTER BARRAGE — mandatory (not a choice) for whichever
// combatants have AFB-capable ships, fires once at the very start of a
// space combat, targeting only fighters. The dice pool itself is built the
// same way normal combat dice are (per-ship abilityValues), just using
// `antiFighterBarrage` instead of `combat` — the "fighters only" part is
// enforced at hit-ASSIGNMENT time (see phases/spaceCombat.ts), not here.
// ---------------------------------------------------------------------

/** Every combatant in this system with at least 1 AFB-capable ship. */
export function getAntiFighterBarrageParticipants(state: GameState, rules: RuleData, systemId: SystemId): PlayerId[] {
  return playersWithShipsInSystem(state, systemId).filter(
    (playerId) => buildAntiFighterBarrageEntries(state, rules, playerId, systemId).length > 0,
  );
}

/** This one player's AFB dice pool in this system (single-entry array, matching resolveCombatRound's input shape) — empty if none of their ships have the ability. */
export function buildAntiFighterBarrageEntries(
  state: GameState,
  rules: RuleData,
  firingPlayerId: PlayerId,
  systemId: SystemId,
): CombatUnitEntry[] {
  const system = state.systems[systemId];
  if (!system) return [];
  const player = state.players[firingPlayerId];
  const stacks = (system.spaceUnitsByPlayer[firingPlayerId] ?? []) as UnitStack[];

  let diceCount = 0;
  let hitOn: number | null = null;
  for (const stack of stacks) {
    if (stack.count <= 0) continue;
    const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
    const afb = stats?.abilityValues?.antiFighterBarrage;
    if (!afb) continue;
    diceCount += stack.count * afb.dice;
    hitOn = afb.value;
  }

  if (diceCount === 0 || hitOn === null) return [];
  return [{ playerId: firingPlayerId, diceCount, hitOn }];
}

// ---------------------------------------------------------------------
// RR 44 SPACE CANNON DEFENSE — the defender's own optional choice, before
// ground combat starts, to fire their PDS on the invaded planet at the
// attacker's just-committed ground forces. Only the PDS physically ON that
// planet count — unlike Space Cannon Offense, this doesn't extend to
// adjacent systems (PDS II's `rangesToAdjacent` is about firing at ships
// from a planet, not about defending a different planet than the one it's on).
// ---------------------------------------------------------------------

/** The defender's Space Cannon dice pool for defending this one planet — empty if they have no qualifying PDS there. */
export function buildSpaceCannonDefenseEntries(
  state: GameState,
  rules: RuleData,
  defenderId: PlayerId,
  planet: PlanetState,
  attackerId: PlayerId,
  plasmaScoringUnitType?: UnitType,
): CombatUnitEntry[] {
  const player = state.players[defenderId];
  if (!player) return [];
  const stacks = (planet.unitsByPlayer[defenderId] ?? []) as UnitStack[];

  const perType = new Map<UnitType, { diceCount: number; hitOn: number }>();
  for (const stack of stacks) {
    if (stack.count <= 0) continue;
    const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
    const sc = stats?.abilityValues?.spaceCannon;
    if (!sc) continue;
    const existing = perType.get(stack.unitType);
    if (existing) existing.diceCount += stack.count * sc.dice;
    else perType.set(stack.unitType, { diceCount: stack.count * sc.dice, hitOn: sc.value });
  }

  if (perType.size === 0) return [];
  // RR "Antimass Deflectors": if the ATTACKER (whose ground forces are
  // being fired at here) owns it, apply -1 to each attacking die
  // (expressed as +1 to hitOn — see spaceCannonEntriesForPlayer's own note
  // on why this is mathematically identical).
  const antimassBonus = state.players[attackerId]?.technologies.includes(asTechId("antimass_deflectors")) ? 1 : 0;
  // RR "Plasma Scoring": the DEFENDER's own choice of which qualifying
  // unit type gets the +1 die — see spaceCannonEntriesForPlayer's own note.
  const applyPlasmaScoringTo = player.technologies.includes(asTechId("plasma_scoring")) ? plasmaScoringUnitType : undefined;

  const entries: CombatUnitEntry[] = [];
  for (const [unitType, { diceCount, hitOn }] of perType) {
    entries.push({
      playerId: defenderId,
      diceCount: diceCount + (applyPlasmaScoringTo === unitType ? 1 : 0),
      hitOn: hitOn + antimassBonus,
    });
  }
  return entries;
}
