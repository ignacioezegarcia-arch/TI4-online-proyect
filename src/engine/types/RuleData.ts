import { FactionId, AgendaId, ObjectiveId, PlanetId, TechId, UnitUpgradeId } from "./ids";
import { ObjectiveKind, UnitAbility, UnitType } from "./enums";

/**
 * Static, game-content data the engine's pure functions read but never
 * mutate. GameState answers "what is currently true"; RuleData answers
 * "what are the rules of a cruiser" — it's effectively your existing
 * data/units.json + unitUpgrades.json + factions/*.json + technologies.json,
 * loaded once and passed into every GameEngine call. Keeping it separate
 * from GameState means the (much bigger) content JSON never has to be
 * diffed/re-sent over Supabase Realtime — only GameState changes per action.
 *
 * NOTE: shape below is a minimal slice covering what phases/tacticalAction.ts
 * needs today (move values, for RR 49.3). Extend as each new phase handler
 * needs more (combat values for space/ground combat, production values,
 * capacity, ability ids, prerequisites for research, etc.) rather than
 * front-loading the whole schema now — data/units.json etc. already has
 * the full content, this is just the typed read-path into it.
 */
export interface UnitStats {
  unitType: UnitType;
  cost: number;
  combat: number | null; // null for structures with no combat value (e.g. space dock)
  /** How many dice this unit rolls in *normal* combat (space or ground — both use this same stat). Undefined/1 when `combat` is set and the unit doesn't say otherwise; irrelevant when combat is null. Distinct from abilityValues' AFB/Bombardment/Space Cannon dice counts, which are separate sub-mechanics with their own dice pools. */
  combatDiceCount?: number;
  move: number | null;
  capacity: number | null;
  /** RR 58: how many units one "produce" action yields for `cost` (e.g. Fighter/Infantry = 2 per token). Defaults to 1 when the data doesn't say otherwise. */
  producesQuantity?: number;
  abilities: UnitAbility[];
  /** e.g. Anti-Fighter Barrage X(Y) -> {value: X, dice: Y}; Bombardment 5 -> {value:5, dice:1}. Keyed by ability for units with more than one. `rangesToAdjacent` is Space-Cannon-specific (RR: PDS II's own upgrade text) — true means this unit's Space Cannon can target ships in adjacent systems too, not just its own. */
  abilityValues?: Partial<Record<UnitAbility, { value: number; dice: number; rangesToAdjacent?: boolean }>>;
}

export interface FactionUnitStats {
  factionId: FactionId;
  /** Base stats per unit type from the faction sheet, before any researched unit upgrade is applied. */
  baseUnits: Record<UnitType, UnitStats | undefined>;
}

export interface UnitUpgradeStats {
  id: UnitUpgradeId;
  unitType: UnitType; // which faction-sheet unit this overrides (RR 86.1/86.4)
  stats: UnitStats;
}

export interface PlanetStaticData {
  resources: number;
  influence: number;
  traits: string[];
  techSpecialties: string[];
  isLegendary: boolean;
  isMecatolRex: boolean;
  /** RR PoK "Wormhole Nexus": true only for Mallice, the Nexus's own planet. Needed to trigger the Nexus's active-flip on control gain (see rules/adjacency.ts's maybeActivateWormholeNexus). */
  isMallice: boolean;
  /** Which faction's home system this planet sits in, if any (data/tiles.json's tile-level homeFaction). */
  homeFactionId: FactionId | null;
}

export interface ObjectiveStaticData {
  points: number;
  /** "manual" = not validated by the engine yet, caller/player is trusted — see data/objectives.json's own note on why (event-history-dependent or too bespoke to be worth a one-off checkType). */
  checkType: string;
  checkParams: Record<string, unknown>;
  /** RR 52.3: when this objective can legally be scored — most secrets are "statusPhase" like public objectives, but several score opportunistically during "actionPhase" or "agendaPhase" instead. */
  timing: "actionPhase" | "statusPhase" | "agendaPhase";
  /** RR 52.1: publicI/publicII/secret — needed at setup to split rules.objectives back out into the right starting decks (see setup/createGame.ts's shuffleAndSeedDecks). */
  kind: ObjectiveKind;
}

