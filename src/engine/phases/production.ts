import { GameState, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, AgendaId, asTechId } from "../types/ids";
import { UnitType, SHIP_TYPES, GROUND_FORCE_TYPES } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { getMaxNonFighterShips } from "../rules/letnev";
import { getEffectivePlanetStats } from "../rules/planetStats";
import { maybeActivateWormholeNexus } from "../rules/adjacency";
import { hasEntropicScar } from "../rules/anomalies";
import { getEffectiveProducesQuantity, isLawActiveWithOutcome, getLawOwner, isDemilitarizedZone } from "./agendaEffects";
import { maybeAdvanceActivePlayer } from "./actionPhase";
import { checkReinforcementsAvailable } from "../rules/reinforcements";
import { spendForCost } from "./technology";

/**
 * RR 78 STEP 5 — PRODUCTION (RR 58/59), tactical-action version (units
 * produced this way must go in the same system as the producing unit —
 * the separate "second Production" Strategy Card ability that lets you
 * build in a system you're not activating isn't this action, and isn't
 * built yet).
 *
 * SCOPE CUT, flagged rather than silently wrong:
 *  - Production limit for a Space Dock = that planet's resources + 2 (RR
 *    58's base formula). Doesn't yet special-case Space Dock II or any
 *    other producer with a different formula/value — there's currently
 *    only the one Production-granting unit in the data, so there's nothing
 *    to special-case against yet; flagged so it isn't silently assumed
 *    correct once there is.
 *  - RR 26.3/26.3a: structures (PDS, space dock) have no cost in the data
 *    and are rejected outright if attempted here — see the explicit check
 *    right where `stats.cost` is read below. They're placed exclusively
 *    via the "Construction" strategy card (phases/strategyCardAbilities.ts's
 *    placeStructuresFree, which enforces the same 1-space-dock/2-PDS-per-
 *    planet limit as this file's own check further down).
 */
export function produceUnits(
  state: GameState,
  action: {
    type: "PRODUCE_UNITS";
    playerId: PlayerId;
    planetId: PlanetId;
    units: { unitType: UnitType; count: number }[];
    /** RR "AI Development Algorithm"'s OTHER ability (distinct from its unit-upgrade-research one, but shares the same exhausted-state — using either one exhausts the same card): exhaust to reduce this production's combined cost by the number of unit upgrade technologies this player owns. */
    useAiDevelopmentAlgorithmForCost?: boolean;
    /** Hacan "Harrugh Gefhara — GALACTIC SECURITIES NET" (hero, single-use): reduces this production's own cost to 0 (production limits still apply) — see phases/production.ts's own executeProduction for the full doc comment. */
    useHarrughGefharaBonus?: boolean;
    /** RR 26: which of this player's own controlled, unexhausted planets to exhaust for this production's own resource cost — same shape as phases/technology.ts's own RESEARCH_TECHNOLOGY action, reusing that exact same spendForCost function under the hood. */
    exhaustPlanetIdsForResources?: PlanetId[];
    /** "Freelancers" (exploration card): "you may spend influence as if it were resources to produce this unit" — a per-production grant, not a permanent ability. Validated against this player's own real pending grant for this system — see phases/production.ts's own executeProduction. */
    freelancersActive?: boolean;
    /** "Freelancers" (exploration card): only consulted if this player's reinforcements are empty for the unit type being produced — see phases/production.ts's own executeProduction for the full doc comment on this substitution rule. */
    freelancersSubstituteSourceSystemId?: SystemId;
  },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "RR 58: no tactical action in progress for this player." };
  }
  if (pending.step !== "production") {
    return { ok: false, error: `RR 58: expected step "production", got "${pending.step}".` };
  }
  return executeProduction(
    state,
    action.playerId,
    pending.systemId,
    action.planetId,
    action.units,
    rules,
    action.useAiDevelopmentAlgorithmForCost,
    undefined,
    action.useHarrughGefharaBonus,
    action.exhaustPlanetIdsForResources,
    action.freelancersActive,
    action.freelancersSubstituteSourceSystemId,
  );
}

/**
 * The actual RR 58/59 production mechanics, independent of the tactical
 * action context — also called by the Warfare strategy card's secondary
 * ability (RR: "use the Production ability of one of your space docks"
 * outside your own tactical action), which needs the exact same rules but
 * has no pendingTacticalAction to read a systemId from.
 */
