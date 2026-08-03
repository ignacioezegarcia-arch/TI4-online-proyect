import { GameState, Player, PlanetState } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, TechId, UnitUpgradeId, PlanetId, AgendaId, asTechId, asAbilityId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { maybeQueueAntiIntellectualRevolutionDestruction, isLawActiveWithOutcome } from "./agendaEffects";
import { hasQuantumcoreUniversalSynergy } from "../rules/relics";
import { hasAbility } from "../rules/abilities";
import { hasCodex, hasThundersEdge } from "../rules/gameMode";

/**
 * RR 90 TECHNOLOGY. There's no general "spend resources, research anything"
 * action in real TI4 — research is always gated behind a specific source
 * (Technology strategy card, some factions/agendas/action cards). These two
 * functions are the shared mechanical core every one of those sources calls
 * (see phases/strategyCardAbilities.ts's Technology card handlers for the
 * main caller today).
 *
 * RR 90.7 prerequisites ARE validated: data/technologies.json's
 * `prerequisites` is a list of colors (one entry per required tech of that
 * color already owned, e.g. ["red","red"] = need 2 red techs). Breakthrough
 * synergy (a faction's paired colors substituting for each other, but never
 * both at once for the same requirement) is applied too, straight from
 * RuleData.factions[...].breakthroughSynergy.
 */

