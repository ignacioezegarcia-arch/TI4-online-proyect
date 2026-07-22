import { GameState, Player, SystemState, PlanetState } from "../types/GameState";
import { PlayerId, FactionId, SystemId, PlanetId, TechId, asSystemId, asPlanetId, asAgendaId, asObjectiveId, asActionCardId, asExplorationCardId, asRelicId, asTechId, asStrategyCardId, asLeaderId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { GameMode, UnitType, AnomalyType, WormholeType } from "../types/enums";
import { generateMap, fisherYatesShuffle, PlaceableTile } from "./mapGeneration";
import { initializePromissoryNotes } from "./promissoryNotes";
import { planetNameToId } from "../rules/ruleDataMapping";
import { hasPoKContent } from "../rules/gameMode";

/**
 * RR "First-Game Setup" steps 1-12 (the COMPLETE/standard version — the
 * Learn To Play booklet's "deal 5+5 objectives into a row" is the abridged
 * TUTORIAL setup only; the standard game just shuffles the full 20+20
 * public objective decks and reveals them one at a time via the status
 * phase's own bookkeeping, which is what this reuses/matches instead).
 *
 * NOT done here, on purpose:
 *  - Step 9 (CREATE SUPPLY — trade good/infantry/fighter token piles): this
 *    engine doesn't track physical component scarcity anywhere (same
 *    "no reinforcement-supply limit" gap already flagged in
 *    phases/production.ts) — reinforcements are implicitly infinite.
 *  - The 5-player extra-trade-goods balancing rule (closest-to-two-
 *    neighbors gets +4, their two neighbors get +2 each): a real rule,
 *    just not wired in yet — flagged rather than silently skipped.
 *  - Hyperlane tile internal wiring (see rules/combat.ts-adjacent notes
 *    elsewhere in this project) — buildBoardAdjacency's own existing
 *    simplification, unchanged by this file.
 */

/** A raw tiles.json tile entry, full shape (this file needs planets/anomalies/wormholes, not just the slimmed-down static data RuleData.planets exposes). */
export interface RawTileEntry {
  id: number;
  name: string;
  homeFaction?: string;
  isHyperlane?: boolean;
  isBlank?: boolean;
  /** True only for the Wormhole Nexus (RR PoK) — never part of the physical hex board, placed as a separate off-map system instead. See wormholesInactive/wormholesActive below. */
  isOffMap?: boolean;
  wormholesInactive?: string[];
  wormholesActive?: string[];
  planets?: { name: string; resources: number; influence: number; traits?: string[]; tech?: string[]; isLegendary?: boolean; isMecatolRex?: boolean; isMallice?: boolean }[];
  anomalies?: string[];
  wormholes?: string[];
}

export interface CreateGameInput {
  gameId: string;
  mode: GameMode;
  victoryPointTarget: 10 | 14;
  players: {
    id: PlayerId;
    color: string;
    /** Omit to have this player dealt a random faction from whatever's left in availableFactionPool after every explicit pick is removed. */
    factionId?: FactionId;
    /** RR "Gather Starting Components": for a faction with a `startingTechnologyChoice` (e.g. Argent Flight: "choose two of the following") — the actual pick, supplied here rather than resolved as an in-game action (this is a one-time setup choice, made before the game state even exists yet). Validated against that faction's own `count`/`options`; ignored (and harmless) for factions with no such choice. */
    chosenStartingTechnologies?: string[];
  }[];
  /** Every faction id available to deal from for this game (e.g. all 17 base ids if mode is "base") — only consulted for players who didn't pre-pick. */
  availableFactionPool: FactionId[];
  rules: RuleData;
  /** Every tile from data/tiles.json for whatever expansions this game's mode includes — this function sorts out which are home systems, Mecatol, and the available non-home pool on its own. */
  allTiles: RawTileEntry[];
  boardLayouts: Parameters<typeof generateMap>[0]["boardLayouts"];
  mapVariant?: string;
  rng?: () => number;
}

export function createGame(input: CreateGameInput): GameState {
  const rng = input.rng ?? Math.random;
  const { rules } = input;

  const colors = input.players.map((p) => p.color);
  if (new Set(colors).size !== colors.length) {
    throw new Error("RR 'Choose Color': every player needs a distinct color.");
  }

  // 1. DETERMINE SPEAKER — random, and this also fixes seat order (RR 73.1's
  // strategy-phase turn order starts with the speaker).
  const seatOrder = fisherYatesShuffle(
    input.players.map((p) => p.id),
    rng,
  );
  const speakerId = seatOrder[0];

  // 2. ASSIGN FACTIONS
  const preChosen = new Set(input.players.filter((p) => p.factionId).map((p) => p.factionId as FactionId));
  const remainingPool = fisherYatesShuffle(
    input.availableFactionPool.filter((f) => !preChosen.has(f)),
    rng,
  );
  const factionByPlayer: Record<PlayerId, FactionId> = {};
  for (const p of input.players) {
    if (p.factionId) {
      factionByPlayer[p.id] = p.factionId;
    } else {
      const next = remainingPool.shift();
      if (!next) throw new Error("RR 'Assign Factions': not enough factions left in the pool for every player.");
      factionByPlayer[p.id] = next;
    }
  }

  // Sort tiles into home / Mecatol / available-for-the-board.
  const mecatolTile = input.allTiles.find((t) => t.planets?.some((p) => p.isMecatolRex));
  if (!mecatolTile) throw new Error("No Mecatol Rex tile found in allTiles.");
  const homeTileByFaction = new Map<string, RawTileEntry>();
  for (const t of input.allTiles) {
    if (t.homeFaction) homeTileByFaction.set(t.homeFaction, t);
  }
  const nonHomeTiles: PlaceableTile[] = input.allTiles
    .filter((t) => !t.homeFaction && !t.isHyperlane && !t.isBlank && !t.isOffMap && t !== mecatolTile)
    .map(rawTileToPlaceableTile);

  // 6. CREATE GAME BOARD
  const homeSystemsBySeat = seatOrder.map((id) => asSystemId(String(homeTileByFaction.get(factionByPlayer[id])!.id)));
  const generated = generateMap({
    playerCount: input.players.length,
    boardLayouts: input.boardLayouts,
    availableTiles: nonHomeTiles,
    homeSystemsBySeat,
    mecatolSystemId: asSystemId(String(mecatolTile.id)),
    variant: input.mapVariant,
    rng,
  });

  // Build every system's live SystemState — home systems, Mecatol, and
  // whatever generateMap actually placed (generated.slotToSystemId covers
  // all three, keyed by slot rather than by kind, so one loop handles them).
  const allPlacedTiles = new Map<string, RawTileEntry>();
  for (const t of input.allTiles) allPlacedTiles.set(String(t.id), t);
  const systems: Record<SystemId, SystemState> = {};
  for (const systemId of new Set(Object.values(generated.slotToSystemId))) {
    const raw = allPlacedTiles.get(systemId as string);
    if (!raw) continue; // hyperlane tiles: not a real system, deliberately excluded (see this project's own hyperlane notes)
    systems[systemId] = rawTileToSystemState(raw, systemId, input.mode);
  }

  // RR PoK "Wormhole Nexus": off-map, never part of the physical hex board
  // (excluded from nonHomeTiles above via isOffMap) — placed separately
  // here instead, starting inactive (gamma-only wormhole). See
  // rules/adjacency.ts's maybeActivateWormholeNexus for how it flips
  // active later. Base-only games never have this tile at all.
  if (hasPoKContent(input.mode) && rules.wormholeNexusSystemId) {
    const nexusRaw = allPlacedTiles.get(rules.wormholeNexusSystemId);
    if (nexusRaw) {
      const nexusSystemId = asSystemId(rules.wormholeNexusSystemId);
      systems[nexusSystemId] = {
        ...rawTileToSystemState(nexusRaw, nexusSystemId, input.mode),
        wormholes: (nexusRaw.wormholesInactive ?? ["gamma"]) as WormholeType[],
        frontierToken: false,
      };
    }
  }

  // 4/5/11. Players: color/faction already decided above; this builds the
  // rest (command tokens, starting units/tech placed on the home system,
  // home planets dealt READIED — RR 25.1's "gained control = exhausted"
  // does NOT apply to home planets at setup, only to control gained during
  // play) and promissory notes (RR: by player color, not faction).
  const promissoryNoteSetup = initializePromissoryNotes(
    input.players.map((p) => ({ id: p.id, color: p.color, factionId: factionByPlayer[p.id] })),
    rules,
    input.mode,
  );

  const players: Record<PlayerId, Player> = {};
  for (const p of input.players) {
    const factionId = factionByPlayer[p.id];
    const homeSystemId = asSystemId(String(homeTileByFaction.get(factionId)!.id));
    const homeSystem = systems[homeSystemId];

    // Home planets: controlled + READIED (not exhausted — setup-only
    // exception to RR 25.1) + explored (home planets are never explored,
    // they have no trait card to draw — RR only explores newly-controlled
    // NON-home planets).
    homeSystem.planets = homeSystem.planets.map((planet) => ({
      ...planet,
      controllerId: p.id,
      exhausted: false,
      explored: true,
    }));

    const commoditiesMax = rules.factions[factionId]?.commoditiesMax ?? 0;

    players[p.id] = {
      id: p.id,
      factionId,
      color: p.color,
      isSpeaker: p.id === speakerId,
      hasPassed: false,
      eliminated: false,
      commandTokens: { tactic: 3, fleet: 3, strategy: 2, onBoard: [] },
      victoryPoints: { current: 0, scoredObjectiveIds: [] },
      strategyCards: [],
      resourcesAvailable: 0, // derived cache — recompute from planets before first use, per its own doc comment on Player
      influenceAvailable: 0,
      commodities: 0, // RR: commodities only fill up via the Trade strategy card's "replenish", never start pre-filled
      tradeGoods: 0,
      technologies: resolveStartingTechnologies(rules, factionId, p.chosenStartingTechnologies),
      exhaustedTechnologies: [],
      unitUpgrades: [],
      actionCards: [],
      promissoryNotesInHand: [...(promissoryNoteSetup.startingHands[p.id] ?? [])],
      promissoryNotesInPlayArea: [],
      secretObjectives: [],
      leaders: buildInitialLeaders(rules, factionId),
      relics: [],
      relicFragments: { cultural: 0, industrial: 0, hazardous: 0, unknown: 0 },
      explorationCardsInPlayArea: [],
      actionCardsDiscardedCount: 0,
      abilityIds: [],
      capturedUnits: [],
      capturedGenericUnits: { infantry: 0, fighter: 0 },
    };

    placeStartingUnits(homeSystem, p.id, factionId, rules);
  }

  // 8. SHUFFLE COMMON DECKS + 12. PREPARE OBJECTIVES (secret dealt here too
  // — same "shuffle then draw" pass, since secret objectives are one of
  // the shuffled decks).
  const decks = shuffleAndSeedDecks(rules, input.mode, rng);
  for (const id of seatOrder) {
    const [dealt, ...rest] = decks.secretObjectiveDeck;
    players[id].secretObjectives = dealt ? [dealt] : [];
    decks.secretObjectiveDeck = rest;
  }
  // RR "Prepare Objectives" iv: reveal the first 2 stage I public objectives immediately.
  const objectives: GameState["objectives"] = [];
  for (let i = 0; i < 2 && decks.publicObjectiveDeck.stageI.length > 0; i++) {
    const [next, ...rest] = decks.publicObjectiveDeck.stageI;
    objectives.push({ kind: "publicI", objectiveId: next, revealed: true });
    decks.publicObjectiveDeck.stageI = rest;
  }

  // 10. GATHER STRATEGY CARDS
  const unclaimedStrategyCards = (["leadership", "diplomacy", "politics", "construction", "trade", "warfare", "technology", "imperial"] as const).map(
    (cardId) => ({ cardId: asStrategyCardId(cardId), tradeGoods: 0 }),
  );

  return {
    gameId: input.gameId,
    mode: input.mode,
    victoryPointTarget: input.victoryPointTarget,
    phase: "strategy",
    round: 1,
    players,
    seatOrder,
    initiativeOrder: [],
    activePlayerId: null,
    systems,
    boardAdjacency: generated.boardAdjacency,
    mecatolCustodiansRemoved: false, // 7. PLACE CUSTODIANS TOKEN
    unclaimedStrategyCards,
    objectives,
    agendaDeck: { deckIds: decks.agendaDeck, discardIds: [], lawsInPlay: [] },
    publicObjectiveDeck: decks.publicObjectiveDeck,
    actionCardDeck: decks.actionCardDeck,
    secretObjectiveDeck: decks.secretObjectiveDeck,
    explorationDecks: decks.explorationDecks,
    relicDeck: decks.relicDeck,
    promissoryNoteInstances: promissoryNoteSetup.instances,
    pendingTacticalAction: null,
    pendingAgendaVote: null,
    winnerId: null,
  };
}

// --- helpers ---------------------------------------------------------------

/**
 * RR "Leaders": every faction's agent(s) start READIED and UNLOCKED (usable
 * from the start of the game); commander and hero both start LOCKED (each
 * has its own unlock condition — commander conditions are faction-specific
 * and checked elsewhere as each faction's own logic is wired in; hero
 * conditions are universally "3 scored objectives", checked generically in
 * phases/actionPhase.ts's scoreObjectiveCore). Iterates ALL of
 * rules.factionLeaders[factionId].agents — confirmed, this is 1 entry for
 * nearly every faction, 3 for the Nomad (their own "The Company" faction
 * ability), and buildFactionLeadersLookup already normalized both cases
 * into the same array shape, so this loop needs no faction-specific branch.
 */
function buildInitialLeaders(rules: RuleData, factionId: FactionId): Player["leaders"] {
  const leaders = rules.factionLeaders[factionId];
  if (!leaders) return [];
  return [
    ...leaders.agents.map((agent) => ({ leaderId: asLeaderId(agent.id), locked: false, exhausted: false })),
    { leaderId: asLeaderId(leaders.commander.id), locked: true, exhausted: false },
    { leaderId: asLeaderId(leaders.hero.id), locked: true, exhausted: false },
  ];
}

/** RR "Gather Starting Components": combines a faction's FIXED starting technologies with whatever this player CHOSE, for factions with a `startingTechnologyChoice` (e.g. Argent Flight: "choose two of the following"). Throws (same "bad setup input" pattern as this file's other RR-named errors) if a faction has a choice and the supplied pick doesn't satisfy it exactly — wrong count, an option not on the list, or a duplicate. */
function resolveStartingTechnologies(rules: RuleData, factionId: FactionId, chosen: string[] | undefined): TechId[] {
  const fixed = rules.startingTechnologies[factionId] ?? [];
  const choiceSpec = rules.startingTechnologyChoices[factionId];

  if (!choiceSpec) {
    return fixed.map(asTechId);
  }

  const picked = chosen ?? [];
  if (picked.length !== choiceSpec.count) {
    throw new Error(
      `RR "Gather Starting Components": ${factionId} must choose exactly ${choiceSpec.count} starting technolog${choiceSpec.count === 1 ? "y" : "ies"} from [${choiceSpec.options.join(", ")}], got ${picked.length}.`,
    );
  }
  if (new Set(picked).size !== picked.length) {
    throw new Error(`RR "Gather Starting Components": ${factionId}'s starting technology choice can't repeat the same tech twice.`);
  }
  for (const techId of picked) {
    if (!choiceSpec.options.includes(techId)) {
      throw new Error(`RR "Gather Starting Components": "${techId}" isn't one of ${factionId}'s starting technology choice options.`);
    }
  }

  return [...fixed, ...picked].map(asTechId);
}

function rawTileToPlaceableTile(t: RawTileEntry): PlaceableTile {
  return {
    systemId: asSystemId(String(t.id)),
    anomalies: t.anomalies ?? [],
    wormholes: t.wormholes ?? [],
  };
}

function rawTileToSystemState(t: RawTileEntry, systemId: SystemId, mode: GameMode): SystemState {
  return {
    systemId,
    planets: (t.planets ?? []).map(
      (p): PlanetState => ({
        planetId: asPlanetId(planetNameToId(p.name)),
        controllerId: null,
        exhausted: false,
        attachmentIds: [],
        explored: false,
        unitsByPlayer: {},
      }),
    ),
    spaceUnitsByPlayer: {},
    wormholes: (t.wormholes ?? []) as WormholeType[],
    anomalies: (t.anomalies ?? []) as AnomalyType[],
    // RR PoK "Place Custodians Token" step: a frontier token goes on every
    // non-home system with no planets (even an anomaly-only system).
    // Base-only games don't have Frontier tokens at all — RR 35's whole
    // Exploration mechanic is PoK-only (see phases/exploration.ts's own
    // mode guard).
    frontierToken: hasPoKContent(mode) && (t.planets ?? []).length === 0,
  };
}

/** RR "Gather Starting Components": places a faction's startingUnits onto their home system — ships go to space, ground forces + structures go on the planet with the highest resource value (RR's own recommendation when a home system has multiple planets). */
function placeStartingUnits(homeSystem: SystemState, playerId: PlayerId, factionId: FactionId, rules: RuleData): void {
  const raw = rules.startingUnits[factionId] ?? {};
  // Raw data keys are camelCase (e.g. "spaceDock") but UnitType is snake_case
  // for multi-word types — see RuleData.ts's own note on why this one field
  // keeps that inconsistency rather than normalizing the source data.
  const keyToUnitType: Record<string, UnitType> = {
    carrier: "carrier",
    cruiser: "cruiser",
    destroyer: "destroyer",
    dreadnought: "dreadnought",
    fighter: "fighter",
    infantry: "infantry",
    mech: "mech",
    pds: "pds",
    spaceDock: "space_dock",
    warSun: "war_sun",
    flagship: "flagship",
  };

  const groundOrStructureTarget =
    homeSystem.planets.length > 1
      ? homeSystem.planets.reduce((best, p) => (rulesResourceOf(p, rules) > rulesResourceOf(best, rules) ? p : best))
      : homeSystem.planets[0];

  const spaceStacks: SystemState["spaceUnitsByPlayer"][PlayerId] = [];
  for (const [rawKey, count] of Object.entries(raw)) {
    const unitType = keyToUnitType[rawKey];
    if (!unitType || count <= 0) continue;
    if (unitType === "infantry" || unitType === "mech" || unitType === "space_dock" || unitType === "pds") {
      if (!groundOrStructureTarget) continue;
      const stacks = groundOrStructureTarget.unitsByPlayer[playerId] ?? [];
      groundOrStructureTarget.unitsByPlayer[playerId] = [...stacks, { unitType, count, damagedCount: 0 }];
    } else {
      spaceStacks.push({ unitType, count, damagedCount: 0 });
    }
  }
  homeSystem.spaceUnitsByPlayer[playerId] = spaceStacks;
}

function rulesResourceOf(planet: PlanetState, rules: RuleData): number {
  return rules.planets[planet.planetId]?.resources ?? 0;
}

/** RR "Shuffle Common Decks" — all 6 shuffled decks this engine tracks (action, agenda, public objectives x2 stages, secret objectives, exploration x4 + relics if PoK). Mode-filtered where a deck has PoK/TE-only content mixed in with base content already (agendas, objectives don't currently distinguish set in RuleData, so they're not filtered here — see this project's own note on why: RuleData.agendas/objectives don't carry a `set` field yet). */
function shuffleAndSeedDecks(
  rules: RuleData,
  mode: GameMode,
  rng: () => number,
): {
  actionCardDeck: GameState["actionCardDeck"];
  agendaDeck: GameState["agendaDeck"]["deckIds"];
  publicObjectiveDeck: NonNullable<GameState["publicObjectiveDeck"]>;
  secretObjectiveDeck: NonNullable<GameState["secretObjectiveDeck"]>;
  explorationDecks: NonNullable<GameState["explorationDecks"]>;
  relicDeck: NonNullable<GameState["relicDeck"]>;
} {
  const stageI: string[] = [];
  const stageII: string[] = [];
  const secretIds: string[] = [];
  for (const [id, o] of Object.entries(rules.objectives)) {
    if (o.kind === "publicI") stageI.push(id);
    else if (o.kind === "publicII") stageII.push(id);
    else secretIds.push(id);
  }

  const explorationDecks: NonNullable<GameState["explorationDecks"]> = { cultural: [], industrial: [], hazardous: [], frontier: [] };
  if (hasPoKContent(mode)) {
    for (const deck of ["cultural", "industrial", "hazardous", "frontier"] as const) {
      const idsForDeck = Object.entries(rules.explorationCards)
        .filter(([, c]) => c.deck === deck)
        .map(([id]) => asExplorationCardId(id));
      explorationDecks[deck] = fisherYatesShuffle(idsForDeck, rng);
    }
  }

  return {
    actionCardDeck: fisherYatesShuffle(rules.allActionCardIds.map(asActionCardId), rng),
    agendaDeck: fisherYatesShuffle(Object.keys(rules.agendas).map(asAgendaId), rng),
    publicObjectiveDeck: {
      stageI: fisherYatesShuffle(stageI.map(asObjectiveId), rng),
      stageII: fisherYatesShuffle(stageII.map(asObjectiveId), rng),
    },
    secretObjectiveDeck: fisherYatesShuffle(secretIds.map(asObjectiveId), rng),
    explorationDecks,
    relicDeck: hasPoKContent(mode) ? fisherYatesShuffle(rules.allRelicIds.map(asRelicId), rng) : [],
  };
}
