import { GameState, Player, SystemState, PlanetState } from "../types/GameState";
import { PlayerId, FactionId, SystemId, PlanetId, TechId, asSystemId, asPlanetId, asAgendaId, asObjectiveId, asActionCardId, asExplorationCardId, asRelicId, asTechId, asStrategyCardId, asLeaderId, asFactionId, asAbilityId, NEUTRAL_PLAYER_ID } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { GameMode, UnitType, AnomalyType, WormholeType } from "../types/enums";
import { generateMap, fisherYatesShuffle, PlaceableTile } from "./mapGeneration";
import { initializePromissoryNotes } from "./promissoryNotes";
import { planetNameToId } from "../rules/ruleDataMapping";
import { hasPoKContent, hasThundersEdge } from "../rules/gameMode";

/**
 * RR "First-Game Setup" steps 1-12 (the COMPLETE/standard version — the
 * Learn To Play booklet's "deal 5+5 objectives into a row" is the abridged
 * TUTORIAL setup only; the standard game just shuffles the full 20+20
 * public objective decks and reveals them one at a time via the status
 * phase's own bookkeeping, which is what this reuses/matches instead).
 *
 * NOT done here, on purpose:
 *  - Step 9 (CREATE SUPPLY — trade good/infantry/fighter token piles):
 *    infantry/fighter genuinely have no cap (RR/the wiki: "effectively
 *    unlimited" via token substitution — see rules/reinforcements.ts's own
 *    doc comments). Every OTHER unit type now IS capped (production.ts and
 *    the various free-unit-granting abilities across this project check
 *    rules/reinforcements.ts), but there's nothing to initialize here for
 *    that — the cap is derived from what's already on the board/captured,
 *    not a separately-stored starting pool, so starting placements below
 *    just need to (and always do, by construction — no faction's starting
 *    loadout gets remotely close) fit under those same fixed limits.
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
  /** True for the Wormhole Nexus (RR PoK) and for the Ghosts of Creuss's own real home system (tile 51, "Creuss") — neither is ever part of the physical hex board; both are placed as a separate off-map system instead. See wormholesInactive/wormholesActive below (Nexus) and gateSystemId below (Creuss). */
  isOffMap?: boolean;
  /** RR Ghosts of Creuss faction ability "CREUSS GATE": only set on an isOffMap home tile (currently just tile 51). The tile id that stands in for THIS tile at the physical board's home-system slot — for Creuss, tile 17 ("Creuss Gate": no planets, a lone delta wormhole). The real off-map tile (this one) still gets its own SystemState (see setup/createGame.ts's off-map-home-systems block), just never a board slot of its own; the two end up adjacent "for free" via the generic matching-wormhole-type rule in rules/adjacency.ts, since both share a delta wormhole in data/tiles.json. Generalized rather than Creuss-hardcoded, in case a future faction/expansion reuses the same off-map-home-behind-a-gate shape. */
  gateSystemId?: number;
  wormholesInactive?: string[];
  wormholesActive?: string[];
  planets?: RawTilePlanetEntry[];
  anomalies?: string[];
  wormholes?: string[];
  /** TE: which expansion introduced this tile — "thundersEdge" tiles need hasThundersEdge(mode) to be included; undefined/other values are always available. Not yet consumed by the tile-pool-selection logic (a broader map-setup concern beyond this one file's own tile->system conversion) — tracked here so that logic has something to read once it exists. */
  set?: string;
  /** TE The Fracture (rulebook p.9): true for the 3 off-map Fracture system tiles — carried straight through to SystemState.isFracture by rawTileToSystemState below. */
  isFracture?: boolean;
  /** TE multi-hex tiles (currently only the 3 Fracture tiles): planets/anomalies/wormholes/egress live per-hex here instead of at the top level — rawTileToSystemState flattens all of a tile's own hexes into that ONE system (this engine has no separate per-hex sub-state), when this is present. */
  hexes?: { index: number; planets?: RawTilePlanetEntry[]; anomalies?: string[]; wormholes?: string[]; egress?: boolean }[];
  /** TE The Fracture: neutral (non-player) units guarding this tile's own planet(s) — tied to the broader "Neutral Units" mechanic (not yet built); tracked here so the data itself isn't lost even though nothing consumes it yet. */
  neutralGuardians?: Partial<Record<string, number>>;
}