export function researchTechnology(
  state: GameState,
  playerId: PlayerId,
  techId: TechId,
  /** Resources this specific research costs (0 for "free" research, e.g. the Technology strategy card's primary first pick). Paid from resources first, then trade goods. */
  cost: number,
  exhaustPlanetIdsForResources: PlanetId[],
  rules: RuleData,
  /** RR "Research Team" (any of the 4 color variants): exhaust that SPECIFIC planet's own attachment card (not a normal tech) — only legal if this player controls a planet with a matching-color Research Team attached, it isn't already exhausted, and the color actually matches one of THIS tech's own prerequisites. */
  useResearchTeamAttachmentPlanetId?: PlanetId,
  /** RR 90.13-90.15: exhaust any number of controlled planets that have a technology specialty (a base-game mechanic, not PoK-specific) — each one ignores exactly 1 prerequisite of ITS OWN matching color, same "ignore 1, not the whole list" shape as Research Team/AI Development Algorithm, but stackable across multiple planets in a single research. A planet already exhausted (including for resources — this is the SAME exhausted state, not a separate one) cannot be used this way. */
  exhaustPlanetIdsForTechSpecialty?: PlanetId[],
  /** Jol-Nar "ANALYTICAL" (faction ability, passive): "When you research a technology that is not a unit upgrade technology, you may ignore 1 prerequisite." The player's own choice of WHICH color to ignore (the card doesn't specify) — no exhaust/cost, just requires this player to actually own the ability. */
  useAnalyticalIgnoreColor?: string,
  /** Jol-Nar "Doctor Sucaban" (agent): "When a player spends resources to research: you may exhaust this card to allow that player to remove any number of their infantry from the game board. For each unit removed, reduce the resources spent by 1." Confirmed (tirules2.com/F_jol_nar): if the researching player has Infantry II, units removed this way do NOT roll for resurrection. The RESEARCHING player (not necessarily Jol-Nar) lists which of their own infantry to remove; Doctor Sucaban's own exhaustion is handled by the caller (this function only applies the discount + removal, trusting the caller already validated/exhausted the agent). */
  docSucabanRemovedInfantry?: { planetId: PlanetId; count: number }[],
  /** Jol-Nar "Specialized Compounds" (Breakthrough ability): "When researching using the Technology strategy card, you may exhaust 1 tech-specialty planet you control instead of spending resources; that technology must match the exhausted planet's specialty." Confirmed (tirules2.com/F_jol_nar): (1) can't be used for unit upgrades — not applicable to this function at all, since it's only ever called for non-unit-upgrade research; (2) even a tech with 0 (or fully ignored) prerequisites must still match the planet's OWN specialty color to qualify — checked directly against rules.technologies[techId].color, independent of the prerequisite check above; (3) the SAME planet can't both pay via this AND be used to ignore a prerequisite (via exhaustPlanetIdsForTechSpecialty above) in the same research — checked by rejecting overlap. */
  specializedCompoundsPlanetId?: PlanetId,
  /** L1Z1X "Inheritance Systems" (faction tech, exhaustable): "you may exhaust this card and spend 2 resources when you research a technology; ignore all of that technology's prerequisites." Confirmed (yjmrobert.com/tirules/factions/f_lizix): the 2 resources are paid SEPARATELY from the tech's own cost (never combined into one spendForCost call/one exhausted planet) — the planets listed here are exclusively for THIS 2-resource payment, distinct from exhaustPlanetIdsForResources above. */
  useInheritanceSystemsExhaustPlanetIds?: PlanetId[],
): ActionResult {
  const player = state.players[playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (player.technologies.includes(techId)) {
    return { ok: false, error: `RR 90: this player already owns ${techId}.` };
  }

  let workingState = state;
  let effectiveCost = cost;
  if (specializedCompoundsPlanetId) {
    if ((exhaustPlanetIdsForTechSpecialty ?? []).includes(specializedCompoundsPlanetId)) {
      return { ok: false, error: "Specialized Compounds: this planet can't also be used to ignore a prerequisite in the same research." };
    }
    let found: { systemId: import("../types/ids").SystemId; system: import("../types/GameState").SystemState; planet: PlanetState } | null = null;
    for (const [systemId, system] of Object.entries(workingState.systems)) {
      const planet = system.planets.find((p) => p.planetId === specializedCompoundsPlanetId);
      if (planet) {
        found = { systemId: systemId as import("../types/ids").SystemId, system, planet };
        break;
      }
    }
    if (!found || found.planet.controllerId !== playerId || found.planet.exhausted) {
      return { ok: false, error: "Cannot exhaust that planet for Specialized Compounds." };
    }
    const specialties = rules.planets[specializedCompoundsPlanetId]?.techSpecialties ?? [];
    const techColor = rules.technologies[techId]?.color;
    if (!techColor || !specialties.includes(techColor)) {
      return { ok: false, error: `Specialized Compounds: ${techId} must match the exhausted planet's own specialty (${specialties.join("/") || "none"}).` };
    }
    const updatedPlanet: PlanetState = { ...found.planet, exhausted: true };
    workingState = { ...workingState, systems: { ...workingState.systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === specializedCompoundsPlanetId ? updatedPlanet : p)) } } };
    effectiveCost = 0;
  }
  if (docSucabanRemovedInfantry && docSucabanRemovedInfantry.length > 0) {
    const jolNarPlayerId = Object.values(workingState.players).find((p) => p.factionId === ("jolnar" as never))?.id;
    const jolNarPlayer = jolNarPlayerId ? workingState.players[jolNarPlayerId] : undefined;
    const agentEntry = jolNarPlayer?.leaders.find((l) => l.leaderId === ("jolnar_agent" as never));
    if (!agentEntry) return { ok: false, error: "No Jol-Nar player with Doctor Sucaban in this game." };
    if (agentEntry.exhausted) return { ok: false, error: "Doctor Sucaban is already exhausted." };
    workingState = { ...workingState, players: { ...workingState.players, [jolNarPlayerId!]: { ...jolNarPlayer!, leaders: jolNarPlayer!.leaders.map((l) => (l.leaderId === ("jolnar_agent" as never) ? { ...l, exhausted: true } : l)) } } };

    let removedCount = 0;
    for (const { planetId, count } of docSucabanRemovedInfantry) {
      let found: { systemId: import("../types/ids").SystemId; system: import("../types/GameState").SystemState; planet: PlanetState } | null = null;
      for (const [systemId, system] of Object.entries(workingState.systems)) {
        const planet = system.planets.find((p) => p.planetId === planetId);
        if (planet) {
          found = { systemId: systemId as import("../types/ids").SystemId, system, planet };
          break;
        }
      }
      if (!found) return { ok: false, error: `No planet ${planetId}.` };
      const stack = (found.planet.unitsByPlayer[playerId] ?? []).find((s) => s.unitType === "infantry" && s.count > 0);
      if (!stack || stack.count < count) return { ok: false, error: `This player doesn't have ${count} infantry on ${planetId}.` };
      const updatedPlanet: PlanetState = { ...found.planet, unitsByPlayer: { ...found.planet.unitsByPlayer, [playerId]: (found.planet.unitsByPlayer[playerId] ?? []).map((s) => (s === stack ? { ...s, count: s.count - count } : s)).filter((s) => s.count > 0) } };
      workingState = { ...workingState, systems: { ...workingState.systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } } };
      removedCount += count;
    }
    effectiveCost = Math.max(0, effectiveCost - removedCount);
  }
  const ignoreColors: string[] = [];
  if (useAnalyticalIgnoreColor) {
    if (!hasAbility(player, asAbilityId("analytical"))) return { ok: false, error: "This player doesn't have ANALYTICAL." };
    ignoreColors.push(useAnalyticalIgnoreColor);
  }
  let ignoreAllPrerequisites = false;
  if (useInheritanceSystemsExhaustPlanetIds) {
    if (!player.technologies.includes("inheritance_systems" as never)) return { ok: false, error: "This player doesn't have Inheritance Systems." };
    if (player.exhaustedTechnologies.includes("inheritance_systems" as never)) return { ok: false, error: "Inheritance Systems is already exhausted." };
    // Confirmed (yjmrobert.com/tirules/factions/f_lizix): "the 2 resources for Inheritance Systems must be paid IN ADDITION TO AND SEPARATELY FROM any other costs paid to research the technology" — its own standalone spendForCost call, never combined with the tech's own cost above (e.g. a single exhausted planet can't split its resources across both payments in one go).
    const inheritanceSpend = spendForCost(workingState, playerId, 2, useInheritanceSystemsExhaustPlanetIds, rules);
    if (!inheritanceSpend.ok) return inheritanceSpend;
    workingState = { ...inheritanceSpend.state, players: { ...inheritanceSpend.state.players, [playerId]: { ...inheritanceSpend.state.players[playerId], exhaustedTechnologies: [...inheritanceSpend.state.players[playerId].exhaustedTechnologies, "inheritance_systems" as never] } } };
    ignoreAllPrerequisites = true;
  }
  if (useResearchTeamAttachmentPlanetId) {
    const teamResult = useResearchTeamAttachment(workingState, playerId, useResearchTeamAttachmentPlanetId, rules);
    if (!teamResult.ok) return teamResult;
    workingState = teamResult.state;
    ignoreColors.push(teamResult.color);
  }
  for (const planetId of exhaustPlanetIdsForTechSpecialty ?? []) {
    const specialtyResult = exhaustTechSpecialtyPlanet(workingState, playerId, planetId, rules);
    if (!specialtyResult.ok) return specialtyResult;
    workingState = specialtyResult.state;
    ignoreColors.push(...specialtyResult.colors);
  }

  const prereqCheck = checkTechPrerequisites(workingState, playerId, techId, rules, ignoreAllPrerequisites ? rules.technologies[techId]?.prerequisites ?? [] : ignoreColors);
  if (!prereqCheck.met) return { ok: false, error: `RR 90.7: ${prereqCheck.reason}` };

  const spend = spendForCost(workingState, playerId, effectiveCost, exhaustPlanetIdsForResources, rules);
  if (!spend.ok) return spend;

  const updatedPlayer: Player = { ...spend.state.players[playerId], technologies: [...player.technologies, techId] };
  let nextState: GameState = { ...spend.state, players: { ...spend.state.players, [playerId]: updatedPlayer } };
  // RR "Anti-Intellectual Revolution" ("for"): queues a mandatory ship
  // destruction if that law is currently active — see phases/agendaEffects.ts.
  nextState = maybeQueueAntiIntellectualRevolutionDestruction(nextState, playerId);
  return { ok: true, state: nextState, events: [] };
}