export function executeProduction(
  state: GameState,
  playerId: PlayerId,
  systemId: SystemId,
  planetId: PlanetId,
  units: { unitType: UnitType; count: number }[],
  rules: RuleData,
  useAiDevelopmentAlgorithmForCost?: boolean,
  /** RR "Warfare" strategy card's own secondary: confirmed, this specifically invokes ONE space dock's own Production ability — "Minister of Industry"'s combined-limit-across-every-producer-in-the-system bonus does NOT apply here, regardless of who owns that law. Every other caller (a normal tactical action's own Production step, Sling Relay) leaves this false/undefined, where Minister of Industry's bonus applies as normal. */
  singleProducerOnly?: boolean,
  /** Hacan "Harrugh Gefhara — GALACTIC SECURITIES NET" (hero, single-use): "you may reduce the cost of each of your units to 0 during this use of Production. If you do, purge this card." Confirmed (tirules2.com/F_hacan): "Production limits still apply" — only the CHECK against total cost, the ACTUAL resource/trade-good spend and the reinforcements/production-limit checks below all still get validated normally, just with a cost of 0 to pay. */
  useHarrughGefharaBonus?: boolean,
  /** RR 26: which of this player's own controlled, unexhausted planets to exhaust for this production's own resource cost — see produceUnits' own doc comment on this same field. Defaults to empty (paying entirely from trade goods) for callers that don't pass it (e.g. Sling Relay, Warfare's secondary), preserving their own existing behavior. */
  exhaustPlanetIdsForResources?: PlanetId[],
  /** "Freelancers" (exploration card): "you may spend influence as if it were resources to produce THIS unit" — a one-time grant scoped to just this call, not a permanent player ability. Threaded straight through to spendForCost's own generalized override. */
  treatInfluenceAsResourcesForThisProduction = false,
  /**
   * "Freelancers" (exploration card): "if a player wishes to place a
   * unit, but there are none of that type left in their reinforcements,
   * they may remove a unit of that type from any system that does not
   * contain one of their command tokens and place that instead. This
   * unit will be placed undamaged." Confirmed
   * (tirules2.com/C_exploration_cards). Only consulted when the normal
   * reinforcements check below fails AND treatInfluenceAsResourcesForThisProduction
   * is true — this substitution is specific to exploration-card-granted
   * placements like this one, not a general production fallback.
   */
  freelancersSubstituteSourceSystemId?: SystemId,
): ActionResult {
  const system = state.systems[systemId];
  if (!system) return { ok: false, error: `No system ${systemId}.` };
  const planet = system.planets.find((p) => p.planetId === planetId);
  if (!planet) return { ok: false, error: `No planet ${planetId} in ${systemId}.` };
  if (planet.controllerId !== playerId) {
    return { ok: false, error: `RR 58: this player doesn't control ${planetId}.` };
  }
  if (isDemilitarizedZone(planet)) {
    return { ok: false, error: 'RR "Demilitarized Zone": units cannot be produced on this planet.' };
  }
  // TE SPACE STATIONS (rulebook p.10): "structures and ground forces cannot be placed on or committed to space stations."
  if (planet.isSpaceStation && units.some(({ count }) => count > 0)) {
    return { ok: false, error: "TE SPACE STATIONS: no units of any kind can be placed on a space station." };
  }
  // TE ENTROPIC SCAR (rulebook p.11): Production "cannot be used by or against units inside of an entropic scar."
  if (hasEntropicScar(system.anomalies) && units.some(({ count }) => count > 0)) {
    return { ok: false, error: "TE ENTROPIC SCAR: Production cannot be used inside an entropic scar." };
  }

  // RR 14 "Blockaded": a Production-capable unit is blockaded if it's in a
  // system with NO ships of its own player but WITH another player's
  // ships — a blockaded unit can still produce ground forces, just not
  // ships. Previously unchecked entirely.
  const ownShipsHere = (system.spaceUnitsByPlayer[playerId] ?? []).some((s) => s.count > 0);
  const otherPlayersShipsHere = Object.entries(system.spaceUnitsByPlayer).some(([pid, stacks]) => pid !== playerId && (stacks ?? []).some((s) => s.count > 0));
  const isBlockaded = !ownShipsHere && otherPlayersShipsHere;
  if (isBlockaded && units.some(({ unitType, count }) => count > 0 && SHIP_TYPES.includes(unitType))) {
    return { ok: false, error: 'RR "Blockaded": this player has no ships of their own in this system and cannot produce ships here — ground forces are still allowed.' };
  }

  const player = state.players[playerId];
  const producerStacks = planet.unitsByPlayer[playerId] ?? [];
  // RR 58: "a unit's Production ability is always followed by a value...
  // this value is the maximum number of units that unit can produce. If
  // the active player has multiple units [...] with Production, that
  // player can produce up to the COMBINED total." Previously this only
  // ever checked "is ANY Production-capable unit present, if so use the
  // SPACE DOCK's own special 'planet resources + 2' formula" — silently
  // ignoring any OTHER unit's own EXPLICIT Production value entirely
  // (e.g. Arborec's own Letani Warriors, "Production 1"/"Production 2"
  // printed directly on the unit, no planet-resources formula involved).
  // Now correctly sums BOTH kinds of contribution. A unit has the
  // SPECIAL space-dock-style formula when its own Production ability
  // has no explicit numeric value in the data (space docks are the only
  // such case); every other Production-capable unit contributes its own
  // printed value directly. spaceDockLimit/nonSpaceDockLimit are tracked
  // SEPARATELY (not just summed into 1 number) for Arborec's own
  // "MITOSIS" restriction further below ("your space docks cannot
  // produce infantry" — checked against nonSpaceDockLimit specifically).
  let spaceDockLimit = 0;
  let nonSpaceDockLimit = 0;
  let hasAnyProducer = false;
  for (const stack of producerStacks) {
    if (stack.count <= 0) continue;
    const stats = getUnitStats(rules, player.factionId, stack.unitType, player.unitUpgrades);
    if (!stats?.abilities.includes("production")) continue;
    hasAnyProducer = true;
    const explicitValue = stats.abilityValues?.production?.value;
    if (explicitValue == null) {
      if (spaceDockLimit === 0) {
        const planetStats = getEffectivePlanetStats(planet, planetId, rules);
        spaceDockLimit = planetStats.resources + 2;
      }
    } else {
      nonSpaceDockLimit += explicitValue * stack.count;
    }
  }
  if (!hasAnyProducer) {
    return { ok: false, error: `RR 58: no Production-capable unit (e.g. a Space Dock) on ${planetId}.` };
  }
  // RR "War Machine": +4 to the total Production value for this 1 use — a general combat-support bonus, not specifically FROM a space dock, so it goes toward the non-space-dock pool (usable for infantry too, relevant for Arborec's own MITOSIS restriction below).
  if (player.warMachineActive) {
    nonSpaceDockLimit += 4;
  }
  let productionLimit: number = spaceDockLimit + nonSpaceDockLimit;

  // RR "Minister of Industry": confirmed, the owner isn't limited to ONE
  // producer per system — every one of THEIR OWN Production-capable
  // units anywhere in this system (any planet, not just the one they're
  // producing from) contributes its own planet's "resources + 2" to a
  // single COMBINED limit for this production action. A no-op (limit
  // stays exactly as computed above) for every other player, and for the
  // owner too whenever they only have the one producer this system
  // already found. Also a no-op when `singleProducerOnly` is set — see
  // this function's own param doc: the "Warfare" strategy card's
  // secondary specifically invokes ONE space dock's own ability, and
  // this law's own text doesn't extend to that.
  if (!singleProducerOnly && getLawOwner(state, "minister_of_industry" as AgendaId) === playerId) {
    let combinedLimit = 0;
    for (const otherPlanet of system.planets) {
      const stacksHere = otherPlanet.unitsByPlayer[playerId] ?? [];
      for (const s of stacksHere) {
        if (s.count <= 0) continue;
        const otherStats = getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades);
        if (!otherStats?.abilities.includes("production")) continue;
        const explicitValue = otherStats.abilityValues?.production?.value;
        combinedLimit += explicitValue != null ? explicitValue * s.count : getEffectivePlanetStats(otherPlanet, otherPlanet.planetId, rules).resources + 2;
      }
    }
    if (combinedLimit > productionLimit) productionLimit = combinedLimit;
  }

  let totalCost = 0;
  const resolvedUnits: { unitType: UnitType; count: number; unitCost: number }[] = [];
  for (const { unitType, count } of units) {
    if (count <= 0) continue;
    const stats = getUnitStats(rules, player.factionId, unitType, player.unitUpgrades);
    if (!stats) return { ok: false, error: `No stats for ${unitType}.` };
    // RR 26.3/26.3a: a unit with NO cost (structures — PDS, space dock)
    // cannot be produced this way at all; they're placed exclusively via
    // the "Construction" strategy card (or an equivalent effect), never
    // through a Space Dock/etc.'s own Production ability. Previously
    // unchecked: a null cost silently coerced to 0 in the arithmetic
    // below, letting structures be "produced" here for free instead of
    // being rejected outright.
    if (stats.cost == null) {
      return { ok: false, error: `RR 26.3: ${unitType} has no cost and cannot be produced this way — it's placed via the "Construction" strategy card instead.` };
    }
    const perToken = getEffectiveProducesQuantity(state, unitType, stats.producesQuantity ?? 1);
    if (count % perToken !== 0) {
      return { ok: false, error: `RR 58: ${unitType} is produced ${perToken} at a time — ${count} isn't a multiple of that.` };
    }
    const tokens = count / perToken;
    totalCost += tokens * stats.cost;
    resolvedUnits.push({ unitType, count, unitCost: stats.cost });
  }

  // RR: Sarween Tools reduces the COMBINED cost of everything produced in
  // this one action by 1 (not per unit) — applied once here, after the
  // per-unit loop above, floored at 0 so a cheap single unit can't go
  // negative.
  if (totalCost > 0 && player.technologies.includes(asTechId("sarween_tools"))) {
    totalCost = Math.max(0, totalCost - 1);
  }
  // RR "War Machine": reduce the combined cost by 1 too (stacks with Sarween Tools — 2 separate, independent reductions).
  if (totalCost > 0 && player.warMachineActive) {
    totalCost = Math.max(0, totalCost - 1);
  }

  // RR "AI Development Algorithm"'s OTHER ability: exhaust to reduce the
  // combined cost by the number of unit upgrade technologies this player
  // owns — shares the SAME exhausted state as its unit-upgrade-research
  // ability (researchUnitUpgrade), so using either one here exhausts the
  // same card either way.
  let usedAiDevelopmentAlgorithmForCost = false;
  if (useAiDevelopmentAlgorithmForCost && totalCost > 0) {
    const techId = asTechId("ai_development_algorithm");
    if (!player.technologies.includes(techId)) return { ok: false, error: "This player doesn't own AI Development Algorithm." };
    if (player.exhaustedTechnologies.includes(techId)) return { ok: false, error: "AI Development Algorithm is already exhausted." };
    totalCost = Math.max(0, totalCost - player.unitUpgrades.length);
    usedAiDevelopmentAlgorithmForCost = true;
  }

  // Sol's own Breakthrough ability, "Bellum Gloriosum": "When you produce
  // a ship that has capacity, you may also produce any combination of
  // ground forces or fighters up to that ship's capacity; they do not
  // count against your PRODUCTION limit." Confirmed rulings
  // (yjmrobert.com/tirules/factions/f_sol): (1) if producing MULTIPLE
  // capacity ships at once, their COMBINED capacity is what's exempted;
  // (2) the exempt units are still PAID for normally, at their own
  // COMBINED/token cost (e.g. Production 2, producing a dreadnought + 2
  // infantry: 5 resources total, since the infantry PAIR itself is a
  // single 1-resource token — not "infantry cost × 2 individually").
  // Confirmed via this same combined-cost example: only the LIMIT check
  // is exempted, not the actual resource-spending check right after.
  let limitCheckCost = totalCost;
  // Hacan "Harrugh Gefhara — GALACTIC SECURITIES NET" (hero, single-use):
  // "reduce the cost of each of your units to 0 during this use of
  // Production... purge this card." Confirmed: "Production limits still
  // apply" — limitCheckCost above already captured the REAL cost before
  // this zeroes totalCost (the actual amount paid) down to 0, so the
  // limit check right after this whole block still uses the genuine
  // figure while the player pays nothing.
  let usedHarrughGefhara = false;
  if (useHarrughGefharaBonus && totalCost > 0) {
    const heroEntry = player.leaders.find((l) => l.leaderId === ("hacan_hero" as never));
    if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked Harrugh Gefhara." };
    totalCost = 0;
    usedHarrughGefhara = true;
  }
  if (player.hasBreakthrough && player.factionId === ("sol" as never)) {
    const combinedCapacity = units.reduce((sum, u) => {
      if (u.count <= 0) return sum;
      const stats = getUnitStats(rules, player.factionId, u.unitType, player.unitUpgrades);
      return sum + (stats?.capacity ?? 0) * u.count;
    }, 0);
    let ridersLeft = combinedCapacity;
    for (const u of units) {
      if (ridersLeft <= 0) break;
      if (!GROUND_FORCE_TYPES.includes(u.unitType) && u.unitType !== "fighter") continue;
      const stats = getUnitStats(rules, player.factionId, u.unitType, player.unitUpgrades);
      const perToken = getEffectiveProducesQuantity(state, u.unitType, stats?.producesQuantity ?? 1);
      // Exemption only applies to whole TOKENS (e.g. a full pair of
      // infantry) — a leftover single unit that can't form a complete
      // token still counts fully against the limit, same as it would
      // cost a full token's worth of resources on its own.
      const exemptUnits = Math.min(u.count, ridersLeft) - (Math.min(u.count, ridersLeft) % perToken);
      if (exemptUnits <= 0) continue;
      const exemptTokens = exemptUnits / perToken;
      limitCheckCost -= exemptTokens * (stats?.cost ?? 0);
      ridersLeft -= exemptUnits;
    }
  }

  if (limitCheckCost > productionLimit) {
    return { ok: false, error: `RR 58: total cost ${limitCheckCost} exceeds this Space Dock's Production limit (${productionLimit}).` };
  }

  // Arborec "MITOSIS" (faction ability): "Your space docks cannot
  // produce infantry." Confirmed (yjmrobert.com/tirules/factions/f_arborec
  // and the Fandom wiki's own FAQ): "Production value from Arborec space
  // docks cannot be used to produce infantry, even if the Arborec player
  // controls other units that have Production in the same system" — so
  // infantry's own cost specifically must be coverable by nonSpaceDockLimit
  // alone (Letani Warriors' own Production value + War Machine), never
  // drawing on spaceDockLimit. Confirmed separately: "the produced
  // infantry may be placed on the SAME planet as the space dock,
  // regardless of if that planet contains any Letani Warriors" — a
  // PLACEMENT clarification only, not relevant to this cost check.
  if (player.factionId === ("arborec" as never)) {
    const infantryCost = resolvedUnits
      .filter((u) => u.unitType === "infantry")
      .reduce((sum, u) => sum + (u.count / getEffectiveProducesQuantity(state, "infantry", 2)) * u.unitCost, 0);
    if (infantryCost > nonSpaceDockLimit) {
      return { ok: false, error: `MITOSIS: your space docks cannot produce infantry — this ${infantryCost}-resource infantry cost exceeds your other units' own combined Production value (${nonSpaceDockLimit}).` };
    }
  }
  // "Freelancers" (exploration card): validated here — the flag alone
  // isn't trusted; this player must actually hold an unused grant for
  // THIS system, and "produce 1 unit" is a hard cap of exactly 1 (not
  // "up to 1", though the card's own "may" already makes 0 the trivial
  // alternative of just not using it — this project's own convention is
  // to reject a MISMATCHED count rather than silently ignore the flag).
  if (treatInfluenceAsResourcesForThisProduction) {
    const grants = state.players[playerId]?.pendingFreelancersGrants ?? [];
    if (!grants.includes(systemId)) {
      return { ok: false, error: "Freelancers: this player has no unused grant for this system." };
    }
    const totalUnitsThisCall = units.reduce((sum, u) => sum + u.count, 0);
    if (totalUnitsThisCall !== 1) {
      return { ok: false, error: "Freelancers: grants exactly 1 unit's worth of production, no more and no less." };
    }
  }

  // RR 26: real per-planet resource exhaustion (previously this function
  // spent from a flat, never-properly-maintained player.resourcesAvailable
  // cache instead — see phases/technology.ts's own spendForCost, now
  // shared between both consumers so Xxcha's Archon's Gift/Xxekir Grom Ω
  // apply here too, not just to research).
  const spend = spendForCost(state, playerId, totalCost, exhaustPlanetIdsForResources ?? [], rules, treatInfluenceAsResourcesForThisProduction);
  if (!spend.ok) return spend;
  let state2 = spend.state;
  if (treatInfluenceAsResourcesForThisProduction) {
    const consumerPlayer = state2.players[playerId];
    const grants = consumerPlayer.pendingFreelancersGrants ?? [];
    const idx = grants.indexOf(systemId);
    const updatedGrants = idx >= 0 ? [...grants.slice(0, idx), ...grants.slice(idx + 1)] : grants;
    state2 = { ...state2, players: { ...state2.players, [playerId]: { ...consumerPlayer, pendingFreelancersGrants: updatedGrants } } };
  }
  const player2 = state2.players[playerId];
  const system2 = state2.systems[systemId];
  const planet2 = system2.planets.find((p) => p.planetId === planetId)!;

  let updatedSpaceStacks = (system2.spaceUnitsByPlayer[playerId] ?? []).map((s) => ({ ...s }));
  let updatedPlanetStacks = (planet2.unitsByPlayer[playerId] ?? []).map((s) => ({ ...s }));
  const events: GameEvent[] = [];

  // RR 58 (structures): confirmed limits — at most 2 PDS and 1 space dock
  // per planet, counting ALL players' units there together (these are
  // physical board limits, not per-player). RR "Homeland Defense Act"
  // ("for"): while that law is active, the PDS limit specifically is
  // lifted — the space dock limit is untouched, the card's own text only
  // ever mentions PDS.
  const pdsLimitLifted = isLawActiveWithOutcome(state, "homeland_defense_act" as AgendaId, "for");
  for (const { unitType, count } of resolvedUnits) {
    if (unitType !== "pds" && unitType !== "space_dock") continue;
    const limit = unitType === "pds" ? 2 : 1;
    if (unitType === "pds" && pdsLimitLifted) continue;
    const existingOnPlanet = Object.values(planet.unitsByPlayer)
      .flat()
      .filter((s): s is NonNullable<typeof s> => Boolean(s) && s!.unitType === unitType)
      .reduce((sum, s) => sum + s!.count, 0);
    if (existingOnPlanet + count > limit) {
      return { ok: false, error: `RR 58: ${planetId} can have at most ${limit} ${unitType}(s); it already has ${existingOnPlanet}.` };
    }
  }

  // RR 37.1/76.2: producing non-fighter ships can't push this player's
  // total in this system above their own fleet pool — same upfront-
  // validation approach as MOVE_SHIPS' own equivalent check (see that
  // file's own note on why this project rejects rather than reactively
  // prompts for which excess ship to remove).
  const existingNonFighterShips = (system.spaceUnitsByPlayer[playerId] ?? []).filter((s) => SHIP_TYPES.includes(s.unitType) && s.unitType !== "fighter").reduce((sum, s) => sum + s.count, 0);
  const newNonFighterShips = resolvedUnits.filter((u) => SHIP_TYPES.includes(u.unitType) && u.unitType !== "fighter").reduce((sum, u) => sum + u.count, 0);
  const maxNonFighterShips = getMaxNonFighterShips(player);
  if (existingNonFighterShips + newNonFighterShips > maxNonFighterShips) {
    return { ok: false, error: `RR 37.1: producing these ships would leave ${existingNonFighterShips + newNonFighterShips} non-fighter ships in ${systemId}, exceeding this player's fleet pool (${maxNonFighterShips}).` };
  }

  // RR 16.3: newly-produced fighters land in the space area (ground
  // forces produced this same way go straight onto the planet instead,
  // per this function's own existing isShip split below — so they're not
  // a capacity concern here) — their combined total with whatever
  // fighters/ground forces are ALREADY sitting there can't exceed the
  // combined capacity of every one of this player's OWN ships in the
  // system, including any being produced in this same batch. Previously
  // unchecked entirely.
  const newFighters = resolvedUnits.filter((u) => u.unitType === "fighter").reduce((sum, u) => sum + u.count, 0);
  if (newFighters > 0) {
    const existingCargo = (system.spaceUnitsByPlayer[playerId] ?? []).reduce((sum, s) => (s.unitType === "fighter" || GROUND_FORCE_TYPES.includes(s.unitType) ? sum + s.count : sum), 0);
    const existingCapacity = (system.spaceUnitsByPlayer[playerId] ?? []).reduce((sum, s) => {
      if (!SHIP_TYPES.includes(s.unitType)) return sum;
      const shipStats = getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades);
      return sum + (shipStats?.capacity ?? 0) * s.count;
    }, 0);
    const newCapacity = resolvedUnits.reduce((sum, u) => {
      if (!SHIP_TYPES.includes(u.unitType)) return sum;
      const shipStats = getUnitStats(rules, player.factionId, u.unitType, player.unitUpgrades);
      return sum + (shipStats?.capacity ?? 0) * u.count;
    }, 0);
    if (existingCargo + newFighters > existingCapacity + newCapacity) {
      return { ok: false, error: `RR 16.3: producing these fighters would leave ${existingCargo + newFighters} fighters/ground forces in ${systemId}'s space area, exceeding this player's combined ship capacity there (${existingCapacity + newCapacity}).` };
    }
  }

  // RR / reinforcements: can't produce more of a capped unit type than
  // this player has left in their box (see rules/reinforcements.ts's own
  // doc comments — infantry/fighter are exempt, everything else isn't).
  const reinforcementsCheck = checkReinforcementsAvailable(state, playerId, resolvedUnits);
  let freelancersSubstituteRemoval: { systemId: SystemId; unitType: UnitType } | null = null;
  if (!reinforcementsCheck.ok) {
    if (!treatInfluenceAsResourcesForThisProduction || !freelancersSubstituteSourceSystemId || resolvedUnits.length !== 1) {
      return reinforcementsCheck;
    }
    const substituteSystem = state.systems[freelancersSubstituteSourceSystemId];
    if (!substituteSystem) return { ok: false, error: `No system ${freelancersSubstituteSourceSystemId}.` };
    if (player.commandTokens.onBoard.includes(freelancersSubstituteSourceSystemId)) {
      return { ok: false, error: "Freelancers: the substitute system cannot contain this player's own command token." };
    }
    const { unitType } = resolvedUnits[0];
    const isShip = SHIP_TYPES.includes(unitType);
    const hasMatchingUnit = isShip
      ? (substituteSystem.spaceUnitsByPlayer[playerId] ?? []).some((s) => s.unitType === unitType && s.count > 0)
      : substituteSystem.planets.some((p) => (p.unitsByPlayer[playerId] ?? []).some((s) => s.unitType === unitType && s.count > 0));
    if (!hasMatchingUnit) {
      return { ok: false, error: `Freelancers: no ${unitType} of this player's own in ${freelancersSubstituteSourceSystemId} to relocate.` };
    }
    freelancersSubstituteRemoval = { systemId: freelancersSubstituteSourceSystemId, unitType };
  }

  for (const { unitType, count, unitCost } of resolvedUnits) {
    const isShip = SHIP_TYPES.includes(unitType);
    const target = isShip ? updatedSpaceStacks : updatedPlanetStacks;
    const existing = target.find((s) => s.unitType === unitType && !s.upgradeId);
    if (existing) existing.count += count;
    else target.push({ unitType, count, damagedCount: 0 });
    if (isShip) updatedSpaceStacks = target;
    else updatedPlanetStacks = target;
    events.push({
      type: "UNITS_PRODUCED",
      playerId,
      systemId,
      planetId,
      unitType,
      count,
      totalCost: (count / getEffectiveProducesQuantity(state, unitType, getUnitStats(rules, player.factionId, unitType, player.unitUpgrades)?.producesQuantity ?? 1)) * unitCost,
    });
  }

  const updatedPlanet: PlanetState = { ...planet2, unitsByPlayer: { ...planet2.unitsByPlayer, [playerId]: updatedPlanetStacks } };
  const updatedSystem: SystemState = {
    ...system2,
    spaceUnitsByPlayer: { ...system2.spaceUnitsByPlayer, [playerId]: updatedSpaceStacks },
    planets: system2.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)),
  };

  // RR "Prophecy of Ixth": confirmed, checked on EVERY Production use by
  // the owner (not just this one specific dock) — if fewer than 2
  // fighters are produced this time, the card is discarded immediately.
  const fightersProduced = resolvedUnits.filter((u) => u.unitType === "fighter").reduce((sum, u) => sum + u.count, 0);
  const isProphecyOfIxthOwner = getLawOwner(state2, "prophecy_of_ixth" as AgendaId) === playerId;
  const agendaDeck = isProphecyOfIxthOwner && fightersProduced < 2
    ? { ...state2.agendaDeck, lawsInPlay: state2.agendaDeck.lawsInPlay.filter((l) => l.agendaId !== "prophecy_of_ixth") }
    : state2.agendaDeck;

  let nextState: GameState = {
    ...state2,
    agendaDeck,
    systems: { ...state2.systems, [systemId]: updatedSystem },
    players: {
      ...state2.players,
      [playerId]: {
        ...player2,
        exhaustedTechnologies: usedAiDevelopmentAlgorithmForCost
          ? [...player2.exhaustedTechnologies, asTechId("ai_development_algorithm")]
          : player2.exhaustedTechnologies,
        warMachineActive: false,
        leaders: usedHarrughGefhara ? player2.leaders.filter((l) => l.leaderId !== ("hacan_hero" as never)) : player2.leaders,
      },
    },
  };

  // "Freelancers": the substitute unit actually gets removed from its origin system here — RR confirms it's placed "undamaged" at the destination, which is already this function's own default for every newly-produced unit (no special handling needed beyond the relocation itself).
  if (freelancersSubstituteRemoval) {
    const { systemId: srcSystemId, unitType } = freelancersSubstituteRemoval;
    const srcSystem = nextState.systems[srcSystemId];
    const isShip = SHIP_TYPES.includes(unitType);
    if (isShip) {
      const stacks = srcSystem.spaceUnitsByPlayer[playerId] ?? [];
      const stack = stacks.find((s) => s.unitType === unitType && s.count > 0)!;
      const updatedStacks = stacks.map((s) => (s === stack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
      nextState = { ...nextState, systems: { ...nextState.systems, [srcSystemId]: { ...srcSystem, spaceUnitsByPlayer: { ...srcSystem.spaceUnitsByPlayer, [playerId]: updatedStacks } } } };
    } else {
      const srcPlanet = srcSystem.planets.find((p) => (p.unitsByPlayer[playerId] ?? []).some((s) => s.unitType === unitType && s.count > 0))!;
      const stacks = srcPlanet.unitsByPlayer[playerId] ?? [];
      const stack = stacks.find((s) => s.unitType === unitType && s.count > 0)!;
      const updatedStacks = stacks.map((s) => (s === stack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
      const updatedSrcPlanet = { ...srcPlanet, unitsByPlayer: { ...srcPlanet.unitsByPlayer, [playerId]: updatedStacks } };
      nextState = { ...nextState, systems: { ...nextState.systems, [srcSystemId]: { ...srcSystem, planets: srcSystem.planets.map((p) => (p.planetId === srcPlanet.planetId ? updatedSrcPlanet : p)) } } };
    }
  }

  // Hacan "Auto-Factories" (Breakthrough ability): "When you produce 3 or more non-fighter ships, place 1 command token from your reinforcements into your fleet pool." Counted across THIS single production batch (the units parameter as a whole), not per-unit-type.
  const nonFighterShipsProduced = units.filter((u) => SHIP_TYPES.includes(u.unitType) && u.unitType !== "fighter").reduce((sum, u) => sum + u.count, 0);
  if (nonFighterShipsProduced >= 3 && player.hasBreakthrough && player.factionId === ("hacan" as never)) {
    const finalPlayer = nextState.players[playerId];
    const { tactic, fleet, strategy, onBoard } = finalPlayer.commandTokens;
    if (tactic + fleet + strategy + onBoard.length < 16) {
      nextState = { ...nextState, players: { ...nextState.players, [playerId]: { ...finalPlayer, commandTokens: { ...finalPlayer.commandTokens, fleet: finalPlayer.commandTokens.fleet + 1 } } } };
    }
  }

  // RR 100.2: placing a unit (via Production) directly into the wormhole
  // nexus system also flips it active — previously only covered for
  // ships arriving via MOVE_SHIPS and for gaining control of Mallice.
  return { ok: true, state: maybeActivateWormholeNexus(nextState, rules, systemId), events };
}

/** RR 78: closes out the tactical action and advances the turn — see this action's own doc comment in Actions.ts for why it had to exist. */
export function finishTacticalAction(
  state: GameState,
  action: { type: "FINISH_TACTICAL_ACTION"; playerId: PlayerId },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) {
    return { ok: false, error: "RR 78: no tactical action in progress for this player." };
  }
  if (pending.step !== "production") {
    return { ok: false, error: `RR 78: a tactical action can only be finished from the "production" step, currently at "${pending.step}".` };
  }

  // Sardakk N'orr "T'ro" (agent): "At the end of a player's tactical action" — tracked here so useTro (rules/sardakk.ts) has something concrete to validate against, since it benefits the OTHER player (whoever's action just ended), not N'orr themselves.
  const nextState = maybeAdvanceActivePlayer({ ...state, pendingTacticalAction: null, lastCompletedTacticalAction: { playerId: action.playerId, systemId: pending.systemId } }, action.playerId, rules);
  return { ok: true, state: nextState, events: [] };
}
