import { PlanetState } from "../types/GameState";
import { PlanetId } from "../types/ids";
import { RuleData } from "../types/RuleData";

/**
 * RR 35: a planet's EFFECTIVE resources/influence/tech-specialties — base
 * static data (RuleData.planets) plus whatever exploration-card attachments
 * are on it (PlanetState.attachmentIds), which some objectives and
 * Production's limit calculation need to get right. Before this existed,
 * both silently used only the base values, ignoring attachment bonuses.
 *
 * Only handles the numeric bonuses that were worth structuring (see
 * data/explorationCards.json's own note on the 11 attach cards) — an
 * attachment's other text effects (e.g. Demilitarized Zone's placement
 * restriction, Tomb of Emphidia's relic-holder VP) aren't applied anywhere,
 * same deferred-content scope cut as action/agenda cards.
 *
 * Safe to call even in Base-only games: attachmentIds is just always empty
 * there (EXPLORE_PLANET is rejected outright for mode "base" — see
 * phases/exploration.ts), so this silently reduces to the plain base stats.
 */
export function getEffectivePlanetStats(
  planet: PlanetState,
  planetId: PlanetId,
  rules: RuleData,
): { resources: number; influence: number; techSpecialties: string[] } {
  const base = rules.planets[planetId];
  let resources = base?.resources ?? 0;
  let influence = base?.influence ?? 0;
  const techSpecialties = [...(base?.techSpecialties ?? [])];

  for (const attachmentId of planet.attachmentIds) {
    const card = rules.explorationCards[attachmentId];
    if (!card) continue;

    if (card.techSpecialtyBonus) {
      if (techSpecialties.length > 0) {
        // RR: "if this planet already has a technology specialty, resource/influence values are each increased by 1 instead."
        resources += card.fallbackResourceBonus ?? 0;
        influence += card.fallbackInfluenceBonus ?? 0;
      } else {
        techSpecialties.push(card.techSpecialtyBonus);
      }
    }
    resources += card.resourceBonus ?? 0;
    influence += card.influenceBonus ?? 0;
  }

  // RR agenda-attachment cards (Core Mining, Senate Sanctuary, Terraforming
  // Initiative) — a small, fixed set of numeric bonuses, hardcoded here
  // rather than adding a whole parallel RuleData lookup for just 3 cases
  // (unlike exploration-card attachments above, which are genuinely
  // data-driven across ~11 different cards).
  if (planet.attachmentIds.includes("core_mining")) resources += 2;
  if (planet.attachmentIds.includes("senate_sanctuary")) influence += 2;
  if (planet.attachmentIds.includes("terraforming_initiative")) {
    resources += 1;
    influence += 1;
  }

  return { resources, influence, techSpecialties };
}