/**
 * RR 90.13-90.15: validates + exhausts a controlled planet with a
 * technology specialty (the planet's own normal exhausted state — NOT a
 * separate attachment-style one, per RR 90.15's own "if the planet card
 * is already exhausted, it cannot be used" wording), returning EVERY
 * color specialty it has (usually just 1). TE DUAL SPECIALTIES
 * (rulebook p.11): "these planets can be exhausted... to satisfy either
 * or both prerequisites simultaneously" — so a dual-specialty planet
 * contributes BOTH of its colors' worth of ignore-a-prerequisite at
 * once, from this single exhaust. Previously only the first-found
 * specialty was used at all; fixed.
 */
function exhaustTechSpecialtyPlanet(
  state: GameState,
  playerId: PlayerId,
  planetId: PlanetId,
  rules: RuleData,
): { ok: true; state: GameState; colors: string[] } | { ok: false; error: string } {
  const entry = Object.entries(state.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
  const planet = entry?.[1].planets.find((p) => p.planetId === planetId);
  if (!planet) return { ok: false, error: `No planet ${planetId}.` };
  if (planet.controllerId !== playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };
  const specialties = rules.planets[planetId]?.techSpecialties ?? [];
  if (specialties.length === 0) return { ok: false, error: `${planetId} has no technology specialty.` };
  if (planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };

  const [systemId, system] = entry!;
  const updatedPlanet: PlanetState = { ...planet, exhausted: true };
  const nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } },
  };
  return { ok: true, state: nextState, colors: specialties };
}

