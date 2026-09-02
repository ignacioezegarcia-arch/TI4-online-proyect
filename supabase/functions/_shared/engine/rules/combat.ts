import { GameState, Player, PlanetState, UnitStack } from "../types/GameState";
import { PlayerId, SystemId, PlanetId, FactionId, UnitUpgradeId, AgendaId, asTechId, asAbilityId } from "../types/ids";
import { GROUND_FORCE_TYPES, SHIP_TYPES, UnitType } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { getDefenderCombatBonus, hasEntropicScar } from "./anomalies";
import { getAdjacentSystems } from "./adjacency";
import { usesCodex4Version, hasCodex, hasThundersEdge } from "./gameMode";
import { getEffectiveUnitAbilities, getLawOwner } from "../phases/agendaEffects";
import { hasAbility } from "./abilities";

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
  /** Jol-Nar "J.N.S. Hylarim" (flagship, Bonus Hits): true only for THIS specific player's own flagship entry, when they're actually Jol-Nar — computed at entry-build time (buildSpaceCombatEntries) since resolveCombatRound itself has no faction context to check this against a bare unitType === "flagship", which would otherwise wrongly apply to every OTHER faction's flagship too. */
  hylarimBonusHits?: boolean;
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
      // Jol-Nar "J.N.S. Hylarim" (flagship, Bonus Hits): "each result of 9 or 10, before applying modifiers, produces 2 additional hits." Checked against the RAW `roll` value directly (not entry.hitOn, which already has modifiers baked in) — on top of whatever the normal hit/miss check above already produced, not instead of it.
      if (entry.hylarimBonusHits && roll >= 9) {
        hitsScoredByPlayer[entry.playerId] = (hitsScoredByPlayer[entry.playerId] ?? 0) + 2;
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
/** "Morale Boost": +1 to the result of this player's combat rolls THIS round only — expressed as -1 to hitOn (same convention as every other die modifier here). Self-expiring: only true while `combatRound` still matches the round it was played in. */
export function getMoraleBoostHitOnBonus(state: GameState, playerId: PlayerId): number {
  const moraleBoost = state.pendingTacticalAction?.moraleBoost;
  if (!moraleBoost || moraleBoost.playerId !== playerId) return 0;
  return moraleBoost.round === (state.pendingTacticalAction?.combatRound ?? 1) ? 1 : 0;
}

/** "Fighter Prototype": +2 to the result of this player's FIGHTER combat rolls, round 1 of a space combat ONLY — expressed as -2 to hitOn, same convention as Morale Boost above. Explicitly checks combatRound === 1 (not just "was this set during a combat_round_start window", since that window also reopens for round 2+ via wrapUpCombatRound's own next-round branch). */
function getFighterPrototypeHitOnBonus(state: GameState, playerId: PlayerId, unitType: UnitType): number {
  if (unitType !== "fighter") return 0;
  if (state.pendingTacticalAction?.fighterPrototypePlayerId !== playerId) return 0;
  return (state.pendingTacticalAction?.combatRound ?? 1) === 1 ? 2 : 0;
}

export function buildSpaceCombatEntries(
  state: GameState,
  rules: RuleData,
  systemId: SystemId,
  activePlayerId: PlayerId,
  /** Letnev "Viscount Unlenn" (agent): "you may exhaust this card to choose 1 ship in the active system; that ship rolls 1 additional die during this combat round." Confirmed (yjmrobert.com/tirules/factions/f_letnev): "only applies to combat rolls" (not AFB) and "the extra die is mandatory for the chosen unit" — a flat +1, same shape as Sol's Evelyn DeLouis but for ships/space combat instead of ground forces/ground combat. */
  /** Letnev "Viscount Unlenn" (agent): "you may exhaust this card to choose 1 ship in the active system; that ship rolls 1 additional die during this combat round." Confirmed (yjmrobert.com/tirules/factions/f_letnev): "only applies to combat rolls" (not AFB) and "the extra die is mandatory for the chosen unit" — a flat +1, same shape as Sol's Evelyn DeLouis but for ships/space combat instead of ground forces/ground combat. FIXED: separated ownership (who holds Viscount Unlenn, need not be a combatant) from the target beneficiary (whose unit gets the bonus, must be a combatant) — an agent's ability can benefit ANY player. */
  viscountUnlennBonus?: { targetPlayerId: PlayerId; unitType: UnitType },
  /** Letnev "Gravleash Maneuvers" (breakthrough): "Before you roll dice during space combat, apply +X to the results of 1 of your ship's rolls, where X is the number of ship types you have in the combat." Applied as a -X to hitOn for the chosen unit type (same mathematical convention as every other die-modifier in this file) — X itself is computed by the caller (phases/spaceCombat.ts's own resolveSpaceCombatRound), since it needs a count of distinct ship TYPES this player has in the fight, which this function doesn't otherwise track as a single number. */
  gravleashManeuversBonus?: { playerId: PlayerId; unitType: UnitType; bonusPerDie: number },
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
    const moraleBoostBonus = getMoraleBoostHitOnBonus(state, playerId);

    for (const stack of stacks) {
      if (!SHIP_TYPES.includes(stack.unitType) || stack.count <= 0) continue;
      const stats = getUnitStatsForCombat(rules, player, stack.unitType, player.unitUpgrades);
      if (!stats || stats.combat == null) continue; // e.g. a transported ground force accidentally in the space stack list — shouldn't happen, but no combat value means no dice

      const diceCountPerUnit = stats.combatDiceCount ?? 1;
      // Winnu "Salai Sai Corian" (flagship, "Scaling Combat Dice"): "this
      // unit rolls a number of dice equal to the number of your
      // opponent's non-fighter ships in this system." Confirmed
      // (yjmrobert.com/tirules/factions/f_winnu): "if the opponent has
      // only fighters, it rolls no dice." A genuinely dynamic dice count
      // (not a fixed per-unit multiplier like every other unit in the
      // game), computed here directly rather than through the normal
      // combatDiceCount data field (which can't represent "depends on
      // the opponent's own units" at all — this unit's own data entry
      // deliberately has combatDiceCount unset for exactly this reason).
      const salaiSaiScalingDice =
        stack.unitType === "flagship" && player.factionId === ("winnu" as never)
          ? (system.spaceUnitsByPlayer[playerIds.find((id) => id !== playerId) ?? ("" as PlayerId)] ?? []).filter((s) => SHIP_TYPES.includes(s.unitType) && s.unitType !== "fighter" && s.count > 0).reduce((sum, s) => sum + s.count, 0)
          : null;
      // RR "Prophecy of Ixth": the owner's fighters get +1 to their combat
      // roll result — expressed here as -1 to hitOn (mathematically
      // identical, same convention as this file's other die-modifier
      // agendas/techs, e.g. Antimass Deflectors).
      const prophecyOfIxthBonus = stack.unitType === "fighter" && getLawOwner(state, "prophecy_of_ixth" as AgendaId) === playerId ? 1 : 0;
      const fighterPrototypeBonus = getFighterPrototypeHitOnBonus(state, playerId, stack.unitType);
      // Sardakk N'orr "UNRELENTING" (faction ability, passive): "+1 to the result of each of your unit's combat rolls." Confirmed (tirules2.com/F_norr): does NOT affect AFB, Bombardment, or Space Cannon rolls — this function only ever builds NORMAL combat-round entries, so that scoping is automatic just by living here.
      const unrelentingBonus = hasAbility(player, asAbilityId("unrelenting")) ? 1 : 0;
      // Jol-Nar "FRAGILE" (faction ability, passive, mandatory): "-1 to the result of each of your unit's combat rolls." Confirmed (tirules2.com/F_jol_nar): same AFB/Bombardment/Space Cannon exclusion as UNRELENTING, and mandatory (not "may") — automatic here since it's a flat modifier, not a player choice at all.
      const fragileBonus = hasAbility(player, asAbilityId("fragile")) ? -1 : 0;
      // Sardakk N'orr "C'Morran N'orr" (flagship, Fleet Combat Bonus): "+1 to the result of each of your OTHER ships' combat rolls in this system." Same AFB/Bombardment/Space Cannon exclusion as UNRELENTING above. Never applies to the flagship's own roll (only "other" ships).
      const hasCMorranNorrInSystem = stack.unitType !== "flagship" && (system.spaceUnitsByPlayer[playerId] ?? []).some((s) => s.unitType === "flagship" && s.count > 0) && player.factionId === ("sardakk" as never);
      // Winnu "Rickar Rickani" (commander): "+2 to the result of each of
      // your unit's combat rolls in the Mecatol Rex system, your home
      // system, and each system that contains a legendary planet."
      // Confirmed (yjmrobert.com/tirules/factions/f_winnu): "if a system
      // meets 2+ of these conditions... only +2, not +4 (or +6)" — a
      // capped boolean check, never additive.
      const rickarRickaniEntry = player.leaders.find((l) => l.leaderId === ("winnu_commander" as never));
      const rickarRickaniUnlocked = rickarRickaniEntry && !rickarRickaniEntry.locked;
      const rickarRickaniQualifies =
        !!rickarRickaniUnlocked &&
        (system.planets.some((p) => rules.planets[p.planetId]?.isMecatolRex) ||
          rules.homeSystemByFaction[player.factionId] === systemId ||
          system.planets.some((p) => rules.planets[p.planetId]?.isLegendary));
      const rickarRickaniBonus = rickarRickaniQualifies ? 2 : 0;
      // Winnu "Imperator" (Breakthrough ability): "+1 to the results of
      // each of your unit's combat rolls for each 'Support for the
      // Throne' in your opponent's play area." Confirmed: "applies even
      // if it is the Winnu player's OWN Support for the Throne" (no
      // ownership check, just counts occurrences in the OPPONENT's own
      // promissoryNotesInPlayArea).
      const opponentIdForImperator = playerIds.find((id) => id !== playerId);
      const imperatorBonus =
        player.factionId === ("winnu" as never) && player.hasBreakthrough && opponentIdForImperator
          ? (state.players[opponentIdForImperator]?.promissoryNotesInPlayArea ?? []).filter((id) => id === ("support_for_the_throne" as never)).length
          : 0;
      const hitOn = (isDefender ? stats.combat - anomalyBonus : stats.combat) - prophecyOfIxthBonus - moraleBoostBonus - fighterPrototypeBonus - unrelentingBonus - fragileBonus - (hasCMorranNorrInSystem ? 1 : 0) - rickarRickaniBonus - imperatorBonus;
      const viscountBonus = viscountUnlennBonus && viscountUnlennBonus.targetPlayerId === playerId && viscountUnlennBonus.unitType === stack.unitType ? 1 : 0;
      const totalDiceForStack = salaiSaiScalingDice != null ? salaiSaiScalingDice : stack.count * diceCountPerUnit + viscountBonus;
      const hylarimBonusHits = stack.unitType === "flagship" && player.factionId === ("jolnar" as never);

      // Letnev "Gravleash Maneuvers": the bonus only ever applies to exactly 1 of this player's own dice — split it off into its own entry (diceCount 1) with the boosted hitOn, leaving the rest of the stack's dice at the normal value.
      const usesGravleash = gravleashManeuversBonus && gravleashManeuversBonus.playerId === playerId && gravleashManeuversBonus.unitType === stack.unitType && totalDiceForStack > 0;
      if (usesGravleash) {
        entries.push({ playerId, diceCount: 1, hitOn: hitOn - gravleashManeuversBonus!.bonusPerDie, unitType: stack.unitType, hylarimBonusHits });
        if (totalDiceForStack > 1) {
          entries.push({ playerId, diceCount: totalDiceForStack - 1, hitOn, unitType: stack.unitType, hylarimBonusHits });
        }
        continue;
      }

      entries.push({
        playerId,
        diceCount: totalDiceForStack,
        hitOn,
        unitType: stack.unitType,
        hylarimBonusHits,
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
  /**
   * TE COEXIST (yjmrobert.com/tirules/rules/r_coexistence): the exact 2
   * players actually fighting THIS combat — required whenever a 3rd (or
   * more) coexisting party could also be present on the same planet, so
   * their units are never pulled into a fight that isn't theirs.
   * Optional/omittable for every pre-Thunder's-Edge call site, where
   * playersWithGroundForces(planet) reliably already returns exactly the
   * 2 real combatants on its own.
   */
  participantIds?: [PlayerId, PlayerId],
  /** Sol "Evelyn DeLouis" (agent): "you may exhaust this card to choose 1 ground force in the active system; that ground force rolls 1 additional die during that combat round." Confirmed (yjmrobert.com/tirules/factions/f_sol): "only applies to combat rolls" — a flat +1 die for the CASTER's own chosen unit type's stack, not a multiplier, and never applicable to any OTHER roll type (Bombardment-style abilities some units have) since this function only ever builds normal combat-round entries in the first place. */
  /** Sol "Evelyn DeLouis" (agent): "you may exhaust this card to choose 1 ground force in the active system; that ground force rolls 1 additional die during that combat round." Confirmed (yjmrobert.com/tirules/factions/f_sol): "only applies to combat rolls" (not AFB) and "the extra die is mandatory for the chosen unit" — a flat +1. FIXED: previously conflated "who owns Evelyn" with "whose unit gets the bonus" into a single playerId field, meaning the agent could only ever boost its OWNER's own unit — the card text has NO such restriction ("1 ground force in the active system", not "1 of your own"); an agent's own ability can be used to benefit ANY player, including handing the benefit to someone else entirely (an ally, a favor, etc.) — the owner just decides whether to use it at all. targetPlayerId/unitType now identify the BENEFICIARY separately from ownership (checked at the call site in phases/invasion.ts's own resolveGroundCombatRound). */
  evelynDelouisBonus?: { targetPlayerId: PlayerId; unitType: "infantry" | "mech" },
  /** Sardakk N'orr "Tekklar Legion" (promissory note): "At the start of an invasion combat: apply +1 to the result of each of your unit's combat rolls during this combat. If your opponent is the N'orr player, apply -1 to the result of each of their unit's combat rolls during this combat." Confirmed (tirules2.com/F_norr): same AFB/Bombardment/Space Cannon exclusion as UNRELENTING/C'Morran N'orr (this function only ever builds normal ground-combat entries). */
  tekklarLegionHolderId?: PlayerId,
): CombatUnitEntry[] {
  const playerIds = participantIds ?? playersWithGroundForces(planet);
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
    const moraleBoostBonus = getMoraleBoostHitOnBonus(state, playerId);
    for (const stack of stacks) {
      if (!GROUND_FORCE_TYPES.includes(stack.unitType) || stack.count <= 0) continue;
      const stats = getUnitStatsForCombat(rules, player, stack.unitType, player.unitUpgrades);
      if (!stats || stats.combat == null) continue;
      // RR "X-89 Bacterial Weapon" ΩΩ (Codex 4): doubles the hits produced
      // by this player's own ground combat rolls — modeled as doubling the
      // dice count (proportionally the same effect on average hits),
      // consistent with how this project's other dice-count bonuses work.
      // See useX89BacterialWeapon's own note on the OTHER, unimplemented
      // half of this version's text.
      const diceMultiplier =
        usesCodex4Version(state.mode) && player.technologies.includes(asTechId("x89_bacterial_weapon")) ? 2 : 1;
      const evelynBonus = evelynDelouisBonus && evelynDelouisBonus.targetPlayerId === playerId && evelynDelouisBonus.unitType === stack.unitType ? 1 : 0;
      // Sardakk N'orr "UNRELENTING" (faction ability, passive): "+1 to the result of each of your unit's combat rolls." Confirmed: does NOT affect AFB/Bombardment/Space Cannon — automatic here, since this function only ever builds normal ground-combat entries.
      const unrelentingBonus = hasAbility(player, asAbilityId("unrelenting")) ? 1 : 0;
      // Jol-Nar "FRAGILE" (faction ability, passive, mandatory): "-1 to the result of each of your unit's combat rolls." Jol-Nar's own "Shield Paling" mech grants "Fragile Immunity" to INFANTRY specifically on the SAME planet — confirmed (tirules2.com/F_jol_nar): "the Shield Paling itself is still affected by FRAGILE" (only infantry are exempt, never the mech itself).
      const hasShieldPalingOnPlanet = stack.unitType === "infantry" && (planet.unitsByPlayer[playerId] ?? []).some((s) => s.unitType === "mech" && s.count > 0) && player.factionId === ("jolnar" as never);
      const fragileBonus = hasAbility(player, asAbilityId("fragile")) && !hasShieldPalingOnPlanet ? -1 : 0;
      // Sardakk N'orr "Tekklar Legion" (promissory note): +1 for the holder, -1 for their opponent specifically if that opponent is the N'orr player.
      const tekklarLegionBonus = tekklarLegionHolderId === playerId ? 1 : tekklarLegionHolderId !== undefined && player.factionId === ("sardakk" as never) ? -1 : 0;
      // Naalu Collective "Iconoclast" (mech, original): "During combat
      // against an opponent who has at least 1 relic fragment, apply +2
      // to the results of this unit's combat rolls." Confirmed
      // (yjmrobert.com/tirules/factions/f_naalu): "does NOT apply if the
      // opponent has a relic but ZERO relic fragments" — checked against
      // relicFragments specifically, never relics themselves. Only the
      // ORIGINAL (base/PoK) version has this — Ω/ΩΩ replace it with
      // Barrage Immunity/a Deploy trigger instead (see rules/naalu.ts's
      // own game-mode gating for those).
      const opponentId = playerIds.find((id) => id !== playerId);
      const opponentPlayer = opponentId ? state.players[opponentId] : undefined;
      const opponentHasRelicFragments = !!opponentPlayer && Object.values(opponentPlayer.relicFragments).some((n) => n > 0);
      const iconoclastRelicBonus = stack.unitType === "mech" && player.factionId === ("naalu" as never) && !hasCodex(state.mode) && opponentHasRelicFragments ? 2 : 0;
      // Winnu "Rickar Rickani" (commander): same "+2, capped, in Mecatol
      // Rex/home/legendary-planet systems" bonus as buildSpaceCombatEntries'
      // own copy above — ground combat is inherently scoped to a single
      // planet, so checking THIS planet's own isMecatolRex/isLegendary
      // flags directly is sufficient without needing its containing
      // system (a home-system check still needs that, found via a
      // one-off lookup since this function isn't otherwise given one).
      const rickarRickaniEntry = player.leaders.find((l) => l.leaderId === ("winnu_commander" as never));
      const rickarRickaniUnlocked = rickarRickaniEntry && !rickarRickaniEntry.locked;
      const containingSystemId = rickarRickaniUnlocked ? Object.entries(state.systems).find(([, s]) => s.planets.some((p) => p.planetId === planet.planetId))?.[0] : undefined;
      const rickarRickaniQualifies =
        !!rickarRickaniUnlocked &&
        (rules.planets[planet.planetId]?.isMecatolRex === true || rules.planets[planet.planetId]?.isLegendary === true || (containingSystemId && rules.homeSystemByFaction[player.factionId] === containingSystemId));
      const rickarRickaniBonus = rickarRickaniQualifies ? 2 : 0;
      // Winnu "Imperator" (Breakthrough ability): same "+1 per Support
      // for the Throne in the opponent's play area" as
      // buildSpaceCombatEntries' own copy above.
      const imperatorBonus =
        player.factionId === ("winnu" as never) && player.hasBreakthrough ? (opponentPlayer?.promissoryNotesInPlayArea ?? []).filter((id) => id === ("support_for_the_throne" as never)).length : 0;
      entries.push({ playerId, diceCount: stack.count * (stats.combatDiceCount ?? 1) * diceMultiplier + evelynBonus, hitOn: stats.combat - moraleBoostBonus - unrelentingBonus - fragileBonus - tekklarLegionBonus - iconoclastRelicBonus - rickarRickaniBonus - imperatorBonus, unitType: stack.unitType });
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
  /** "Bunker"/"Blitz" both need to know who actually controls the planet being bombarded — optional because callers that don't care about either card (or haven't picked a target planet yet) can simply omit it. */
  defenderId?: PlayerId,
  /** L1Z1X "Ground Bombardment" (Annihilator mech ability): "while NOT participating in ground combat, this unit can use its BOMBARDMENT ability on planets in its system as if it were a ship." Confirmed (yjmrobert.com/tirules/factions/f_lizix): usable even while committed to a DIFFERENT planet's own ground combat, as long as it isn't actively fighting itself right now — the caller supplies which planet(s) this player currently has a mech ACTIVELY fighting ground combat on (excluded from this scan); every OTHER planet's own Annihilator(s) qualify. */
  groundBombardmentExcludePlanetIds?: PlanetId[],
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
  // "Bunker": -4 to the RESULT of enemy Bombardment rolls against planets this player controls — expressed as +4 to hitOn (same convention as every other die modifier in this file).
  const bunkerPenalty = defenderId && state.pendingTacticalAction?.bunkerPlayerId === defenderId ? 4 : 0;
  // "Blitz": every one of the attacker's non-fighter ships here that doesn't already have Bombardment gains Bombardment 6 (1 die) for the rest of this invasion.
  const blitzActive = state.pendingTacticalAction?.blitzPlayerId === attackerId;

  const entries: CombatUnitEntry[] = [];
  for (const stack of stacks) {
    if (stack.count <= 0) continue;
    if (stack.unitType === "fighter") continue; // "Blitz" only ever grants Bombardment to NON-fighter ships — fighters never qualify even with it active.
    const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
    const bombardment = stats?.abilityValues?.bombardment ?? (blitzActive && SHIP_TYPES.includes(stack.unitType) ? { value: 6, dice: 1 } : undefined);
    if (!bombardment) continue;
    let diceCount = stack.count * bombardment.dice * bombardmentDiceMultiplier;
    if (applyPlasmaScoringTo === stack.unitType) {
      diceCount += 1;
    }
    entries.push({ playerId: attackerId, diceCount, hitOn: bombardment.value + bunkerPenalty, unitType: stack.unitType });
  }

  // L1Z1X "Ground Bombardment" (Annihilator mech ability): scans every
  // planet in this system (except ones this player currently has a mech
  // actively fighting ground combat on) for this player's own mechs with
  // Bombardment — same dice/Plasma-Scoring/X-89 treatment as the normal
  // ship-based scan above, just sourced from planets instead of space.
  if (player.factionId === ("l1z1x" as never)) {
    for (const planet of system.planets) {
      if (groundBombardmentExcludePlanetIds?.includes(planet.planetId)) continue;
      const mechStack = (planet.unitsByPlayer[attackerId] ?? []).find((s) => s.unitType === "mech" && s.count > 0);
      if (!mechStack) continue;
      const mechStats = getUnitStats(rules, player.factionId, "mech", player.unitUpgrades);
      const bombardment = mechStats?.abilityValues?.bombardment;
      if (!bombardment) continue;
      let diceCount = mechStack.count * bombardment.dice * bombardmentDiceMultiplier;
      if (applyPlasmaScoringTo === "mech") diceCount += 1;
      entries.push({ playerId: attackerId, diceCount, hitOn: bombardment.value + bunkerPenalty, unitType: "mech" });
    }
  }
  return entries;
}

/** RR 15/44.1: true if `defenderId` has an undamaged, un-destroyed Planetary Shield unit (a PDS, normally) on this planet — Bombardment can't target it at all while true. */
/** RR 15/44.1: true if `defenderId` has an undamaged, un-destroyed Planetary Shield unit (a PDS, normally) on this planet — Bombardment can't target it at all while true. RR 65.3's own exception: if the BOMBARDING player has a war sun in this system, Planetary Shield is ignored entirely (this function returns false unconditionally), regardless of what the defender has here. */
export function planetHasShield(
  planet: PlanetState,
  defenderId: PlayerId,
  defenderFactionId: FactionId,
  defenderUnitUpgrades: UnitUpgradeId[],
  rules: RuleData,
  attackerHasWarSunInSystem?: boolean,
): boolean {
  if (attackerHasWarSunInSystem) return false;
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
/**
 * TE NEUTRAL UNITS (rulebook p.10): "hits are assigned to neutral units
 * in the order presented on the neutral unit reference, prioritizing
 * units LOWER on the reference first... always use unit abilities when
 * they can (sustain damage, etc.)." There's no real neutral player to
 * make the normal free choice of which stack absorbs a hit — this
 * computes that choice automatically instead. Confirmed data point from
 * this project's own Crimson Rebellion notes: destroyers absorb hits
 * before cruisers do; the rest of this order is this project's own
 * reasonable extrapolation (cheaper/more expendable unit types first)
 * rather than a directly confirmed full ordering — flagged here rather
 * than presented as certain.
 */
/**
 * TE NEUTRAL UNITS: the game's own "Neutral Unit Reference" card values,
 * confirmed directly by this project's user — NOT the same as any real
 * faction's base or upgraded stats (e.g. neutral Carrier is 9/2/6, far
 * stronger than any real faction's own Carrier I or II). This is its
 * own, separate, fixed stat block. Used both for building this
 * project's own CombatUnitEntry lists (getUnitStatsForCombat below) and
 * for computeNeutralHitAssignments' own ability check — getUnitStats
 * can't be used for any of this, since "neutral" isn't a real
 * registered faction in rules.factionUnits.
 *
 * Per this project's own user: neutral units never use Production or
 * any technology-granted ability — only Sustain Damage, Anti-Fighter
 * Barrage, and Space Cannon, exactly as reflected below.
 */
const NEUTRAL_UNIT_STATS: Partial<Record<UnitType, { combat: number | null; combatDiceCount?: number; move: number | null; capacity: number | null; abilities: import("../types/enums").UnitAbility[]; abilityValues?: Partial<Record<import("../types/enums").UnitAbility, { value: number; dice: number }>> }>> = {
  flagship: { combat: 7, combatDiceCount: 2, move: 1, capacity: 3, abilities: [] },
  war_sun: { combat: 3, combatDiceCount: 3, move: 2, capacity: 6, abilities: ["sustainDamage", "bombardment"], abilityValues: { bombardment: { value: 3, dice: 3 } } },
  dreadnought: { combat: 5, move: 2, capacity: 1, abilities: ["sustainDamage"] },
  cruiser: { combat: 6, move: 3, capacity: 1, abilities: [] },
  carrier: { combat: 9, move: 2, capacity: 6, abilities: [] },
  destroyer: { combat: 8, move: 2, capacity: null, abilities: ["antiFighterBarrage"], abilityValues: { antiFighterBarrage: { value: 6, dice: 3 } } },
  fighter: { combat: 8, move: 2, capacity: null, abilities: [] },
  mech: { combat: 6, move: null, capacity: null, abilities: ["sustainDamage"] },
  infantry: { combat: 8, move: null, capacity: null, abilities: [] },
  pds: { combat: null, move: null, capacity: null, abilities: ["planetaryShield", "spaceCannon"], abilityValues: { spaceCannon: { value: 6, dice: 1 } } },
  space_dock: { combat: null, move: null, capacity: null, abilities: [] },
};

/** Same shape as getUnitStats (types/RuleData.ts), but checks NEUTRAL_UNIT_STATS first for the neutral pseudo-player — every combat-entry-building function that could ever face neutral guardians (ground combat, space combat, AFB; Bombardment/Space Cannon Defense are always rolled BY a real attacker, never by neutral, so they don't need this) should call this instead of getUnitStats directly. */
function getUnitStatsForCombat(rules: RuleData, player: Player, unitType: UnitType, unitUpgrades: import("../types/ids").UnitUpgradeId[]): import("../types/RuleData").UnitStats | undefined {
  if (player.isNeutral) {
    const neutral = NEUTRAL_UNIT_STATS[unitType];
    return neutral ? { unitType, cost: 0, ...neutral } : undefined;
  }
  return getUnitStats(rules, player.factionId, unitType, unitUpgrades);
}

const NEUTRAL_HIT_PRIORITY: UnitType[] = ["infantry", "fighter", "destroyer", "carrier", "cruiser", "mech", "pds", "space_dock", "dreadnought", "war_sun", "flagship"];

export function computeNeutralHitAssignments(
  stacks: UnitStack[],
  hitsOwed: number,
  /** TE ENTROPIC SCAR: if true, neutral units can't use Sustain Damage here either — every assignment is forced to "destroy", matching what applyHitAssignments itself would reject otherwise. */
  inEntropicScar = false,
): { unitType: UnitType; outcome: "destroy" | "flip" }[] {
  const assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[] = [];
  let remaining = hitsOwed;
  const orderedStacks = [...stacks].sort((a, b) => NEUTRAL_HIT_PRIORITY.indexOf(a.unitType) - NEUTRAL_HIT_PRIORITY.indexOf(b.unitType));
  for (const stack of orderedStacks) {
    if (remaining <= 0) break;
    const canSustain = !inEntropicScar && (NEUTRAL_UNIT_STATS[stack.unitType]?.abilities.includes("sustainDamage") ?? false);
    const undamagedCount = stack.count - stack.damagedCount;
    let flippedThisStack = 0;
    for (let i = 0; i < stack.count && remaining > 0; i++) {
      if (canSustain && flippedThisStack < undamagedCount) {
        assignments.push({ unitType: stack.unitType, outcome: "flip" });
        flippedThisStack += 1;
      } else {
        assignments.push({ unitType: stack.unitType, outcome: "destroy" });
      }
      remaining -= 1;
    }
  }
  return assignments;
}

export function applyHitAssignments(
  state: GameState,
  stacks: UnitStack[],
  assignments: HitAssignment[],
  hitsOwed: number,
  factionId: FactionId,
  ownedUnitUpgrades: UnitUpgradeId[],
  rules: RuleData,
  /** TE ENTROPIC SCAR: this system's own anomalies — if it's an entropic scar, Sustain Damage ("flip") can't be used here at all, "by or against" units inside it. Optional/omittable for every pre-Thunder's-Edge call site, where this is simply never true. */
  systemAnomalies: import("../types/enums").AnomalyType[] = [],
  /** RR "Metali Void Shielding" (relic): "each time hits are produced against 1 of your non-fighter ships, 1 of those ships may use SUSTAIN DAMAGE as if it had that ability" — true if the OWNING side of these `stacks` has this relic, letting exactly 1 flip bypass the normal ability check below (consumed the first time it's used within this single call; SPACE combat only in practice, since these stacks would be ground forces otherwise, but not explicitly gated on that here since a non-fighter SHIP is the only thing this could ever apply to anyway). */
  metaliVoidShieldingAvailable = false,
  /** Letnev "Non-Euclidean Shielding" (faction tech): true if the OWNING side of these `stacks` has this tech — computed by the caller (who has the full Player object, unlike this function, which only receives factionId/ownedUnitUpgrades) and passed in directly. */
  nonEuclideanShieldingAvailable = false,
  /** L1Z1X "Priority Targeting" (flagship ability): "During a space
   * combat, hits produced by this ship and by your dreadnoughts in this
   * system must be assigned to non-fighter ships if able." Confirmed
   * (yjmrobert.com/tirules/factions/f_lizix — see this file's own note
   * on this flag's own KNOWN SCOPE LIMIT). True when the OWNER of
   * THESE stacks (the side being hit) is being attacked by an L1Z1X
   * player who has their flagship or a dreadnought present in this
   * combat — computed by the caller. KNOWN SCOPE LIMIT: this project
   * aggregates a whole combat round's hits into 1 combined count per
   * player rather than tracking which SPECIFIC attacking unit produced
   * which SPECIFIC hit — so this is applied to ALL of that L1Z1X
   * player's own hits this round once ANY qualifying unit (flagship/
   * dreadnought) is present, not just the exact share of hits that
   * specific unit itself produced. Flagged rather than silently assumed
   * exact.
   */
  mustPreferNonFighterTargets = false,
  /** Mentak Coalition "Fourth Moon" (flagship, Suppress Sustain) / "Moll Terminus" (mech, Suppress Ground Sustain): "Other players' [ships in this system | ground forces on this planet] cannot use SUSTAIN DAMAGE." Confirmed (yjmrobert.com/tirules/factions/f_mentak): Moll Terminus's own suppression ALSO applies to Space Cannon Defense specifically (a mech committed to a planet with both a Moll Terminus and a Mentak PDS cannot use Sustain Damage to cancel Space Cannon hits there either) — since this flag just blocks the "flip" outcome generically for whichever hit-assignment context calls this function, that carries over automatically to every call site (ground combat AND Space Cannon Defense) without extra plumbing. True when the OWNER of these `stacks` (being hit) is NOT Mentak, and Mentak has the relevant unit (Fourth Moon for ships, Moll Terminus for ground forces) present — computed by the caller. */
  sustainDamageSuppressed = false,
  /**
   * CORRECTED (found via testing The Argent Flight's own Raid Formation,
   * which happens to create exactly this scenario): "excess hits beyond
   * total units are simply lost" used to check ALL of the target's
   * remaining units, regardless of whether this specific hit source can
   * even legally target them — Anti-Fighter Barrage can ONLY ever hit
   * fighters (RR 67.1), so a defender with 0 fighters left but other,
   * untouchable ships still present would incorrectly be told "you still
   * have units left, assign more hits" even though nothing legal
   * remains to assign to. When provided, ONLY unit types in this list
   * count toward "is there still something left to soak hits" — every
   * OTHER call site (plain ASSIGN_HITS, Bombardment, Space Cannon) can
   * legally target anything, so they simply omit this and keep counting
   * every unit type, unchanged.
   */
  validTargetUnitTypes?: import("../types/enums").UnitType[],
): ApplyHitAssignmentsResult {
  const updated = stacks.map((s) => ({ ...s }));
  const unitsLeft = updated.reduce((sum, s) => sum + s.count, 0);
  // Letnev "Non-Euclidean Shielding" (faction tech): "When 1 of your units
  // uses SUSTAIN DAMAGE, cancel 2 hits instead of 1." Confirmed
  // (yjmrobert.com/tirules/factions/f_letnev): mandatory (cannot cancel
  // just 1 if 2+ are available), applies to ANY hits (Bombardment, Space
  // Cannon too, not just normal combat), and can't retroactively apply to
  // a PAST Sustain Damage use if more hits show up later. Structurally,
  // this means "how many assignments are required" is no longer simply
  // "1 per hit owed" — a single Non-Euclidean-Shielding flip can cover 2
  // hits at once — so the strict upfront length check below is replaced
  // with an accumulating "hits remaining" tally, checked at the end.
  // RR 67.6/38.2: if hits exceed the units left, every remaining unit is
  // destroyed/flipped and the extra hits are simply lost.
  const maxAssignable = Math.min(hitsOwed, unitsLeft);
  if (assignments.length > maxAssignable) {
    return {
      ok: false,
      error: `${hitsOwed} hit(s) owed, ${unitsLeft} unit(s) left — at most ${maxAssignable} assignment(s) possible, got ${assignments.length}.`,
    };
  }

  const destroyed = new Map<UnitType, number>();
  const flipped = new Map<UnitType, number>();
  let metaliShieldingUsed = false;
  let hitsRemaining = hitsOwed;

  for (const { unitType, outcome } of assignments) {
    const stack = updated.find((s) => s.unitType === unitType && s.count > 0);
    if (!stack) return { ok: false, error: `No ${unitType} left to assign a hit to.` };
    // L1Z1X "Priority Targeting": mandatory — reject a fighter assignment if a non-fighter is available instead.
    if (mustPreferNonFighterTargets && unitType === "fighter" && updated.some((s) => s !== stack && s.unitType !== "fighter" && s.count > 0)) {
      return { ok: false, error: 'L1Z1X "Priority Targeting": this hit must be assigned to a non-fighter ship instead, since one is available.' };
    }

    if (outcome === "flip") {
      if (hasEntropicScar(systemAnomalies)) {
        return { ok: false, error: 'TE ENTROPIC SCAR: Sustain Damage cannot be used by units inside an entropic scar.' };
      }
      // Mentak Coalition "Fourth Moon" / "Moll Terminus": mandatory block — see this function's own param doc above.
      if (sustainDamageSuppressed) {
        return { ok: false, error: "Mentak Coalition's Fourth Moon/Moll Terminus suppresses Sustain Damage here." };
      }
      const effectiveAbilities = getEffectiveUnitAbilities(state, rules, factionId, unitType, ownedUnitUpgrades);
      const usingMetaliShielding = !effectiveAbilities.includes("sustainDamage") && unitType !== "fighter" && metaliVoidShieldingAvailable && !metaliShieldingUsed;
      if (!effectiveAbilities.includes("sustainDamage") && !usingMetaliShielding) {
        return { ok: false, error: `RR 76: ${unitType} doesn't have Sustain Damage.` };
      }
      if (usingMetaliShielding) metaliShieldingUsed = true;
      if (stack.damagedCount >= stack.count) {
        return { ok: false, error: `RR 76: every ${unitType} in this stack is already damaged — this hit must destroy one.` };
      }
      stack.damagedCount += 1;
      flipped.set(unitType, (flipped.get(unitType) ?? 0) + 1);
      // Letnev "Non-Euclidean Shielding": mandatory — cancels 2 hits with this ONE flip whenever 2+ are still owed, never just 1.
      hitsRemaining -= nonEuclideanShieldingAvailable ? Math.min(2, hitsRemaining) : 1;
    } else {
      // Prefer removing an already-damaged unit first — it was one hit from
      // death anyway, so this preserves the stack's remaining sustain buffer.
      if (stack.damagedCount > 0) stack.damagedCount -= 1;
      stack.count -= 1;
      destroyed.set(unitType, (destroyed.get(unitType) ?? 0) + 1);
      hitsRemaining -= 1;
    }
  }

  // Any hits still owed after every submitted assignment is only legal if there are truly no units left to soak them up (RR 67.6: excess hits beyond total units are simply lost) — otherwise the player under-submitted assignments.
  const unitsStillLeft = updated.reduce((sum, s) => (!validTargetUnitTypes || validTargetUnitTypes.includes(s.unitType) ? sum + s.count : sum), 0);
  if (hitsRemaining > 0 && unitsStillLeft > 0) {
    return { ok: false, error: `${hitsRemaining} hit(s) still owed after these assignments, with ${unitsStillLeft} unit(s) still left to assign them to.` };
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
  // TE ENTROPIC SCAR (rulebook p.11): Space Cannon "cannot be used by or against units inside of an entropic scar" — the target system is what matters most here (hits would land on units inside it), covering both Offense and Defense since they share this same function.
  if (hasEntropicScar(state.systems[targetSystemId]?.anomalies ?? [])) return [];

  const perType = new Map<UnitType, { diceCount: number; hitOn: number }>();

  const hasLightrailOrdnance = player.relics.includes("lightrail_ordnance" as never);
  const scanSystem = (systemId: SystemId, requireRangesToAdjacent: boolean) => {
    const system = state.systems[systemId];
    if (!system) return;
    for (const planet of system.planets) {
      const stacks = (planet.unitsByPlayer[firingPlayerId] ?? []) as UnitStack[];
      for (const stack of stacks) {
        if (stack.count <= 0) continue;
        const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
        let sc = stats?.abilityValues?.spaceCannon;
        // RR "Lightrail Ordnance" (relic): "Your space docks gain SPACE CANNON 5 (X2). You may use your space dock's SPACE CANNON against ships that are adjacent to their system." — space docks have no printed Space Cannon at all normally, so this is a virtual grant (with rangesToAdjacent implicitly true, per the relic's own explicit "adjacent" wording) rather than something getUnitStats itself would ever return.
        if (!sc && stack.unitType === "space_dock" && hasLightrailOrdnance) {
          sc = { value: 5, dice: 2, rangesToAdjacent: true };
        }
        if (!sc) continue;
        if (requireRangesToAdjacent && !sc.rangesToAdjacent) continue;
        const existing = perType.get(stack.unitType);
        if (existing) existing.diceCount += stack.count * sc.dice;
        else perType.set(stack.unitType, { diceCount: stack.count * sc.dice, hitOn: sc.value });
      }
    }
  };

  scanSystem(targetSystemId, false);
  // Ghosts of Creuss "QUANTUM ENTANGLEMENT": confirmed (community/FAQ
  // consensus, cross-referenced against yjmrobert.com's own Creuss page)
  // — this expands the FIRING player's own "Deep Space Cannon" reach
  // too (PDS II's own rangesToAdjacent ability), same as it expands
  // movement/neighbor status elsewhere, but is NEVER usable BY OTHER
  // players AGAINST Creuss (since it's Creuss's own ability) — achieved
  // here simply by passing firingPlayerId as forPlayerId, so it only
  // ever applies when the FIRING player themselves is Creuss.
  for (const adjId of getAdjacentSystems(state, targetSystemId, rules, firingPlayerId)) {
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

/**
 * RR 77.2: EVERY player, beginning with the active player and proceeding
 * clockwise — the active player themselves included, not just responders
 * — may use the "Space Cannon" ability of their own units in the active
 * system. Previously the active player was excluded outright, meaning
 * their own PDS (e.g. one left over on a planet there from before this
 * tactical action) could never fire here at all.
 */
export function getSpaceCannonOffenseEligiblePlayers(
  state: GameState,
  rules: RuleData,
  targetSystemId: SystemId,
  activePlayerId: PlayerId,
): PlayerId[] {
  // "Solar Flare": no OTHER player may target the active player's ships with Space Cannon this movement — doesn't stop the active player's own Space Cannon Offense against someone else, so this only ever filters out candidates whose target would be the active player.
  const solarFlareProtectsActivePlayer =
    state.pendingTacticalAction?.systemId === targetSystemId && state.pendingTacticalAction?.solarFlarePlayerId === activePlayerId;
  return Object.keys(state.players)
    .filter((id): id is PlayerId => !state.players[id as PlayerId].eliminated)
    .filter((id) => {
      // RR 77.5b: when the ACTIVE player is the one firing, they choose
      // WHICH other player in the system to target — approximated here
      // (same "exactly 2 combatants" simplification as buildSpaceCombatEntries
      // elsewhere in this file) as "whichever other player has ships here",
      // since this project doesn't support 3+-way combats yet anyway.
      const targetId = id === activePlayerId ? playersWithShipsInSystem(state, targetSystemId).find((pid) => pid !== activePlayerId) : activePlayerId;
      if (!targetId) return false;
      if (solarFlareProtectsActivePlayer && targetId === activePlayerId && id !== activePlayerId) return false;
      return spaceCannonEntriesForPlayer(state, rules, id, targetSystemId, targetId).length > 0;
    });
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
  // The Argent Flight "Quetzecoatl" (flagship, "Space Cannon Immunity"):
  // "Other players cannot use SPACE CANNON against your ships in this
  // system." Confirmed (tirules2.com/F_argent): "a player may still use
  // Space Cannon against the Argent player's GROUND FORCES during the
  // Space Cannon Defense step of an invasion" — so this ONLY blocks
  // Space Cannon OFFENSE (this function specifically), never the
  // separate buildSpaceCannonDefenseEntries below, even though both
  // share the same underlying spaceCannonEntriesForPlayer helper.
  // "Your ships" (not just Quetzecoatl itself) — its presence protects
  // the WHOLE fleet in the system, so this returns no targets at all
  // rather than exempting just the flagship.
  const targetSystem = state.systems[targetSystemId];
  const hasQuetzecoatlHere = (targetSystem?.spaceUnitsByPlayer[targetPlayerId] ?? []).some((s) => {
    if (s.count <= 0) return false;
    const stats = getUnitStats(rules, state.players[targetPlayerId]?.factionId, s.unitType, state.players[targetPlayerId]?.unitUpgrades);
    return stats?.abilities.includes("spaceCannonImmunity") ?? false;
  });
  if (hasQuetzecoatlHere) return [];
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
  /**
   * The Argent Flight "RAID FORMATION"... no wait, this is actually for
   * "Strike Wing Ambuscade" (promissory note) / "Trrakan Aun Zulok"
   * (commander): "When 1 or more of your units make a roll for a unit
   * ability: choose 1 of those units to roll 1 additional die." Both
   * grant the EXACT same bonus (+1 die to this roll) — the only
   * difference is the source's own cost (Ambuscade is consumed and
   * returned to Argent after use; Trrakan Aun Zulok has no cost at all,
   * matching commander abilities generally being repeatable/passive
   * once unlocked, unlike an agent's own exhaust-to-use). Since this
   * project's own dice-count model is an AGGREGATE per firing player
   * (not tracked per individual unit), "choose 1 of those units" is
   * modeled as a flat +1 to the whole roll rather than needing to know
   * WHICH specific unit — functionally identical for the overwhelming
   * majority of cases (a player firing AFB with only 1 unit type).
   */
  hasUnitAbilityDieBonus?: boolean,
): CombatUnitEntry[] {
  const system = state.systems[systemId];
  if (!system) return [];
  // TE ENTROPIC SCAR (rulebook p.11): Anti-Fighter Barrage "cannot be used by or against units inside of an entropic scar."
  if (hasEntropicScar(system.anomalies)) return [];
  // Naalu Collective "Iconoclast Ω" (mech, Codex version): "Other players
  // cannot use ANTI-FIGHTER BARRAGE against your units in this system."
  // Confirmed (yjmrobert.com/tirules/factions/f_naalu): "applies
  // regardless of if the Iconoclast is in the space area or on a planet
  // in the system" — checked across BOTH here. Gated to exactly the
  // Codex version (superseded by ΩΩ under Thunder's Edge, which has no
  // such immunity of its own).
  const hasIconoclastOmegaHere = Object.entries(state.players).some(([pid, p]) => {
    if (pid === firingPlayerId || p.factionId !== ("naalu" as never) || !hasCodex(state.mode) || hasThundersEdge(state.mode)) return false;
    const inSpace = (system.spaceUnitsByPlayer[pid as PlayerId] ?? []).some((s) => s.unitType === "mech" && s.count > 0);
    const onPlanet = system.planets.some((p2) => (p2.unitsByPlayer[pid as PlayerId] ?? []).some((s) => s.unitType === "mech" && s.count > 0));
    return inSpace || onPlanet;
  });
  if (hasIconoclastOmegaHere) return [];
  const player = state.players[firingPlayerId];
  const stacks = (system.spaceUnitsByPlayer[firingPlayerId] ?? []) as UnitStack[];

  let diceCount = 0;
  let hitOn: number | null = null;
  for (const stack of stacks) {
    if (stack.count <= 0) continue;
    const stats = getUnitStatsForCombat(rules, player, stack.unitType, player.unitUpgrades);
    const afb = stats?.abilityValues?.antiFighterBarrage;
    if (!afb) continue;
    diceCount += stack.count * afb.dice;
    hitOn = afb.value;
  }

  // RR "Metali Void Armaments" (relic): "During the Anti-Fighter Barrage step of space combat, you may resolve ANTI-FIGHTER BARRAGE 6 (X3) against your opponent's units" — a virtual AFB source, independent of what unit types this player actually has present. Confirmed ruling: "has no effect when the Argent player resolves their Raid Formation faction ability" — since Raid Formation triggers off the RAW hits produced by AFB (computed in phases/spaceCombat.ts's own useAntiFighterBarrage, right where this entry's own diceCount/hitOn get consumed), a virtual source like this one still correctly feeds into that same computation with no special-casing needed here.
  if (diceCount === 0 && player?.relics.includes("metali_void_armaments" as never)) {
    diceCount = 3;
    hitOn = 6;
  }

  if (diceCount === 0 || hitOn === null) return [];
  if (hasUnitAbilityDieBonus) diceCount += 1;
  // RR FAQ (tirules2.com/C_action_cards): "Morale Boost has no effect on anti-fighter barrage rolls" — despite being playable at the very same "start of combat"/"start of combat round 1" window that precedes AFB (see this project's own reasoning trail on that point, now corrected here), the bonus itself only applies to the round's own NORMAL combat rolls, not to AFB specifically. Earlier version of this file wrongly extended it to AFB; reverted per this more specific ruling.
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
  // "Disable": this attacker's opponents' PDS lose Space Cannon entirely for the rest of the invasion.
  if (state.pendingTacticalAction?.disablePlayerId === attackerId) return [];
  // Letnev "L4 Disruptors" (faction tech): "During an invasion, units cannot use SPACE CANNON against your units." Same "attacker's opponents lose Space Cannon" shape as Disable above, just keyed off the attacker's own technology instead of a card in play.
  if (state.players[attackerId]?.technologies.includes("l4_disruptors" as never)) return [];
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