export interface RawTilePlanetEntry {
  name: string;
  resources: number;
  influence: number;
  traits?: string[];
  tech?: string[];
  isLegendary?: boolean;
  isMecatolRex?: boolean;
  isMallice?: boolean;
  /** RR 73/75: "when a player gains a planet card... that has a relic icon... they draw the top card of the relic deck." Every Fracture planet (Cocytus, Lethe, Plegethon, Styx) has this — a general RR mechanic, not Fracture-specific, just newly relevant since TE introduces the first planets that actually have it. */
  hasRelicIcon?: boolean;
  legendaryAbility?: { name: string; effect: string };
  /** TE Space Stations (rulebook p.10): true for e.g. Last Bastion's own Revelation — not yet consumed by any engine logic (Space Stations mechanic itself isn't built), tracked here so it's not lost from the raw data. */
  isSpaceStation?: boolean;
  /** TE Fracture planets' own "when you gain control of this planet, gain 1 relic" wording, and similar one-off planet text not otherwise modeled — free-form, not yet consumed anywhere. */
  specialRules?: string[];
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
  // TE: Thunder's Edge replaces the base Mecatol Rex tile with its own
  // updated one (tile 112 in this project's own data) — "The Galactic
  // Council" legendary ability, "isLegendary: true" — which the base
  // tile (18) never had. Previously this always picked whichever one
  // .find() happened to hit first (tile 18, since it has the lower id
  // and appears earlier in the array), regardless of game mode, silently
  // discarding the TE version's legendary status/ability entirely.
  const mecatolCandidates = input.allTiles.filter((t) => t.planets?.some((p) => p.isMecatolRex));
  const mecatolTile = (hasThundersEdge(input.mode) ? mecatolCandidates.find((t) => t.set === "ThundersEdge") : mecatolCandidates.find((t) => t.set !== "ThundersEdge")) ?? mecatolCandidates[0];
  if (!mecatolTile) throw new Error("No Mecatol Rex tile found in allTiles.");
  const homeTileByFaction = new Map<string, RawTileEntry>();
  for (const t of input.allTiles) {
    if (t.homeFaction) homeTileByFaction.set(t.homeFaction, t);
  }
  // RR Ghosts of Creuss "CREUSS GATE": tile 17 is Creuss's own exclusive
  // faction component (data/factions/creuss.json's factionSpecificComponents),
  // never a normal board-filler tile — reserved here (like every home tile
  // already is, via !t.homeFaction below) regardless of whether Creuss is
  // actually in this particular game, same as how a non-playing faction's
  // OWN home tile is still excluded from the generic pool. Derived from
  // every home tile's own gateSystemId rather than hardcoding "17", so this
  // stays correct if a future off-map-home faction adds a second one.
  const gateTileIds = new Set([...homeTileByFaction.values()].filter((t) => t.isOffMap && t.gateSystemId != null).map((t) => String(t.gateSystemId)));
  const nonHomeTiles: PlaceableTile[] = input.allTiles
    .filter((t) => !t.homeFaction && !t.isHyperlane && !t.isBlank && !t.isOffMap && !gateTileIds.has(String(t.id)) && t !== mecatolTile)
    .map(rawTileToPlaceableTile);

  // 6. CREATE GAME BOARD
  // Board-slot tile per seat: normally the faction's own home tile — UNLESS
  // that tile isOffMap (RR Ghosts of Creuss), in which case its gateSystemId
  // tile (17, "Creuss Gate": no planets, a lone delta wormhole) takes the
  // physical slot instead. The real off-map home tile (51, "Creuss" — the
  // actual home planet) is never placed on the board at all; it gets added
  // to `systems` separately below, off-map, once the player's faction is
  // known to actually be in this game. This was a known gap (previously
  // tile 51 itself was placed at the home slot, which is wrong per RR: "the
  // Creuss Gate system is not a home system").
  const homeSystemsBySeat = seatOrder.map((id) => {
    const homeTile = homeTileByFaction.get(factionByPlayer[id])!;
    const boardTileId = homeTile.isOffMap && homeTile.gateSystemId != null ? homeTile.gateSystemId : homeTile.id;
    return asSystemId(String(boardTileId));
  });
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

  // TE The Fracture: off-map (isOffMap on all 3 tiles already excludes
  // them from nonHomeTiles/boardAdjacency above, same as the Wormhole
  // Nexus) — present in state.systems from the very start of a Thunder's
  // Edge game, but with no adjacency to anything until fractureInPlay
  // flips true and ingress tokens actually get placed (rules/adjacency.ts
  // only links ingress<->egress dynamically at query time, so there's
  // nothing more to do here for that part). Neutral guardian units get
  // placed later too, by rules/breakthroughs.ts's own grantBreakthrough
  // path — not at setup, since the Fracture may never come into play at
  // all in a given game.
  if (hasThundersEdge(input.mode)) {
    for (const fractureTileId of ["125", "126", "127"]) {
      const raw = allPlacedTiles.get(fractureTileId);
      if (raw) {
        const fractureSystemId = asSystemId(fractureTileId);
        systems[fractureSystemId] = rawTileToSystemState(raw, fractureSystemId, input.mode);
      }
    }
  }