/** RR "Research Team" (any color): validates + exhausts the given planet's own attachment card, returning which color's prerequisite it ignores. Shared by researchTechnology/researchUnitUpgrade below. */
function useResearchTeamAttachment(
  state: GameState,
  playerId: PlayerId,
  planetId: PlanetId,
  rules: RuleData,
): { ok: true; state: GameState; color: string } | { ok: false; error: string } {
  const entry = Object.entries(state.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
  const planet = entry?.[1].planets.find((p) => p.planetId === planetId);
  if (!planet) return { ok: false, error: `No planet ${planetId}.` };
  if (planet.controllerId !== playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };

  const researchTeamId = planet.attachmentIds.find((id) => rules.agendas[id as AgendaId]?.attachTechColor);
  const color = researchTeamId ? rules.agendas[researchTeamId as AgendaId]?.attachTechColor : undefined;
  if (!researchTeamId || !color) return { ok: false, error: `${planetId} has no Research Team attached.` };
  if ((planet.exhaustedAttachmentIds ?? []).includes(researchTeamId)) {
    return { ok: false, error: `The Research Team on ${planetId} is already exhausted.` };
  }

  const [systemId, system] = entry!;
  const updatedPlanet: PlanetState = { ...planet, exhaustedAttachmentIds: [...(planet.exhaustedAttachmentIds ?? []), researchTeamId] };
  const nextState: GameState = {
    ...state,
    systems: { ...state.systems, [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } },
  };
  return { ok: true, state: nextState, color };
}

/** RR 90.7: does this player already own enough techs of the required color(s) to research `techId`? Accounts for the player's faction's Breakthrough synergy pair, if any (one color substitutes for the other, never both at once for the same requirement). */
export function checkTechPrerequisites(
  state: GameState,
  playerId: PlayerId,
  techId: TechId,
  rules: RuleData,
  /** RR "Research Team" and/or RR 90.13-90.15's own tech-specialty planets: each entry ignores exactly ONE instance of that color's requirement — stackable across multiple sources in the same research. */
  ignoreColors: string[] = [],
): { met: boolean; reason?: string } {
  const techData = rules.technologies[techId];
  if (!techData) return { met: false, reason: `No rule data for ${techId}.` };
  // TE Breakthroughs: the synergy pair is always present in RuleData for
  // any faction that has one, but doesn't actually apply until this
  // specific player has earned their breakthrough (rules/breakthroughs.ts's
  // own grantBreakthrough) — a fresh game shouldn't get synergy for free.
  const synergy = state.players[playerId]?.hasBreakthrough ? (rules.factions[state.players[playerId].factionId]?.breakthroughSynergy ?? null) : null;
  return checkPrerequisitesAgainst(techData.prerequisites, getOwnedTechColors(state, playerId, rules), synergy, ignoreColors, hasQuantumcoreUniversalSynergy(state, playerId));
}

export function researchUnitUpgrade(
  state: GameState,
  playerId: PlayerId,
  upgradeId: UnitUpgradeId,
  cost: number,
  exhaustPlanetIdsForResources: PlanetId[],
  rules: RuleData,
  /** RR "AI Development Algorithm": exhaust that tech (if owned and readied) to ignore exactly ONE instance of this one color's prerequisite for this specific research (e.g. a "2 red" requirement becomes "1 red") — not the whole prerequisite list. */
  aiDevelopmentAlgorithmIgnoreColor?: string,
  /** RR "Research Team": exhaust that SPECIFIC planet's own attachment card instead — same effect, different source, stackable alongside AI Development Algorithm and/or tech-specialty planets below. */
  useResearchTeamAttachmentPlanetId?: PlanetId,
  /** RR 90.13-90.15: exhaust any number of controlled tech-specialty planets — see researchTechnology's own note on this same parameter. */
  exhaustPlanetIdsForTechSpecialty?: PlanetId[],
): ActionResult {
  const player = state.players[playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (player.unitUpgrades.includes(upgradeId)) {
    return { ok: false, error: `RR 90/86: this player already owns ${upgradeId}.` };
  }

  let workingState: GameState = state;
  const ignoreColors: string[] = [];

  if (useResearchTeamAttachmentPlanetId) {
    const teamResult = useResearchTeamAttachment(workingState, playerId, useResearchTeamAttachmentPlanetId, rules);
    if (!teamResult.ok) return teamResult;
    workingState = teamResult.state;
    ignoreColors.push(teamResult.color);
  }
  if (aiDevelopmentAlgorithmIgnoreColor) {
    const techId = asTechId("ai_development_algorithm");
    const currentPlayer = workingState.players[playerId];
    if (!currentPlayer.technologies.includes(techId)) return { ok: false, error: "This player doesn't own AI Development Algorithm." };
    if (currentPlayer.exhaustedTechnologies.includes(techId)) return { ok: false, error: "AI Development Algorithm is already exhausted." };
    workingState = { ...workingState, players: { ...workingState.players, [playerId]: { ...currentPlayer, exhaustedTechnologies: [...currentPlayer.exhaustedTechnologies, techId] } } };
    ignoreColors.push(aiDevelopmentAlgorithmIgnoreColor);
  }
  for (const planetId of exhaustPlanetIdsForTechSpecialty ?? []) {
    const specialtyResult = exhaustTechSpecialtyPlanet(workingState, playerId, planetId, rules);
    if (!specialtyResult.ok) return specialtyResult;
    workingState = specialtyResult.state;
    ignoreColors.push(...specialtyResult.colors);
  }

  const prereqCheck = checkUnitUpgradePrerequisites(workingState, playerId, upgradeId, rules, ignoreColors);
  if (!prereqCheck.met) return { ok: false, error: `RR 90.7: ${prereqCheck.reason}` };

  const spend = spendForCost(workingState, playerId, cost, exhaustPlanetIdsForResources, rules);
  if (!spend.ok) return spend;

  const updatedPlayer: Player = { ...spend.state.players[playerId], unitUpgrades: [...player.unitUpgrades, upgradeId] };
  let nextState: GameState = { ...spend.state, players: { ...spend.state.players, [playerId]: updatedPlayer } };
  // RR "Anti-Intellectual Revolution" ("for"): unit upgrades ARE
  // technologies (RR 90.6) — this law's own "after a player researches A
  // TECHNOLOGY" trigger doesn't carve out unit upgrades as an exception,
  // so this needed the exact same hook researchTechnology already has.
  // Previously only researching a generic (non-upgrade) technology
  // triggered this.
  nextState = maybeQueueAntiIntellectualRevolutionDestruction(nextState, playerId);
  return { ok: true, state: nextState, events: [] };
}

/** Same as checkTechPrerequisites, but for a unit upgrade tech (data/unitUpgrades.json's own prerequisites). */
export function checkUnitUpgradePrerequisites(
  state: GameState,
  playerId: PlayerId,
  upgradeId: UnitUpgradeId,
  rules: RuleData,
  /** Each entry ignores exactly one instance of that color's requirement — see checkTechPrerequisites' own note. */
  ignoreColors: string[] = [],
): { met: boolean; reason?: string } {
  const upgradeData = rules.unitUpgradeTechData[upgradeId];
  if (!upgradeData) return { met: false, reason: `No rule data for ${upgradeId}.` };

  // RR "Publicize Weapon Schematics" ("for"): confirmed, if ANY player
  // already owns a war sun technology, every player may ignore ALL
  // prerequisites when researching a war sun technology of their own —
  // not just one color's worth, the whole list, only for war-sun-unit-
  // upgrade techs specifically.
  const isWarSunUpgrade = rules.unitUpgrades[upgradeId]?.unitType === "war_sun";
  if (isWarSunUpgrade && isLawActiveWithOutcome(state, "publicize_weapon_schematics" as AgendaId, "for")) {
    const anyoneOwnsWarSun = Object.values(state.players).some((p) => p.unitUpgrades.some((id) => rules.unitUpgrades[id]?.unitType === "war_sun"));
    if (anyoneOwnsWarSun) return { met: true };
  }

  const synergy = state.players[playerId]?.hasBreakthrough ? (rules.factions[state.players[playerId].factionId]?.breakthroughSynergy ?? null) : null;
  return checkPrerequisitesAgainst(upgradeData.prerequisites, getOwnedTechColors(state, playerId, rules), synergy, ignoreColors, hasQuantumcoreUniversalSynergy(state, playerId));
}

/** Every color this player already owns a tech (or unit upgrade — those count too, RR 90.7) in, one entry per tech. */
function getOwnedTechColors(state: GameState, playerId: PlayerId, rules: RuleData): string[] {
  const player = state.players[playerId];
  const fromTechs = player.technologies.map((id) => rules.technologies[id]?.color).filter((c): c is string => Boolean(c));
  const fromUpgrades = player.unitUpgrades.map((id) => rules.unitUpgradeTechData[id]?.color).filter((c): c is string => Boolean(c));
  return [...fromTechs, ...fromUpgrades];
}

function checkPrerequisitesAgainst(
  prerequisites: string[],
  ownedColors: string[],
  synergy: [string, string] | null,
  /** Each entry ignores exactly ONE instance of that color's requirement (e.g. two entries of "red" turn a "2 red" requirement into "0 red") — stackable across however many sources (Research Team, AI Development Algorithm, tech-specialty planets) the caller combined. */
  ignoreColors: string[] = [],
  /** RR "The Quantumcore" (relic): "you have SYNERGY for all technology types" — broader than the normal 2-color faction pair; when true, ALL 4 tech colors count as mutually substitutable for every prerequisite check, ignoring the `synergy` pair above entirely (it would be redundant). */
  universalSynergy = false,
): { met: boolean; reason?: string } {
  if (prerequisites.length === 0) return { met: true };
  const neededByColor = new Map<string, number>();
  for (const color of prerequisites) neededByColor.set(color, (neededByColor.get(color) ?? 0) + 1);

  for (const ignoreColor of ignoreColors) {
    const current = neededByColor.get(ignoreColor) ?? 0;
    if (current > 0) neededByColor.set(ignoreColor, current - 1);
  }

  for (const [color, count] of neededByColor) {
    if (count <= 0) continue;
    let owned = ownedColors.filter((c) => c === color).length;
    if (universalSynergy) {
      owned = ownedColors.length; // any color counts toward any other color's requirement
    } else if (synergy && (synergy[0] === color || synergy[1] === color)) {
      const substituteColor = synergy[0] === color ? synergy[1] : synergy[0];
      owned += ownedColors.filter((c) => c === substituteColor).length;
    }
    if (owned < count) {
      return { met: false, reason: `Needs ${count} ${color} tech(s)${synergy || universalSynergy ? " (or Breakthrough-synergy equivalent)" : ""}, only owns ${owned}.` };
    }
  }
  return { met: true };
}

/** Pays `cost` from exhausting the given planets for resources, falling back to trade goods for any shortfall. Shared by both functions above. */
/**
 * Shared resource-payment logic — spends from specific exhausted
 * planets first (RR 26), falling back to trade goods for the rest.
 * Originally research-only; now also used by phases/production.ts's own
 * executeProduction (previously that function spent from a flat,
 * never-properly-maintained player.resourcesAvailable cache instead of
 * real per-planet exhaustion — see that function's own doc comment,
 * which used to flag this as a known scope cut). Exported so BOTH
 * consumers share the exact same Archon's Gift/Xxekir Grom Ω handling
 * rather than duplicating (and risking drifting) that logic twice.
 */
export function spendForCost(
  state: GameState,
  playerId: PlayerId,
  cost: number,
  exhaustPlanetIdsForResources: PlanetId[],
  rules: RuleData,
  /**
   * Generalized "treat influence as resources for every planet exhausted
   * in THIS call" override, independent of the player's own permanent
   * Xxcha-specific abilities below. Needed because Xxcha's own Archon's
   * Gift/Xxekir Grom Ω aren't the ONLY sources of this exact mechanic —
   * e.g. the "Freelancers" exploration card ("you may spend influence as
   * if it were resources to produce THIS unit") grants it to ANY
   * faction, but only for that one specific production, not
   * permanently. Rather than hardcoding a second faction check for every
   * future source of this same effect, callers can just pass this
   * directly. `true` behaves like Archon's Gift (max of the two per
   * planet); Xxekir Grom Ω's own SUMMED behavior remains its own
   * player-level check below, since no other known source combines
   * rather than maxes.
   */
  treatInfluenceAsResourcesForThisCall = false,
): ActionResult {
  if (cost <= 0) return { ok: true, state, events: [] };

  // Xxcha "Archon's Gift" (Breakthrough ability): "You can spend
  // influence as if it were resources. You can spend resources as if it
  // were influence." Confirmed (yjmrobert.com/tirules/factions/f_xxcha):
  // a single source (a planet) contributes as ONE OR THE OTHER, never
  // split between both — modeled here as simply taking whichever of the
  // 2 values is higher for each exhausted planet, since this player is
  // free to declare it as resources regardless of which is actually
  // printed higher. This function is shared by BOTH research
  // (phases/technology.ts) and production (phases/production.ts), so
  // this fungibility now applies to both, not just research.
  const archonsGiftActive =
    treatInfluenceAsResourcesForThisCall ||
    (state.players[playerId]?.hasBreakthrough && state.players[playerId]?.factionId === ("xxcha" as never));
  // Xxcha "Xxekir Grom — POLITICAL DATA NEXUS Ω" (hero, Codex version,
  // passive — unlike the ΩΩ Thunder's Edge version, which is a single-
  // use purged ACTION): "When you exhaust planets, combine the values of
  // their resources and influence. Treat the combined value as if it
  // were both resources and influence." Confirmed
  // (yjmrobert.com/tirules/factions/f_xxcha): combined value spent as
  // EITHER resources or influence, never both/split (same shape as
  // Archon's Gift, just SUMMED instead of maxed) — "only changes
  // spendable influence/resources, not the value for other purposes"
  // (production limit, Integrated Economy, Elder Qanoj's own unlock,
  // Amass Wealth/Hoard Raw Materials objectives, Mining Initiative,
  // Uprising — none of those touch spendForCost, so unaffected here).
  // Only active if this player's own unlocked hero IS Ω specifically —
  // gated by game mode (Thunder's Edge supersedes with ΩΩ instead).
  const xxekirGromOmegaActive = (() => {
    const p = state.players[playerId];
    if (!p || p.factionId !== ("xxcha" as never) || hasThundersEdge(state.mode) || !hasCodex(state.mode)) return false;
    const heroEntry = p.leaders.find((l) => l.leaderId === ("xxcha_hero" as never));
    return !!heroEntry && !heroEntry.locked;
  })();

  let resources = 0;
  let nextState = state;
  for (const planetId of exhaustPlanetIdsForResources) {
    const entry = Object.entries(nextState.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
    const planet = entry?.[1].planets.find((p) => p.planetId === planetId);
    if (!planet || planet.controllerId !== playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };
    if (planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };
    const data = rules.planets[planetId];
    if (!data) return { ok: false, error: `No static data for ${planetId}.` };
    resources += xxekirGromOmegaActive ? data.resources + data.influence : archonsGiftActive ? Math.max(data.resources, data.influence) : data.resources;
    const [systemId, system] = entry!;
    nextState = {
      ...nextState,
      systems: {
        ...nextState.systems,
        [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? { ...p, exhausted: true } : p)) },
      },
    };
  }

  const player = nextState.players[playerId];
  const fromTradeGoods = Math.max(0, cost - resources);
  if (fromTradeGoods > player.tradeGoods) {
    return { ok: false, error: `Not enough to pay ${cost}: ${resources} from exhausted planets + only ${player.tradeGoods} trade goods.` };
  }

  nextState = {
    ...nextState,
    players: { ...nextState.players, [playerId]: { ...player, tradeGoods: player.tradeGoods - fromTradeGoods } },
  };
  return { ok: true, state: nextState, events: [] };
}
