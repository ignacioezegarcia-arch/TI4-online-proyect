import { GameState, Player, PlanetState } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, TechId, UnitUpgradeId, PlanetId, AgendaId, asTechId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { maybeQueueAntiIntellectualRevolutionDestruction, isLawActiveWithOutcome } from "./agendaEffects";

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
): ActionResult {
  const player = state.players[playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (player.technologies.includes(techId)) {
    return { ok: false, error: `RR 90: this player already owns ${techId}.` };
  }

  let workingState = state;
  const ignoreColors: string[] = [];
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

  const prereqCheck = checkTechPrerequisites(workingState, playerId, techId, rules, ignoreColors);
  if (!prereqCheck.met) return { ok: false, error: `RR 90.7: ${prereqCheck.reason}` };

  const spend = spendForCost(workingState, playerId, cost, exhaustPlanetIdsForResources, rules);
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
  return checkPrerequisitesAgainst(techData.prerequisites, getOwnedTechColors(state, playerId, rules), synergy, ignoreColors);
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
  return checkPrerequisitesAgainst(upgradeData.prerequisites, getOwnedTechColors(state, playerId, rules), synergy, ignoreColors);
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
    if (synergy && (synergy[0] === color || synergy[1] === color)) {
      const substituteColor = synergy[0] === color ? synergy[1] : synergy[0];
      owned += ownedColors.filter((c) => c === substituteColor).length;
    }
    if (owned < count) {
      return { met: false, reason: `Needs ${count} ${color} tech(s)${synergy ? " (or Breakthrough-synergy equivalent)" : ""}, only owns ${owned}.` };
    }
  }
  return { met: true };
}

/** Pays `cost` from exhausting the given planets for resources, falling back to trade goods for any shortfall. Shared by both functions above. */
function spendForCost(
  state: GameState,
  playerId: PlayerId,
  cost: number,
  exhaustPlanetIdsForResources: PlanetId[],
  rules: RuleData,
): ActionResult {
  if (cost <= 0) return { ok: true, state, events: [] };

  let resources = 0;
  let nextState = state;
  for (const planetId of exhaustPlanetIdsForResources) {
    const entry = Object.entries(nextState.systems).find(([, s]) => s.planets.some((p) => p.planetId === planetId));
    const planet = entry?.[1].planets.find((p) => p.planetId === planetId);
    if (!planet || planet.controllerId !== playerId) return { ok: false, error: `This player doesn't control ${planetId}.` };
    if (planet.exhausted) return { ok: false, error: `${planetId} is already exhausted.` };
    const data = rules.planets[planetId];
    if (!data) return { ok: false, error: `No static data for ${planetId}.` };
    resources += data.resources;
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
