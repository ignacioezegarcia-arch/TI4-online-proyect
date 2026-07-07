import {
  AbilityId,
  ActionCardId,
  AgendaId,
  FactionId,
  LeaderId,
  ObjectiveId,
  PlanetId,
  PlayerId,
  PromissoryNoteId,
  RelicId,
  StrategyCardId,
  SystemId,
  TechId,
  UnitUpgradeId,
} from "./ids";
import { AnomalyType, CommandPool, GameMode, ObjectiveKind, Phase, TacticalStep, UnitType, WormholeType } from "./enums";

/**
 * A stack of same-type units belonging to one player in one location
 * (a system's space area, OR a specific planet within that system).
 * TI4 units are interchangeable within a type — the physical game only ever
 * distinguishes "damaged" via the Sustain Damage side-flip — so we model
 * units as counts rather than individuated objects. This keeps state small,
 * JSON-serializable, and trivial to diff for Supabase Realtime payloads.
 */
export interface UnitStack {
  unitType: UnitType;
  /** Which unit-upgrade tech (if any) is currently active for this stack, e.g. "cruiser_ii". Undefined = base/faction sheet stats. */
  upgradeId?: UnitUpgradeId;
  count: number;
  /** RR 76: units with Sustain Damage that have already absorbed a hit. Always <= count. */
  damagedCount: number;
}

/** RR 55 / RR 12: a planet's live game state. Static data (resources, influence, trait) lives in data/tiles.json — this is only what changes during play. */
export interface PlanetState {
  planetId: PlanetId;
  controllerId: PlayerId | null;
  /** RR 55.6: readied (spendable) vs exhausted. */
  exhausted: boolean;
  /** RR 12: exploration cards with an "Attach" header, e.g. Dyson Sphere. Stores the attachment card id. */
  attachmentIds: string[];
  /**
   * Ground forces and structures physically on the planet (RR 39, 74), keyed
   * by owning player — mirrors SystemState.spaceUnitsByPlayer. Needs to be
   * per-player (not a flat array) because during the Invasion step (RR 44)
   * an attacker's just-landed ground forces and the defender's original
   * ground forces are BOTH present on the same planet simultaneously, before
   * ground combat resolves them down to one side. A flat array can't tell
   * them apart.
   */
  unitsByPlayer: Partial<Record<PlayerId, UnitStack[]>>;
  /** TE p.11 COEXIST: a second player whose units coexist here without triggering combat. Null outside Thunder's Edge. */
  coexistingPlayerId?: PlayerId | null;
  /** TE space stations (p.10) act like planets but can't hold ground forces/structures; flag so invasion logic can reject commits here. */
  isSpaceStation?: boolean;
}

/** RR 77: a system tile's live game state. */
export interface SystemState {
  systemId: SystemId;
  planets: PlanetState[];
  /** Ships and fighters in the space area, per owning player. */
  spaceUnitsByPlayer: Partial<Record<PlayerId, UnitStack[]>>;
  wormholes: WormholeType[];
  /** RR 9.5: a system can combine more than one anomaly type (e.g. tile 82, "Asteroid Field / Alpha Wormhole"). Empty array = not an anomaly. */
  anomalies: AnomalyType[];
  /** TE p.9 Ingress/Egress tokens linking to The Fracture. Empty outside Thunder's Edge / before it's rolled into play. */
  ingressToken?: boolean;
  egressToken?: boolean;
  /** Frontier token per PoK setup (RR "Frontier Tokens"); consumed on exploration. */
  frontierToken?: boolean;
}

/** RR 19 / RR 18: a player's command token pools + tokens currently sitting on the board. */
export interface CommandTokens {
  tactic: number;
  fleet: number;
  strategy: number;
  /** Systems where this player has an activated command token sitting on the tile (RR 5.1), cleared at status phase step 4 (RR 70.4). */
  onBoard: SystemId[];
}

/** RR 87: a player's progress on the victory point track. */
export interface VictoryPointState {
  current: number;
  /** Which objective/law/relic ids have already been scored, so they can't be scored twice (RR 52.8). */
  scoredObjectiveIds: ObjectiveId[];
}

export interface Player {
  id: PlayerId;
  factionId: FactionId;
  color: string; // matches a key in commandTokens.json / controlTokens.json color art, not a rules concept
  isSpeaker: boolean;
  /** RR 3.3: has this player passed for the remainder of the current action phase? Reset every action phase. */
  hasPassed: boolean;
  eliminated: boolean;

  commandTokens: CommandTokens;
  victoryPoints: VictoryPointState;

  /** RR 72.8: strategy card(s) currently in this player's play area for the round. 2 cards in 3-4p games (RR "Three– and Four–Player Games"). */
  strategyCards: { cardId: StrategyCardId; exhausted: boolean }[];

  resourcesAvailable: number; // derived cache; see selectors/derive.ts — not authoritative, recompute from planets
  influenceAvailable: number; // derived cache; see selectors/derive.ts

