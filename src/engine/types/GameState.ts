import {
  AbilityId,
  ActionCardId,
  AgendaId,
  ExplorationCardId,
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
  /** RR 35: has this planet been explored yet (drawn its trait's exploration card)? Re-exploring normally isn't allowed except via specific tech (e.g. Scanlink Drone Network) — not modeled as an override yet, just this one flag. */
  explored: boolean;
  /** RR 53: legendary planets have a separate ability card that exhausts/readies INDEPENDENTLY of the planet card itself (RR: "an ability that readies a planet cannot be used to ready a legendary planet ability card"). Undefined/irrelevant for non-legendary planets. See phases/invasion.ts's setPlanetController for the RR 25.1/53.2 rule on what happens to each when control changes. */
  legendaryAbilityExhausted?: boolean;
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
  /** Which of the player's OWNED exhaustable techs (data/technologies.json's own `exhaustable` flag) are currently exhausted — absent/not-in-list = readied. Readied for everyone during the status phase (RR 70.6), same as strategy cards and planets. */
  exhaustedTechnologies: TechId[];
  unitUpgrades: UnitUpgradeId[]; // owned unit upgrades (RR 86)

  actionCards: ActionCardId[]; // hidden hand, max 7 (RR 2.4)
  /** RR 2.4-adjacent: lifetime count of VOLUNTARY discards only (DISCARD_ACTION_CARD) — never incremented by PLAY_ACTION_CARD's own discard-after-use, per the ruling that "discard N action cards" secret objectives (e.g. Form a Spy Network) only count discarding without playing. Never reset. */
  actionCardsDiscardedCount: number;
  /** RR: notes currently in this player's HAND — tradeable (max 1 per transaction), hideable from other players. Includes this player's own not-yet-traded-away notes AND any received from others (received notes stay tradeable too, "including those from other players" — RR). Ownership (whose color/faction each note matches) is NOT this list; see GameState.promissoryNoteInstances for that. */
  promissoryNotesInHand: PromissoryNoteId[];
  /** RR: notes placed face-up when received — "Support for the Throne", "Alliance", and some faction-specific notes (per each note's own placeInPlayArea flag). These can no longer be traded; they sit here until their own trigger condition returns them to their original owner. */
  promissoryNotesInPlayArea: PromissoryNoteId[];
  secretObjectives: ObjectiveId[]; // unscored secret objectives held, max 3 total incl. scored (RR 52.21)

  leaders: { leaderId: LeaderId; locked: boolean; exhausted: boolean }[]; // PoK/TE agents/commanders/heroes
  relics: RelicId[];
  /** RR 35.9: purge 3 of the same type (Unknown fragments substitute for any one type) to gain a Relic. */
  relicFragments: { cultural: number; industrial: number; hazardous: number; unknown: number };
  /** Exploration cards with `keepInPlayArea` (e.g. "Enigmatic Device") — sit face-up in front of the player until purged, distinct from actionCards/promissoryNotes. */
  explorationCardsInPlayArea: ExplorationCardId[];

  /** Faction- or breakthrough-granted ability ids this player currently has, e.g. "genesis", "versatile", "red_yellow_synergy".
   *  This is the hook point for `player.hasAbility(id)` referenced throughout faction JSON. */
  abilityIds: AbilityId[];
  /**
   * RR "Capture": non-fighter ships and mechs this player has captured from
   * another player (e.g. via Vuil'Raith's own DEVOUR faction ability),
   * sitting on THIS player's own faction sheet rather than the board.
   * `fromPlayerId` is tracked per entry since that's who it returns to
   * (RR: a captured unit returns to ITS OWN owner's reinforcements, not
   * bought/sold generically) — via a transaction agreement, an ability's
   * own cost, or that original owner blockading one of THIS player's space
   * docks (see rules/capture.ts's own note on why fighters/ground forces
   * don't work this way at all). While captured, the original owner
   * cannot produce or place that unit until it's returned.
   */
  capturedUnits: { unitType: UnitType; fromPlayerId: PlayerId; count: number }[];
  /**
   * RR "Capture": fighters/infantry captured by this player are NOT
   * tracked per-original-owner the way ships/mechs are — confirmed, they
   * go straight back to their own owner's reinforcements immediately, and
   * this player instead gets a plain, colorless marker on their own
   * faction sheet (not tradeable, not affected by blockades, only removed
   * by a specific ability instructing it). Since they belong to no
   * player color at all, a flat count per unit type is enough — no
   * fromPlayerId needed.
   */
  capturedGenericUnits: { infantry: number; fighter: number };
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
  /** RR 7.4: laws currently in effect. `outcome` records WHICH result elected it (e.g. "for" vs "against") — needed because a law's own text is often completely different depending on which side won (e.g. Anti-Intellectual Revolution's "for" is an ongoing per-research trigger, its "against" is a one-time effect) — see phases/agendaEffects.ts for where each law's own effect is actually implemented. Absent/undefined `outcome` for laws resolved before this field existed. */
  lawsInPlay: { agendaId: AgendaId; ownerId: PlayerId | "common"; outcome?: string }[]; // RR 7.4
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
  /** RR 52.13: remaining shuffled objective ids per public stage, top of deck = index 0. Empty until game setup seeds them (not built yet) — reveal silently no-ops on an empty deck rather than erroring. */
  publicObjectiveDeck?: { stageI: ObjectiveId[]; stageII: ObjectiveId[] };
  /** RR 2.4/33: remaining shuffled action card ids, top of deck = index 0. Same empty-until-seeded caveat as publicObjectiveDeck. */
  actionCardDeck?: ActionCardId[];
  /** RR 2.9: cards played (or discarded) go here; reshuffled to form a fresh actionCardDeck if that deck is ever drawn from while empty (see phases/actionPhase.ts's own draw logic). */
  actionCardDiscardPile?: ActionCardId[];
  /** RR 52.13: remaining shuffled secret objective ids — drawn via the Imperial strategy card (and, later, other sources). Empty-until-seeded, same caveat as the other two decks above. */
  secretObjectiveDeck?: ObjectiveId[];
  /** RR 35: remaining shuffled exploration card ids per deck, top of deck = index 0. Empty-until-seeded, same caveat as the other decks above. */
  explorationDecks?: {
    cultural: ExplorationCardId[];
    industrial: ExplorationCardId[];
    hazardous: ExplorationCardId[];
    frontier: ExplorationCardId[];
  };
  /** RR 35.9: remaining shuffled relic ids. */
  relicDeck?: RelicId[];
  /**
   * RR: which player owns each promissory note in THIS game, and its
   * display info — populated once at setup (see rules/promissoryNotes.ts's
   * initializePromissoryNotes) from RuleData's generic templates + faction
   * notes, combined with each player's actual assigned color/faction.
   * Generic notes' concrete instance id is `${templateId}_${color}` (e.g.
   * "ceasefire_red"); faction notes reuse their own id from
   * RuleData.factionPromissoryNotes. Ownership never changes even if the
   * owner is later eliminated (RR's elimination cleanup is a separate,
   * not-yet-built concern) — this is just "whose color/faction was this
   * printed for", not "who currently holds it" (see promissoryNotesInHand/
   * promissoryNotesInPlayArea on Player for that).
   */
  promissoryNoteInstances?: Record<PromissoryNoteId, { ownerId: PlayerId; name: string; timing: string; effect: string; placeInPlayArea: boolean }>;
  /**
   * RR 70.1: per-player scoring state for the status phase currently in
   * progress — reset when the action phase ends and this phase begins.
   * `done` means this player has told the engine they're finished scoring
   * (FINISH_STATUS_PHASE_SCORING); once every non-eliminated player is
   * done, the rest of the status phase's automatic bookkeeping runs and
   * the game moves on. Absent/undefined for a player = hasn't scored or
   * finished yet this status phase.
   */
  statusPhaseScoring?: Partial<Record<PlayerId, { scoredPublic: boolean; scoredSecret: boolean; done: boolean }>>;

  /** Active tactical action in progress, if any — null between actions. Lets the engine resume mid-combat across async turns. */
  pendingTacticalAction: PendingTacticalAction | null;
  /** Active agenda vote in progress, if any. */
  pendingAgendaVote: PendingAgendaVote | null;
  /** RR 8: exactly 2 agendas get resolved per agenda phase (fewer if the deck runs out). Reset to 0 when the agenda phase begins. */
  agendaPhaseAgendasResolved?: number;
  /** RR 3.3-ish: which player most recently passed this action phase — reset to undefined when a new round starts. Needed for the "last to pass" secret objective (prove_endurance); not used for any turn-legality check. */
  lastPlayerToPass?: PlayerId;
  /** The most recently resolved agenda's winning outcome — needed for the "elected by an agenda" secret objective (drive_the_debate). Persists across rounds (not reset), since only the MOST RECENT resolution matters, not "this round's". */
  lastResolvedAgenda?: { agendaId: AgendaId; outcome: string };
  /**
   * RR "Fleet Logistics": how many of the CURRENT activePlayerId's own
   * actions (tactical action completing, or a component action like X-89/
   * Sling Relay) have been completed so far this "turn-in-rotation" —
   * only ever matters for a player who owns Fleet Logistics (everyone
   * else's turn always ends after 1, per the normal RR 3 turn structure).
   * Reset to 0/undefined whenever activePlayerId actually changes (see
   * phases/actionPhase.ts's own maybeAdvanceActivePlayer, the shared
   * function every "an action just finished" call site uses instead of
   * calling advanceActivePlayer directly). PASS is NOT affected by this —
   * passing always ends a player's participation for the rest of the
   * round outright (RR 3.3), it isn't "ending one action" the way
   * finishing a tactical/component action is.
   */
  activePlayerActionsTaken?: number;
  /**
   * RR "Deploy": each deploy-ability instance (e.g. Titans of Ul's Ouranos
   * flagship's own DEPLOY) can only be resolved once per occurrence of its
   * own timing window — not a persistent exhausted-until-readied state
   * like a tech card, closer to how AFB only fires once per combat. Since
   * different factions' Deploy triggers open and close at different
   * points (most are tactical-action-scoped, e.g. "after you activate a
   * system", but not necessarily all of them), this is a flat list of
   * deploy-ability ids already resolved in the CURRENTLY open window
   * rather than anything more structured. Reset to `[]` alongside
   * `recentEvents` whenever a new tactical action starts (see
   * phases/tacticalAction.ts's activateSystem) — the natural reset point
   * for the large majority of Deploy triggers, which are themselves
   * tactical-action-scoped. See rules/deploy.ts for the shared
   * check/mark helpers every per-faction Deploy implementation should use
   * instead of rolling its own tracking.
   */
  usedDeployAbilities?: string[];
  /**
   * RR "Anti-Intellectual Revolution" ("for" outcome, an ONGOING law once
   * in effect): players who currently owe destroying 1 of their own
   * non-fighter ships, because they just researched a technology while
   * this law's "for" side was active — a real choice of WHICH ship,
   * same "player picks, not auto-selected" pattern as everywhere else in
   * this project. See phases/agendaEffects.ts.
   */
  pendingAntiIntellectualRevolutionDestruction?: PlayerId[];
  /**
   * RR "Anti-Intellectual Revolution" ("against" outcome, a ONE-TIME
   * effect at the start of the next strategy phase): players who still
   * need to submit which planets they're exhausting (one per technology
   * they currently own) — blocks that next strategy phase from actually
   * starting until every listed player has submitted, since RR "at the
   * start of" effects resolve before anything else in that phase can.
   */
  pendingAntiIntellectualRevolutionExhaustion?: PlayerId[];
  /**
   * RR 52-adjacent: a short rolling buffer of this game's own already-typed
   * GameEvents (see Actions.ts), reused as-is rather than inventing a
   * parallel "combat history" structure. Needed for actionPhase-timed
   * secret objectives that check "did X just happen" (e.g. "win a combat
   * in a system with an anomaly") — GameState otherwise only tracks
   * CURRENT state, not what led to it.
   *
   * Cleared whenever a NEW tactical action starts (ACTIVATE_SYSTEM) — so
   * it always reflects "what happened during the most recently active
   * tactical action", which is the natural window these objectives expect
   * ("immediately", per their card text) without needing to model turn
   * ownership precisely. Also hard-capped at 200 entries as a safety net
   * against unbounded growth in edge cases.
   */
  recentEvents?: import("./Actions").GameEvent[];

  winnerId: PlayerId | null;
}

