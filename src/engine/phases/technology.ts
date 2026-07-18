import { GameState, Player } from "../types/GameState";
import { ActionResult } from "../types/Actions";
import { PlayerId, TechId, UnitUpgradeId, PlanetId, asTechId } from "../types/ids";
import { RuleData } from "../types/RuleData";

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
): ActionResult {
  const player = state.players[playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (player.technologies.includes(techId)) {
    return { ok: false, error: `RR 90: this player already owns ${techId}.` };
  }

  const prereqCheck = checkTechPrerequisites(state, playerId, techId, rules);
  if (!prereqCheck.met) return { ok: false, error: `RR 90.7: ${prereqCheck.reason}` };

  const spend = spendForCost(state, playerId, cost, exhaustPlanetIdsForResources, rules);
  if (!spend.ok) return spend;

  const updatedPlayer: Player = { ...spend.state.players[playerId], technologies: [...player.technologies, techId] };
  const nextState: GameState = { ...spend.state, players: { ...spend.state.players, [playerId]: updatedPlayer } };
  return { ok: true, state: nextState, events: [] };
}

/** RR 90.7: does this player already own enough techs of the required color(s) to research `techId`? Accounts for the player's faction's Breakthrough synergy pair, if any (one color substitutes for the other, never both at once for the same requirement). */
export function checkTechPrerequisites(
  state: GameState,
  playerId: PlayerId,
  techId: TechId,
  rules: RuleData,
): { met: boolean; reason?: string } {
  const techData = rules.technologies[techId];
  if (!techData) return { met: false, reason: `No rule data for ${techId}.` };
  const synergy = rules.factions[state.players[playerId].factionId]?.breakthroughSynergy ?? null;
  return checkPrerequisitesAgainst(techData.prerequisites, getOwnedTechColors(state, playerId, rules), synergy);
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
): ActionResult {
  const player = state.players[playerId];
  if (!player) return { ok: false, error: "Unknown player." };
  if (player.unitUpgrades.includes(upgradeId)) {
    return { ok: false, error: `RR 90/86: this player already owns ${upgradeId}.` };
  }

  let workingPlayer = player;
  if (aiDevelopmentAlgorithmIgnoreColor) {
    const techId = asTechId("ai_development_algorithm");
    if (!player.technologies.includes(techId)) return { ok: false, error: "This player doesn't own AI Development Algorithm." };
    if (player.exhaustedTechnologies.includes(techId)) return { ok: false, error: "AI Development Algorithm is already exhausted." };
    const prereqCheck = checkUnitUpgradePrerequisites(state, playerId, upgradeId, rules, aiDevelopmentAlgorithmIgnoreColor);
    if (!prereqCheck.met) return { ok: false, error: `RR 90.7: ${prereqCheck.reason}` };
    workingPlayer = { ...player, exhaustedTechnologies: [...player.exhaustedTechnologies, techId] };
  } else {
    const prereqCheck = checkUnitUpgradePrerequisites(state, playerId, upgradeId, rules);
    if (!prereqCheck.met) return { ok: false, error: `RR 90.7: ${prereqCheck.reason}` };
  }

  const stateWithExhaust: GameState = { ...state, players: { ...state.players, [playerId]: workingPlayer } };
  const spend = spendForCost(stateWithExhaust, playerId, cost, exhaustPlanetIdsForResources, rules);
  if (!spend.ok) return spend;

  const updatedPlayer: Player = { ...spend.state.players[playerId], unitUpgrades: [...player.unitUpgrades, upgradeId] };
  const nextState: GameState = { ...spend.state, players: { ...spend.state.players, [playerId]: updatedPlayer } };
  return { ok: true, state: nextState, events: [] };
}

/** Same as checkTechPrerequisites, but for a unit upgrade tech (data/unitUpgrades.json's own prerequisites). */
export function checkUnitUpgradePrerequisites(
  state: GameState,
  playerId: PlayerId,
  upgradeId: UnitUpgradeId,
  rules: RuleData,
  /** RR "AI Development Algorithm": ignore exactly one instance of this one color's requirement. */
  ignoreOnePrerequisiteOfColor?: string,
): { met: boolean; reason?: string } {
  const upgradeData = rules.unitUpgradeTechData[upgradeId];
  if (!upgradeData) return { met: false, reason: `No rule data for ${upgradeId}.` };
  const synergy = rules.factions[state.players[playerId].factionId]?.breakthroughSynergy ?? null;
  return checkPrerequisitesAgainst(upgradeData.prerequisites, getOwnedTechColors(state, playerId, rules), synergy, ignoreOnePrerequisiteOfColor);
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
  /** RR "AI Development Algorithm": ignores exactly ONE instance of this one color's requirement (e.g. a "2 red" requirement becomes "1 red") — not the whole prerequisite list. */
  ignoreOnePrerequisiteOfColor?: string,
): { met: boolean; reason?: string } {
  if (prerequisites.length === 0) return { met: true };
  const neededByColor = new Map<string, number>();
  for (const color of prerequisites) neededByColor.set(color, (neededByColor.get(color) ?? 0) + 1);

  if (ignoreOnePrerequisiteOfColor) {
    const current = neededByColor.get(ignoreOnePrerequisiteOfColor) ?? 0;
    if (current > 0) neededByColor.set(ignoreOnePrerequisiteOfColor, current - 1);
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