  commodities: number; // current commodity tokens (RR 20)
  tradeGoods: number; // current trade good tokens (RR 82)

  technologies: TechId[]; // owned, non-unit-upgrade techs (RR 79.1)
  unitUpgrades: UnitUpgradeId[]; // owned unit upgrades (RR 86)

  actionCards: ActionCardId[]; // hidden hand, max 7 (RR 2.4)
  promissoryNotes: PromissoryNoteId[]; // hand of notes received from others, plus own unplayed ones conceptually always "available"
  secretObjectives: ObjectiveId[]; // unscored secret objectives held, max 3 total incl. scored (RR 52.21)

  leaders: { leaderId: LeaderId; locked: boolean; exhausted: boolean }[]; // PoK/TE agents/commanders/heroes
  relics: RelicId[];

  /** Faction- or breakthrough-granted ability ids this player currently has, e.g. "genesis", "versatile", "red_yellow_synergy".
   *  This is the hook point for `player.hasAbility(id)` referenced throughout faction JSON. */
  abilityIds: AbilityId[];
}

/** RR 52.13 + 52.17: objective card pools. Card content (requirements, VP value) lives in data/objectives.json; this is only reveal/scoring state. */
export interface ObjectiveState {
  kind: ObjectiveKind;
  objectiveId: ObjectiveId;
  revealed: boolean; // always true for secrets once drawn (they're just hidden from *other* players, not face-down to their owner)
}

/** Which agenda cards are still in the deck vs discarded — content lives in data/agendas.json. */
export interface AgendaDeckState {
  deckIds: AgendaId[]; // remaining, order matters (top of deck = index 0)
  discardIds: AgendaId[];
  lawsInPlay: { agendaId: AgendaId; ownerId: PlayerId | "common" }[]; // RR 7.4
}

/**
 * The root game object. Fully serializable (no class instances, no Maps —
 * Supabase stores this as a `jsonb` column), so it can be persisted with a
 * plain `JSON.stringify` and pushed over Realtime without a custom codec.
 */
export interface GameState {
  gameId: string;
  mode: GameMode;
  victoryPointTarget: 10 | 14; // RR 87.2

  phase: Phase;
  round: number; // increments each time we return to the strategy phase (RR 36)

  players: Record<PlayerId, Player>;
  /** Turn order for the strategy phase (starts with speaker, RR 73.1) — NOT the same as initiative order. */
  seatOrder: PlayerId[];
  /** RR 43: derived each round from chosen strategy cards' initiative numbers; recomputed by the engine, never hand-edited. */
  initiativeOrder: PlayerId[];
  activePlayerId: PlayerId | null;

  systems: Record<SystemId, SystemState>;
  /**
   * Physical hex adjacency (RR 6) as placed at setup, including any
   * hyperlane-created edges (RR "Hyperlanes") — computed once from
   * data/boardLayouts.json when the game is created and then treated as
   * immutable for the rest of the game. Wormhole adjacency (RR 6.1) is
   * NOT baked in here since wormholes can change mid-game (Wormhole Nexus
   * flipping active, Dark Energy Tap exploration); see rules/adjacency.ts,
   * which combines this graph with live wormhole state on every query.
   */
  boardAdjacency: Record<SystemId, SystemId[]>;
  mecatolCustodiansRemoved: boolean; // RR 26: gates whether the agenda phase runs this round (RR 8.1)

  /** Which strategy card ids are still unclaimed in the common play area this round, and trade goods sitting on them (RR 73.2). */
  unclaimedStrategyCards: { cardId: StrategyCardId; tradeGoods: number }[];

  objectives: ObjectiveState[];
  agendaDeck: AgendaDeckState;

  /** Active tactical action in progress, if any — null between actions. Lets the engine resume mid-combat across async turns. */
  pendingTacticalAction: PendingTacticalAction | null;
  /** Active agenda vote in progress, if any. */
  pendingAgendaVote: PendingAgendaVote | null;

  winnerId: PlayerId | null;
}

/** Tracks progress through RR 78's five steps so a tactical action can span multiple async messages/turns. */
export interface PendingTacticalAction {
  playerId: PlayerId;
  systemId: SystemId;
  step: TacticalStep;
  /** Round number of an in-progress space or ground combat (RR 67.3–67.8 / 38), reset to 1 when combat starts. */
  combatRound?: number;
  /** Players who have announced a retreat this combat round but not yet executed it (RR 67.4). */
  retreatingPlayerIds?: PlayerId[];
}

export interface PendingAgendaVote {
  agendaId: AgendaId;
  /** Whose turn it is to cast votes, per RR 8.2.ii (starts left of speaker). */
  votingOrder: PlayerId[];
  nextVoterIndex: number;
  votesByOutcome: Record<string, { playerId: PlayerId; votes: number }[]>;
}