  // RR Ghosts of Creuss "CREUSS GATE": each isOffMap home tile (currently
  // just tile 51, "Creuss") never gets a slotToSystemId entry above (its
  // own gateSystemId tile took its board slot instead, back in
  // homeSystemsBySeat) — added here as its own SystemState instead, exactly
  // once per game and ONLY when that faction is actually being played
  // (unlike the always-present homeTileByFaction map itself, which lists
  // every faction's home tile regardless of whether they're in this game).
  // No special adjacency wiring needed: this tile and its gate both carry a
  // delta wormhole in data/tiles.json, so rules/adjacency.ts's generic
  // matching-wormhole-type rule already links them — the RR "always
  // adjacent to the Creuss Gate" behavior, for free.
  const factionsInPlay = new Set(Object.values(factionByPlayer));
  for (const [factionId, homeTile] of homeTileByFaction.entries()) {
    if (homeTile.isOffMap && factionsInPlay.has(factionId as FactionId)) {
      const offMapHomeSystemId = asSystemId(String(homeTile.id));
      systems[offMapHomeSystemId] = rawTileToSystemState(homeTile, offMapHomeSystemId, input.mode);
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
      // FIX: this used to be hardcoded empty for every player of every faction — hasAbility(player, id) (rules/abilities.ts) checks THIS list, so every faction-ability gate anywhere in this project (Coexist's own "can_choose_coexist" included) silently always returned false until this fix. Populated from the faction's own static factionAbilityIds (RuleData.factions[...]), not something that changes over the course of play (breakthrough-granted synergy abilities are tracked via Player.hasBreakthrough + RuleData.factions[...].breakthroughSynergy instead, a separate mechanism already built).
      abilityIds: (rules.factions[factionId]?.factionAbilityIds ?? []).map(asAbilityId),
      capturedUnits: [],
      capturedGenericUnits: { infantry: 0, fighter: 0 },
    };

    placeStartingUnits(homeSystem, p.id, factionId, rules);
  }

  // TE NEUTRAL UNITS: a minimal, non-real "player" entry so combat and
  // reinforcement code that reads state.players[playerId] keeps working
  // unmodified for Fracture guardians — deliberately no real faction
  // (asFactionId("neutral") never matches any of rules.factions, so
  // faction-ability/tech lookups just fall through to base stats, which
  // is exactly right — neutral units never have faction techs or unit
  // upgrades), no leaders, no command tokens, no victory points. Never
  // added to seatOrder, never gets a turn, never eliminated. See
  // GameState.ts's own Player.isNeutral doc comment.
  if (hasThundersEdge(input.mode)) {
    players[NEUTRAL_PLAYER_ID] = {
      id: NEUTRAL_PLAYER_ID,
      factionId: asFactionId("neutral"),
      color: "neutral",
      isSpeaker: false,
      hasPassed: true,
      eliminated: false,
      isNeutral: true,
      commandTokens: { tactic: 0, fleet: 0, strategy: 0, onBoard: [] },
      victoryPoints: { current: 0, scoredObjectiveIds: [] },
      strategyCards: [],
      resourcesAvailable: 0,
      influenceAvailable: 0,
      commodities: 0,
      tradeGoods: 0,
      technologies: [],
      exhaustedTechnologies: [],
      unitUpgrades: [],
      actionCards: [],
      promissoryNotesInHand: [],
      promissoryNotesInPlayArea: [],
      secretObjectives: [],
      leaders: [],
      relics: [],
      relicFragments: { cultural: 0, industrial: 0, hazardous: 0, unknown: 0 },
      explorationCardsInPlayArea: [],
      actionCardsDiscardedCount: 0,
      abilityIds: [],
      capturedUnits: [],
      capturedGenericUnits: { infantry: 0, fighter: 0 },
    };
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
    startingPlayerCount: Object.keys(players).length,
    phase: "strategy",
    round: 1,
    players,
    seatOrder,
    initiativeOrder: [],
    activePlayerId: null,
    systems,
    // TE The Fracture: its own 3 systems are physically laid out touching
    // each other in a row — confirmed order (left to right) is Fracture A
    // (125) - Fracture C (127, Styx) - Fracture B (126); the middle one
    // (Styx) has no egress token of its own precisely BECAUSE it reaches
    // the outside board via this same normal physical adjacency to A and
    // B (both of which do have their own egress), not via any ingress/
    // egress link of its own. This mutual-adjacency chain isn't part of
    // the normal hex-position-based generation at all (the Fracture is
    // off-map), so it's patched in here directly rather than through
    // generated.boardAdjacency.
    boardAdjacency: hasThundersEdge(input.mode)
      ? {
          ...generated.boardAdjacency,
          [asSystemId("125")]: [...(generated.boardAdjacency[asSystemId("125")] ?? []), asSystemId("127")],
          [asSystemId("127")]: [asSystemId("125"), asSystemId("126")],
          [asSystemId("126")]: [...(generated.boardAdjacency[asSystemId("126")] ?? []), asSystemId("127")],
        }
      : generated.boardAdjacency,
    mecatolCustodiansRemoved: false, // 7. PLACE CUSTODIANS TOKEN
    unclaimedStrategyCards,
    thunderEdgeExpedition: { slicesClaimedBy: {}, completed: false },
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
    pendingPriorityWindow: null,
    winnerId: null,
    // 3 GENERIC gamma wormhole tokens (Cultural "Gamma Wormhole", Frontier
    // "Gamma Relay", "Nexus Sovereignty" agenda) — all start in the box.
    // Previously missing here entirely (a required GameState field with no
    // initializer), which would have thrown at runtime the first time any
    // of those 3 sources tried to place one — see rules/wormholeTokens.ts's
    // own placeGenericGammaWormholeToken, which reads this array directly.
    genericGammaWormholeTokens: [
      { tokenId: "generic_gamma_1", systemId: null },
      { tokenId: "generic_gamma_2", systemId: null },
      { tokenId: "generic_gamma_3", systemId: null },
    ],
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
    anomalies: t.hexes ? t.hexes.flatMap((h) => h.anomalies ?? []) : (t.anomalies ?? []),
    wormholes: t.hexes ? t.hexes.flatMap((h) => h.wormholes ?? []) : (t.wormholes ?? []),
  };
}

