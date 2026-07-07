import { GameState, PlanetState, UnitStack } from "../types/GameState";
import { PlayerId, SystemId } from "../types/ids";
import { GROUND_FORCE_TYPES, SHIP_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { getDefenderCombatBonus } from "./anomalies";

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
}

export interface CombatRoundResult {
  /** Hits *scored by* each player's units this round (i.e. what that player did to their opponent(s) — the caller decides who those hits land on). */
  hitsScoredByPlayer: Partial<Record<PlayerId, number>>;
}

export function resolveCombatRound(entries: CombatUnitEntry[], diceRolls: number[]): CombatRoundResult {
  const totalDice = entries.reduce((sum, e) => sum + e.diceCount, 0);
  if (diceRolls.length !== totalDice) {
    throw new Error(`RR 67.5/38.1: se esperaban ${totalDice} dados para esta ronda, llegaron ${diceRolls.length}.`);
  }

  const hitsScoredByPlayer: Partial<Record<PlayerId, number>> = {};
  let i = 0;
  for (const entry of entries) {
    for (let d = 0; d < entry.diceCount; d++) {
      const roll = diceRolls[i++];
      if (roll >= entry.hitOn) {
        hitsScoredByPlayer[entry.playerId] = (hitsScoredByPlayer[entry.playerId] ?? 0) + 1;
      }
    }
  }
  return { hitsScoredByPlayer };
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
      const hitOn = isDefender ? stats.combat - anomalyBonus : stats.combat;

      entries.push({
        playerId,
        diceCount: stack.count * diceCountPerUnit,
        hitOn,
      });
    }
  }

  return entries;
}

