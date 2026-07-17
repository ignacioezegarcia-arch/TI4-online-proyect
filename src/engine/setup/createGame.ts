import { GameState, Player, SystemState, PlanetState } from "../types/GameState";
import { PlayerId, FactionId, SystemId, PlanetId, asSystemId, asPlanetId, asAgendaId, asObjectiveId, asActionCardId, asExplorationCardId, asRelicId, asTechId, asStrategyCardId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { GameMode, UnitType, AnomalyType, WormholeType } from "../types/enums";
import { generateMap, fisherYatesShuffle, PlaceableTile } from "./mapGeneration";
import { initializePromissoryNotes } from "./promissoryNotes";
import { planetNameToId } from "../rules/ruleDataMapping";

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
 *  - PoK leaders (74 cards, lock/unlock system), mechs, the Wormhole
 *    Nexus, faction-specific extra setup components (Creuss's gamma
 *    wormhole token, Vuil'raith/Nekro's dimensional tears, Titans' sleeper
 *    tokens, Muaat's supernova tile), and Mahact's own setup exception
 *    (purging their own Alliance note) — real, confirmed rules, just not
 *    built yet. Flagged here rather than silently skipped.
 */

/** A raw tiles.json tile entry, full shape (this file needs planets/anomalies/wormholes, not just the slimmed-down static data RuleData.planets exposes). */
export interface RawTileEntry {
  id: number;
  name: string;
  homeFaction?: string;
  isHyperlane?: boolean;
  isBlank?: boolean;
  planets?: { name: string; resources: number; influence: number; traits?: string[]; tech?: string[]; isLegendary?: boolean; isMecatolRex?: boolean }[];
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
    input.players.map(