function rawTileToSystemState(t: RawTileEntry, systemId: SystemId, mode: GameMode): SystemState {
  // TE multi-hex tiles (currently only the 3 Fracture ones): planets/
  // anomalies/wormholes/egress live per-hex under t.hexes instead of at
  // the top level — flattened into this ONE system, since this engine
  // has no separate per-hex sub-state (a system is always exactly 1
  // SystemId, regardless of how many physical hexes its tile spans).
  const flatPlanets: RawTilePlanetEntry[] = t.hexes ? t.hexes.flatMap((h) => h.planets ?? []) : (t.planets ?? []);
  const flatAnomalies: string[] = t.hexes ? t.hexes.flatMap((h) => h.anomalies ?? []) : (t.anomalies ?? []);
  const flatWormholes: string[] = t.hexes ? t.hexes.flatMap((h) => h.wormholes ?? []) : (t.wormholes ?? []);
  const hasEgress = t.hexes ? t.hexes.some((h) => h.egress) : false;

  return {
    systemId,
    planets: flatPlanets.map(
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
    wormholes: flatWormholes as WormholeType[],
    anomalies: flatAnomalies as AnomalyType[],
    // RR PoK "Place Custodians Token" step: a frontier token goes on every
    // non-home system with no REAL planets (even an anomaly-only system).
    // Base-only games don't have Frontier tokens at all — RR 35's whole
    // Exploration mechanic is PoK-only (see phases/exploration.ts's own
    // mode guard). Never on a Fracture tile regardless (off-map, not part
    // of the normal frontier-exploration flow). TE Space Stations
    // (rulebook clarification): "a system that contains a space station
    // and no planets gets a frontier token" — a space station doesn't
    // count as a "real" planet for this check, even though it has its own
    // entry in this system's own planets array.
    frontierToken: hasPoKContent(mode) && flatPlanets.every((p) => p.isSpaceStation) && !t.isFracture,
    isFracture: t.isFracture || undefined,
    egressToken: hasEgress || undefined,
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
    // RR "Prepare Agenda Deck": confirmed, 13 base-game agendas are pulled
    // from the deck entirely whenever Prophecy of Kings content is in
    // play — filtered here rather than at buildAgendasLookup, since
    // whether they're removed depends on THIS game's mode, not anything
    // fixed about the agenda itself.
    agendaDeck: fisherYatesShuffle(
      Object.entries(rules.agendas)
        .filter(([, a]) => !(hasPoKContent(mode) && a.removedByPoK))
        .map(([id]) => asAgendaId(id)),
      rng,
    ),
    publicObjectiveDeck: {
      stageI: fisherYatesShuffle(stageI.map(asObjectiveId), rng),
      stageII: fisherYatesShuffle(stageII.map(asObjectiveId), rng),
    },
    secretObjectiveDeck: fisherYatesShuffle(secretIds.map(asObjectiveId), rng),
    explorationDecks,
    relicDeck: hasPoKContent(mode) ? fisherYatesShuffle(rules.allRelicIds.map(asRelicId), rng) : [],
  };
}