/** Tracks progress through RR 78's five steps so a tactical action can span multiple async messages/turns. */
export interface PendingTacticalAction {
  playerId: PlayerId;
  systemId: SystemId;
  step: TacticalStep;
  /** Round number of an in-progress space or ground combat (RR 67.3–67.8 / 38), reset to 1 when combat starts. */
  combatRound?: number;
  /** Players who have announced a retreat this combat round but not yet executed it (RR 67.4), and where to. */
  retreating?: { playerId: PlayerId; toSystemId: SystemId }[];
  /**
   * RR 67.6/38.2: hits scored against each player in the current combat
   * round that they still need to assign (destroy/flip units for) via
   * ASSIGN_HITS. Populated by RESOLVE_COMBAT_ROUND, entries removed as each
   * affected player submits their assignment — the round only advances
   * (check for a winner, start the next round, or move on) once this is
   * empty again.
   */
  pendingHits?: Partial<Record<PlayerId, number>>;
  /** RR 44: which planet is currently having ground combat resolved (a system can have multiple contested planets; they resolve one at a time, in whatever order the attacker committed forces). Undefined = no ground combat active right now. */
  currentInvasionPlanetId?: PlanetId;
  /**
   * RR 44.2/44.4: contested planets (2+ players' ground forces) still
   * awaiting ground combat, as an unordered set — NOT a queue. The active
   * player picks which one resolves next via START_GROUND_COMBAT each
   * time, independent of the order they were committed in.
   */
  remainingInvasionPlanetIds?: PlanetId[];
  /** RR 44.2: true once the active player has signaled they're done committing ground forces this invasion step (FINISH_INVASION_COMMITS) — after that, no more COMMIT_GROUND_FORCES, and START_GROUND_COMBAT becomes available. */
  invasionCommitsFinished?: boolean;
  /**
   * RR 77: after movement, ANY player (not just attacker/defender — even
   * one with no ships in this combat at all) who has a PDS in the just-
   * activated system, or a PDS with Space Cannon's `rangesToAdjacent`
   * upgrade in an adjacent system, may independently choose to fire at the
   * active player's ships before combat. This lists who still hasn't
   * decided (fire or skip) — cleared entries as each responds, in no
   * particular required order. Once empty (and no pendingHits left to
   * assign), the tactical action moves on to spaceCombat/invasion.
   */
  spaceCannonOffenseRespondersRemaining?: PlayerId[];
  /**
   * RR 67.1: Anti-Fighter Barrage — mandatory (not optional like Space
   * Cannon Offense) for whichever combatants have AFB-capable ships, fires
   * once at the start of round 1 only, targeting only fighters. Lists who
   * still has to submit their roll; combatRound stays undefined while this
   * is non-empty, becoming 1 once it's empty (whether because everyone
   * fired or because nobody ever qualified).
   */
  afbPendingPlayers?: PlayerId[];
  /**
   * RR 44 Space Cannon Defense: the defender's own optional choice, before
   * ground combat starts, to fire their planet's PDS at the attacker's
   * just-committed ground forces. True while waiting on that decision for
   * the current invasion planet; cleared (fired or skipped) before ground
   * combat's combatRound is set to 1.
   */
  spaceCannonDefensePending?: boolean;
  /**
   * RR "Duranium Armor": after a player assigns this round's hits, if they
   * own the tech AND have at least one Sustain-Damage unit that was
   * ALREADY damaged BEFORE this round's hits (not just-flipped by them),
   * they get a real choice — repair one such unit (their pick, if more
   * than one qualifies) or skip. Lists who still has this decision
   * pending; the round can't wrap up (next round / end of combat) until
   * this is empty too, same "gate before advancing" pattern as pendingHits.
   */
  duraniumArmorPendingPlayers?: PlayerId[];
  /**
   * RR "Magen Defense Grid" (base version, base-mode games only): the
   * defender's own optional choice, at the start of ground combat on a
   * planet where they have a Planetary-Shield-capable unit, to exhaust
   * this card so the ATTACKER can't roll any combat dice this round.
   * True while waiting on that decision. Simplification, flagged: only
   * offered before ROUND 1 (alongside/instead of Space Cannon Defense),
   * not re-offered for later rounds of the same combat, and skipped
   * entirely if Space Cannon Defense already qualified this same call.
   */
  magenDefenseGridPending?: boolean;
  /** Set once the defender actually USES Magen Defense Grid (base version) — the attacker in `pendingTacticalAction.playerId` can't roll dice for round 1; see rules/combat.ts's buildGroundCombatEntries. */
  groundCombatAttackerBlockedThisRound?: boolean;
  /**
   * RR "Magen Defense Grid" ΩΩ (Codex 4, everywhere except base-only
   * games): NOT optional and doesn't exhaust anything — if the defender
   * has 1+ structures on this planet, they automatically get 1 hit at the
   * start of ground combat, which THEY assign to 1 of the attacker's
   * units. True while that assignment is still owed (see
   * assignMagenDefenseGridHit) — kept separate from the normal
   * `pendingHits`-driven round flow so resolving it doesn't accidentally
   * trigger wrapUpGroundCombat before round 1 has even properly started.
   */
  magenDefenseGridAutoHitPending?: boolean;
  /** RR "Graviton Laser System": true while the CURRENTLY pending Space Cannon Offense hits (if any) must be assigned to non-fighter ships first, while any remain — set when the firing player exhausts it, cleared once those hits are actually assigned. */
  gravitonLaserSystemRestrictsPendingHits?: boolean;
  /**
   * RR "Assault Cannon": which player currently owes the mandatory (no
   * skip — see phases/spaceCombat.ts's own note) destruction of 1 of
   * their own non-fighter ships. Resolution order is confirmed: the
   * ACTIVE player's own trigger (if any) is checked and resolved FIRST;
   * only once that's done is the DEFENDER's own trigger checked, against
   * the by-then-possibly-reduced ship count — so it's possible for the
   * defender's trigger to no longer apply if the attacker's assault
   * cannon already took them below 3 non-fighter ships. `assaultCannonStage`
   * tracks which of those two checks this pending decision came from, so
   * useAssaultCannonDestruction knows whether to check the other side next.
   */
  assaultCannonPendingPlayer?: PlayerId;
  assaultCannonStage?: "attacker" | "defender";
}

export interface PendingAgendaVote {
  agendaId: AgendaId;
  /** Whose turn it is to cast votes, per RR 8.2.ii (starts left of speaker). */
  votingOrder: PlayerId[];
  nextVoterIndex: number;
  votesByOutcome: Record<string, { playerId: PlayerId; votes: number }[]>;
  /**
   * RR "Predictive Intelligence": which outcome (if any) each player who
   * used its +3-votes bonus voted for on THIS agenda — checked once the
   * agenda resolves (resolveAgendaVote) to conditionally exhaust the tech
   * (only if their chosen outcome did NOT win; RR: "if you do, and the
   * outcome you voted for is not resolved, exhaust this card" — winning
   * means it stays readied).
   */
  predictiveIntelligenceBonusUsedBy?: Partial<Record<PlayerId, string>>;
}