export interface RuleData {
  factionUnits: Record<FactionId, FactionUnitStats>;
  unitUpgrades: Record<UnitUpgradeId, UnitUpgradeStats>;
  /** Static resources/influence per planet (data/tiles.json), keyed by the same lowercase-underscore id as PlanetId (e.g. "jord", "mecatol_rex"). */
  planets: Record<PlanetId, PlanetStaticData>;
  /** RR 7: only the law-vs-directive split (data/agendas.json) — NOT the outcome/effect text, same "mechanics only" scope cut as objectives (see data/objectives.json's own note). Needed just to know whether a resolved agenda becomes a permanent law or gets discarded after one use. `removedByPoK`: confirmed, 13 base-game agendas are pulled from the deck entirely whenever Prophecy of Kings content is in play (interactions with newer PoK-era mechanics/factions) — filtered out at setup, see setup/createGame.ts's shuffleAndSeedDecks. `elect`: what KIND of candidate this agenda's own outcome represents (e.g. "Player", "Cultural Planet", undefined for a plain For/Against with no election) — needed generically to know whether a law's `lawsInPlay` entry should record a real player as its owner (elect === "Player") vs "common" (everything else), see phases/agendaPhase.ts's resolveAgendaVote. */
  agendas: Record<AgendaId, { type: "law" | "directive"; removedByPoK?: boolean; elect?: string }>;
  /** RR 52: points + how to validate the condition (data/objectives.json's checkType/checkParams). Most public objectives have a real checkType; most secrets are "manual" for now — see that file's own note. */
  objectives: Record<ObjectiveId, ObjectiveStaticData>;
  /** RR 90: only the color + prerequisites (data/technologies.json) — not the effect text. Prerequisites is a list of colors, one entry per required tech of that color (e.g. ["red","red"] = need 2 red techs already owned). */
  technologies: Record<TechId, { color: string | null; prerequisites: string[] }>;
  /** RR 34/TE breakthrough: commodities max, plus the pair of colors (if any) whose techs can substitute for each other when satisfying prerequisites — never both at once for the same requirement. */
  factions: Record<FactionId, { commoditiesMax: number; breakthroughSynergy: [string, string] | null }>;
  /** RR 90/86: color + prerequisites for unit upgrade techs (data/unitUpgrades.json) — separate from `unitUpgrades` above (which holds COMBAT STATS once owned, and is still an unresolved gap per this project's own notes); this is just enough to validate RR 90.7 prerequisites before letting a player research one. Every unit upgrade (generic or faction-specific) uses this SAME color-count model — confirmed, no TI4 tech/unit-upgrade is ever gated behind owning one specific named tech instead. */
  unitUpgradeTechData: Record<UnitUpgradeId, { color: string | null; prerequisites: string[] }>;
  /** Every tech id that's a FACTION technology (data/factions/*.json's factionTechnologies) for any faction in this game, aggregated — needed for "own N faction techs"-style objectives, since Player.technologies doesn't distinguish faction vs. generic techs. */
  factionTechIds: Set<string>;
  /** RR 35: exploration card mechanics (data/explorationCards.json) — attach bonuses are structured (see that file's own note), but a plain one-time `effect` isn't applied, same deferred-content pattern as action/agenda cards. */
  explorationCards: Record<
    string,
    {
      deck: "cultural" | "industrial" | "hazardous" | "frontier";
      isRelicFragment: boolean;
      fragmentType?: "cultural" | "industrial" | "hazardous" | "any";
      attach: boolean;
      keepInPlayArea: boolean;
      resourceBonus?: number;
      influenceBonus?: number;
      techSpecialtyBonus?: string;
      fallbackResourceBonus?: number;
      fallbackInfluenceBonus?: number;
    }
  >;
  /**
   * RR: the 5 GENERIC promissory notes (Ceasefire, Trade Agreement,
   * Political Secret, Support for the Throne, Alliance) — assigned by
   * PLAYER COLOR, not faction. `effect`/`timing` contain a literal
   * "(color)" placeholder since the actual owning color isn't known until
   * a specific game's setup assigns colors to players (see
   * rules/promissoryNotes.ts's initializePromissoryNotes, which turns
   * these templates + each player's actual color into concrete per-game
   * instances). Keyed by template id (ceasefire, trade_agreement,
   * political_secret, support_for_the_throne, alliance) — "alliance" is
   * PoK-only, filtered out for Base-only games.
   */
  genericPromissoryNoteTemplates: Record<
    string,
    { name: string; timing: string; effect: string; placeInPlayArea: boolean; set: "base" | "pok" }
  >;
  /** RR: each faction's own promissory note(s) (data/factions/*.json's promissoryNote field) — usually 1 per faction, 2 for Empyrean. Unlike generic notes, the faction's name is already baked into the text literally (no placeholder), since it never changes. */
  factionPromissoryNotes: Record<FactionId, { id: string; name: string; timing: string; effect: string; placeInPlayArea: boolean }[]>;
  /** RR "Gather Starting Components" (setup): each faction's starting unit loadout (data/factions/*.json's startingUnits), keyed by the SAME camelCase keys the raw data already uses (e.g. "spaceDock", not "space_dock") — see setup/createGame.ts's own note on why this one field keeps that inconsistency instead of normalizing to UnitType's snake_case. Plain `string` keys/values (not FactionId/TechId brands) — same reason as factionTechIds above: this is a straight aggregation, reading it back out via a FactionId/TechId still works fine since those are subtypes of string. */
  startingUnits: Record<string, Record<string, number>>;
  /** RR "Gather Starting Components": each faction's starting (non-unit-upgrade) technologies (data/factions/*.json's startingTechnologies). */
  startingTechnologies: Record<string, string[]>;
  /** RR "Gather Starting Components": factions that PICK some of their starting technologies (e.g. Argent Flight: "choose two of the following") instead of a single fixed list — data/factions/*.json's own `startingTechnologyChoice` field. Undefined for factions without a choice (their `startingTechnologies` above is the complete, fixed list). The actual pick itself is supplied by whoever's setting up the game (see setup/createGame.ts's CreateGameInput.players[].chosenStartingTechnologies), not resolved as an in-game pending action — same "supplied as setup input" pattern as pre-picking a faction at all. */
  startingTechnologyChoices: Record<string, { count: number; options: string[] } | undefined>;
  /** Every action card id (data/actionCards.json) — just enough to seed/shuffle the deck at setup; playing a card's actual effect is the same deferred-content bucket as agenda/objective effect text. */
  allActionCardIds: string[];
  /** Every relic id (data/relics.json) — just enough to seed/shuffle the relic deck at setup; a relic's own ability isn't resolved anywhere yet (same deferred-content bucket), only PURGE_RELIC_FRAGMENTS drawing one is implemented. */
  allRelicIds: string[];
  /** Which SystemId (tile id) is each faction's home system (data/tiles.json's tile-level homeFaction) — needed at setup, before any board has been generated, to know where to place a player's starting units/planets. Plain string keys/values, same reason as startingUnits/startingTechnologies above. */
  homeSystemByFaction: Record<string, string>;
  /** Which SystemId (tile id) is Mecatol Rex — needed at setup (custodians token placement, map generation's center slot) without hardcoding "18" anywhere as a magic number. */
  mecatolSystemId: string;
  /** RR PoK "Wormhole Nexus" — which SystemId (tile id) is the off-map Nexus tile, null in Base-only games (it doesn't exist there). See setup/createGame.ts for how it gets placed (off-map, not part of the physical hex board) and rules/adjacency.ts's maybeActivateWormholeNexus for the active-flip trigger. */
  wormholeNexusSystemId: string | null;
  /** RR PoK "Leaders": each faction's agent(s)/commander/hero (data/factions/*.json's leaders field). Ids are synthesized (`${factionId}_agent` etc, same reasoning as factionPromissoryNotes) since the raw data doesn't carry one. `agents` is ALWAYS an array — confirmed, only the Nomad has more than 1 (their own "The Company" faction ability grants 2 extra, for 3 total), but every other faction's single agent is just normalized into a 1-element array too, rather than having two different shapes depending on faction. Base-only games don't use leaders at all — see setup/createGame.ts for where this gets skipped. */
  factionLeaders: Record<
    FactionId,
    {
      agents: { id: string; name: string; unlock: string; ability: string }[];
      commander: { id: string; name: string; unlock: string; ability: string };
      hero: { id: string; name: string; unlock: string; ability: string };
    }
  >;
  // TODO as later phases need them: actionCards, agendas/objectives effect
  // text, strategyCard primary/secondary text, faction abilityIds -> effect
  // implementations, leader ability effect text (leader ids/unlock text ARE
  // wired in above already, just not their abilities' actual execution).
  // (technologies, explorationCards, relics, generic + faction
  // promissoryNotes, and startingUnits/startingTechnologies are all wired
  // in above already.)
}

/**
 * Resolves the *current* stats for one of a player's units, accounting for
 * any owned unit upgrade (RR 86.4: the upgrade card's stats fully replace
 * the faction sheet's for that unit type once owned).
 */
export function getUnitStats(
  rules: RuleData,
  factionId: FactionId,
  unitType: UnitType,
  ownedUpgradeIds: UnitUpgradeId[],
): UnitStats | undefined {
  const upgrade = ownedUpgradeIds
    .map((id) => rules.unitUpgrades[id])
    .find((u) => u?.unitType === unitType);
  if (upgrade) return upgrade.stats;
  return rules.factionUnits[factionId]?.baseUnits[unitType];
}
