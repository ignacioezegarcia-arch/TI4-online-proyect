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
import { AnomalyType, CommandPool, GameMode, ObjectiveKind, Phase, TacticalStep, UnitType, WormholeType, ThunderEdgeExpeditionSliceCost } from "./enums";

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
  /** TE "Dok'N Pic's Salvage Yard" (Garbozia's own legendary planet ability): action cards placed faceup on this specific card, purgeable later to play as if from hand. Only ever meaningful on Garbozia itself. */
  storedActionCardIds?: string[];
  /** RR 35: has this planet been explored yet (drawn its trait's exploration card)? Re-exploring normally isn't allowed except via specific tech (e.g. Scanlink Drone Network) — not modeled as an override yet, just this one flag. */
  explored: boolean;
  /** RR 53: legendary planets have a separate ability card that exhausts/readies INDEPENDENTLY of the planet card itself (RR: "an ability that readies a planet cannot be used to ready a legendary planet ability card"). Undefined/irrelevant for non-legendary planets. See phases/invasion.ts's setPlanetController for the RR 25.1/53.2 rule on what happens to each when control changes. */
  legendaryAbilityExhausted?: boolean;
  /** RR agenda-attachment cards with their OWN exhaustable ability (currently just the 4 Research Team variants) — separate from the planet's own readied/exhausted state, same "own independent exhausted-state" pattern as legendaryAbilityExhausted above. Which specific attachment ids (from `attachmentIds`) are currently exhausted. */
  exhaustedAttachmentIds?: string[];
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
  /** TE COEXIST (yjmrobert.com/tirules/rules/r_coexistence): every OTHER player currently coexisting with this planet's own controller — confirmed to genuinely support more than 1 simultaneously (rule 10's own "start an additional ground combat against another coexisting player, if present"), so this is an array, not a single value. Empty/undefined outside a coexisting state. */
  coexistingPlayerIds?: PlayerId[];
  /** TE space stations (p.10) act like planets but can't hold ground forces/structures; flag so invasion logic can reject commits here. */
  isSpaceStation?: boolean;
  /** RR "Stellar Converter" (relic): "place the destroyed planet token on that planet" — the planet keeps existing as an entry (preserving its own identity/data) rather than being deleted outright, marked destroyed instead. "A system that contains a planet destroyed by Stellar Converter, and no other planets, is considered to contain no planets" — checked the same way isSpaceStation is checked wherever "does this system have any REAL planets" matters (frontier tokens, objectives, etc.). No units can ever occupy a destroyed planet again; it produces no resources/influence and has no traits/specialties for any purpose. */
  destroyed?: boolean;
}

/** RR 77: a system tile's live game state. */
export interface SystemState {
  systemId: SystemId;
  planets: PlanetState[];
  /** Ships and fighters in the space area, per owning player. */
  spaceUnitsByPlayer: Partial<Record<PlayerId, UnitStack[]>>;
  wormholes: WormholeType[];
  /** Frontier "Ion Storm" (exploration card): which side is currently face up in this system — flips at the end of a Move Ships/Retreat sub-step during which 1+ of the OWNER's own ships used the ion storm wormhole. KNOWN SCOPE LIMIT: the flip-on-wormhole-use trigger itself isn't wired into movement resolution yet (see phases/exploration.ts's own applyExplorationCard) — only the initial placement/face is tracked here. */
  ionStormFace?: "asteroid_field" | "gravity_rift";
  /** RR 9.5: a system can combine more than one anomaly type (e.g. tile 82, "Asteroid Field / Alpha Wormhole"). Empty array = not an anomaly. */
  anomalies: AnomalyType[];
  /** TE p.9 Ingress/Egress tokens linking to The Fracture. Empty outside Thunder's Edge / before it's rolled into play. */
  ingressToken?: boolean;
  egressToken?: boolean;
  /** Frontier token per PoK setup (RR "Frontier Tokens"); consumed on exploration. */
  frontierToken?: boolean;
  /** TE The Fracture (rulebook p.9): true for the 3 off-map Fracture system tiles themselves — set once from tiles.json's own isFracture flag at game creation, never changes afterward. Also used by phases/expedition.ts's own completion check ("Thunder's Edge cannot be placed in The Fracture"). */
  isFracture?: boolean;
  /**
   * TE INCURSION (Crimson Rebellion faction ability): "inactive" or
   * "active" once a breach token has ever been placed here; undefined =
   * no breach token at all. Systems that are both "active" are mutually
   * adjacent to EACH OTHER (rules/adjacency.ts's own getAdjacentSystems
   * reads this dynamically, same pattern as wormholes) — this applies
   * for every player, not just the Rebellion, matching the ability's own
   * unqualified wording ("systems that contain active breaches are
   * adjacent"). Flipping active<->inactive and initial placement are
   * both Crimson-Rebellion-specific triggers (INCURSION itself, and
   * their own Resonance Generator breakthrough) — see
   * phases/breaches.ts. Removal at the end of the status phase is
   * available to ANY player with ships in an active-breach system, not
   * Rebellion-specific.
   */
  breachState?: "inactive" | "active";
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
  /** RR "Political Stability": true for the round this player chose to keep their strategy card(s) instead of returning them — checked once by phases/actionPhase.ts's own startNewRound, then cleared there. */
  politicalStabilityKeepCards?: boolean;
  /** RR "Political Stability": true for exactly 1 upcoming strategy phase — this player doesn't choose a strategy card that round (phases/strategyPhase.ts's own isPlayersStrategyTurnInternal skips them). Cleared once that strategy phase's picks are all done. */
  skipsNextStrategyPick?: boolean;
  /** RR "Master Plan": true once played, until the next time this player's OWN action would otherwise end their turn (phases/actionPhase.ts's own maybeAdvanceActivePlayer) — consumed then, granting exactly 1 extra action. */
  masterPlanBonusAvailable?: boolean;
  /** RR "War Machine": true once played, until the next PRODUCE_UNITS this player performs (phases/production.ts's own executeProduction) — consumed then. */
  warMachineActive?: boolean;
  /** RR "Public Disgrace": strategy card id(s) this player was just forced to NOT re-pick after an undone choice (phases/strategyPhase.ts's own chooseStrategyCard checks this) — cleared the moment they successfully pick anything else. */
  excludedStrategyCardIds?: StrategyCardId[];
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
  /** A relic's own component action can be "exhaust" (Circlet of the Void, Scepter of Emelpar, The Prophet's Tears, Crown of Emphidia's own explore ability) rather than "purge" (most relics — one-time, removed from Player.relics entirely on use). Tracked separately since player.relics itself only means "owned", not "currently available to use". RR: everything exhausted during the action phase readies at the end of the status phase, same as planets — this project's own runStatusPhaseBookkeeping (actionPhase.ts) readies every exhausted relic there too, not just planets. The Triad (a relic that behaves like an actual planet card) is the one confirmed EXCEPTION worth calling out — it's explicitly confirmed to ready "by effects that ready planets" specifically, which is really the same general rule, not a special case. */
  exhaustedRelics?: RelicId[];
  /** RR "The Silver Flame" (relic): "you cannot score public objectives" — a permanent, ongoing restriction once triggered (this project's own rules/relics.ts's own useSilverFlame is the only current source of this flag). */
  cannotScorePublicObjectives?: boolean;
  /** Sol "Spec Ops II" (RESPAWN): count of destroyed Spec Ops infantry currently "on this card", waiting to be placed on a home-system planet at the start of this player's next turn (rules/sol.ts's own checkSpecOpsRespawn/placeRespawnedSpecOps). */
  specOpsOnCard?: number;
  /** Letnev "Darktalon Treilla — DARK MATTER AFFINITY" (hero): active for the rest of THIS game round once used, then purged. See rules/letnev.ts's own getMaxNonFighterShips. */
  darktalonTreillaActive?: boolean;
  /** Letnev "Darktalon Treilla — DARK MATTER AFFINITY": set once her bypass ends and this player is left over their own fleet-supply limit somewhere — resolved via rules/letnev.ts's own resolveFleetCleanup (RESOLVE_FLEET_CLEANUP), the player's own choice of which ships to remove. */
  pendingFleetCleanupSystemIds?: SystemId[];
  /** RR 35.9: purge 3 of the same type (Unknown fragments substitute for any one type) to gain a Relic. */
  relicFragments: { cultural: number; industrial: number; hazardous: number; unknown: number };
  /** Exploration cards with `keepInPlayArea` (e.g. "Enigmatic Device") — sit face-up in front of the player until purged, distinct from actionCards/promissoryNotes. */
  explorationCardsInPlayArea: ExplorationCardId[];
  /** "Freelancers" (exploration card): each entry is 1 unused "you may produce 1 unit in this system; you may spend influence as resources to produce it" grant, tracked by which system it was drawn in — set by phases/exploration.ts's own applyExplorationCard, consumed by phases/production.ts's own executeProduction (its own freelancersActive flag). Multiple entries can stack if several Freelancers are drawn before any are used. */
  pendingFreelancersGrants?: SystemId[];
  /** L1Z1X "ASSIMILATE": structure replacements owed but not yet fulfilled because reinforcements were empty at the moment control was gained — resolved later via rules/l1z1x.ts's own resolveAssimilateSubstitute (steal from elsewhere), or simply left unfulfilled if the player never does (RR confirms this isn't forced when reinforcements are truly empty). */
  pendingAssimilateReplacements?: { planetId: PlanetId; unitType: UnitType }[];

  /** Faction- or breakthrough-granted ability ids this player currently has, e.g. "genesis", "versatile", "red_yellow_synergy".
   *  This is the hook point for `player.hasAbility(id)` referenced throughout faction JSON. */
  abilityIds: AbilityId[];
  /**
   * TE Breakthroughs (yjmrobert.com/tirules/rules/r_breakthroughs, TE
   * rulebook p.8): true once this player has actually gained their
   * faction's breakthrough — most factions earn this mid-game (claiming
   * a Thunder's Edge expedition slice, or a faction-specific trigger),
   * NOT automatically from turn 1. rules/breakthroughs.ts's own
   * grantBreakthrough is the one place this should ever flip to true.
   * Gates whether RuleData.factions[factionId].breakthroughSynergy is
   * actually applied anywhere (technology.ts's own checkTechPrerequisites,
   * tech-color objective checks) — the data itself is always present per
   * faction, but shouldn't count until earned.
   */
  hasBreakthrough?: boolean;
  /** Arborec "Psychospore" (Breakthrough ability): the FIRST Breakthrough this project has built that explicitly says "ACTION: Exhaust this card" — every OTHER Breakthrough implemented so far (Bellum Gloriosum, Archon's Gift, Auto-Factories, N'orr Supremacy, Specialized Compounds) is either passive or exhausts something ELSE (a planet), so hasBreakthrough alone was never insufficient before this one. Readied during the status phase, same as leaders/technologies. */
  breakthroughExhausted?: boolean;
  /**
   * TE NEUTRAL UNITS (rulebook p.10): true only for the single, special
   * "neutral" pseudo-player entry (see ids.ts's own NEUTRAL_PLAYER_ID)
   * used to hold Fracture guardian units — never a real seat, never in
   * seatOrder/turn rotation, never eliminated, never scores. Existing
   * combat/reinforcement code can keep treating unitsByPlayer/
   * spaceUnitsByPlayer entries under this id as "another player's units"
   * without special-casing every call site (matches the rulebook's own
   * "neutral units count as other players' units for the purpose of
   * resolving players' abilities and other game effects" — there is,
   * however, no real neutral PLAYER making decisions; the speaker
   * decides for them, per phases/neutralUnits.ts's own rollForNeutralUnits).
   */
  isNeutral?: boolean;
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
  /** RR 33.9: the number of players this game STARTED with (before any eliminations) — needed because a game that began with 5+ players keeps everyone at 1 strategy card per round even after eliminations bring it down to 4 or fewer, unlike a game that genuinely started with 3-4. See phases/strategyPhase.ts's getStrategyCardsPerPlayer. */
  startingPlayerCount?: number;

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
  /** TE Breakthroughs (rulebook p.8): once ANY player's breakthrough-gain triggers a die roll of 1 or 10, The Fracture comes into play — a shared, one-time, whole-game flag (not per-player), checked by rules/breakthroughs.ts's own grantBreakthrough before it bothers rolling again. */
  fractureInPlay?: boolean;
  /** RR (yjmrobert.com/tirules/rules/r_transactions): canonical pair keys ("playerA|playerB", sorted) of players who've already transacted this ACTION-PHASE turn — reset whenever activePlayerId changes (see actionPhase.ts's own advanceActivePlayer/maybeAdvanceActivePlayer). Not used during the agenda phase, which tracks its own separate allowance below. */
  transactionsThisTurn?: string[];
  /** RR (yjmrobert.com/tirules/rules/r_transactions): "while resolving each agenda... a player may perform one transaction with each other player" without needing to be neighbors — canonical pair keys, reset whenever a new agenda is revealed (including a discarded-and-replaced one, per the confirmed note that grants a fresh allowance then). */
  transactionsThisAgenda?: string[];
  /** TE "Lie in Wait": the 2 players whose transaction just triggered the after_transaction_resolved window above — banked here since the window's own `order` only lists potential REACTORS, not who they're reacting to. */
  pendingLieInWaitTargets?: [PlayerId, PlayerId];
  /** Sol "Genesis" (flagship): "placing the infantry during the status phase is mandatory. After, the Sol player might need to remove an infantry or fighter to meet capacity limits" (confirmed, yjmrobert.com/tirules/factions/f_sol) — tracked here as a pending choice (which unit type to remove) rather than blocking the status phase transition; resolved via RESOLVE_GENESIS_CAPACITY_OVERFLOW. */
  pendingGenesisCapacityOverflow?: { playerId: PlayerId; systemId: SystemId }[];
  /** Arborec "MITOSIS": players who still need to choose which controlled planet gets their mandatory 1 infantry this status phase — see phases/actionPhase.ts's own runStatusPhaseBookkeeping and rules/arborec.ts's own resolveMitosisPlacement. */
  pendingMitosisPlacements?: PlayerId[];
  /** Sol "Military Support" (promissory note): "cannot be played twice in one timing window" (confirmed, yjmrobert.com/tirules/factions/f_sol) — tracks whether it's already been used during THIS specific active-player turn; reset whenever the active player changes (phases/actionPhase.ts's own advanceActivePlayer), same as transactionsThisTurn above. */
  usedMilitarySupportForActivePlayerTurn?: boolean;
  /** TE The Fracture: set by phases/theFracture.ts's own setUpFractureOnEntry right when the Fracture comes into play, cleared once placeIngressTokens resolves the triggering player's own choice. synergyColors mirrors whatever that player's breakthrough synergy was AT THAT MOMENT (null if they have none), since that's what determines whether the 3-per-color or the 4-different-specialties path applies. */
  pendingFractureIngressChoice?: { playerId: PlayerId; synergyColors: [string, string] | null };

  /** Which strategy card ids are still unclaimed in the common play area this round, and trade goods sitting on them (RR 73.2). */
  unclaimedStrategyCards: { cardId: StrategyCardId; tradeGoods: number }[];
  /**
   * TE Thunder's Edge Expedition (rulebook p.9): the planet itself begins
   * the game off-board, on its own "expedition side" divided into 6
   * slices, each with a distinct cost. Any player, at the end of their
   * own turn, may claim ONE unclaimed slice by paying its cost — a
   * player can claim several across a game, but never the same slice
   * twice, and never re-claim one already taken by someone else. Their
   * FIRST ever claim grants their faction's breakthrough (see
   * rules/breakthroughs.ts's own grantBreakthrough). Once all 6 are
   * claimed, the expedition is complete, and phases/expedition.ts's own
   * completion logic takes over (flip to planet side, place it,
   * determine how much infantry goes on it).
   */
  thunderEdgeExpedition: {
    slicesClaimedBy: Partial<Record<ThunderEdgeExpeditionSliceCost, PlayerId>>;
    /** Set once the 6th slice is claimed and the completion logic (flip + place + infantry) has fully resolved — after which no further claims are possible (there's nothing left to claim). */
    completed: boolean;
  };
  /** RR "Public Disgrace": which card the most recent CHOOSE_STRATEGY_CARD pick actually resolved to — read by playPublicDisgrace to know what to undo. Only meaningful while a "strategy_card_chosen" priority window is open; never read otherwise. */
  lastStrategyCardChoice?: { playerId: PlayerId; cardId: StrategyCardId; tradeGoodsGained: number };
  /** RR "Diplomatic Pressure" (yjmrobert.com/tirules/components/c_action_cards): "A player cannot play a second Diplomatic Pressure targeting the SAME player during the SAME agenda" — {casterId, targetPlayerId} pairs already used this agenda; reset every time a new agenda is revealed. */
  diplomaticPressureUsedThisAgenda?: { casterId: PlayerId; targetPlayerId: PlayerId }[];

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
  /** RR 35.7/35.7a: cards WITHOUT an attach/relic-fragment/keepInPlayArea effect (i.e. a plain one-time effect, per this project's own scope note on those) go here once consumed — reshuffled into a fresh deck of the matching type if that deck is ever drawn from while empty. Attach/relic-fragment/keepInPlayArea cards never enter here at all — they stay with the planet/player instead, same as the real cards would. */
  explorationDiscardPiles?: {
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
  /** Sardakk N'orr "T'ro" (agent): "At the end of a player's tactical action" — set by phases/production.ts's own finishTacticalAction every time, regardless of faction, so useTro (rules/sardakk.ts) has something concrete to validate against. */
  lastCompletedTacticalAction?: { playerId: PlayerId; systemId: SystemId };
  /** Active agenda vote in progress, if any. */
  pendingAgendaVote: PendingAgendaVote | null;
  /**
   * RR 1.19/1.20: the generic "who gets asked, in what order, right now"
   * mechanism for any timing window where 2+ players could each want to
   * resolve a when/after/at-the-start/at-the-end ability — action card,
   * faction ability, relic, or leader alike; `kind` identifies the game
   * MOMENT (an agenda revealed, a combat round starting, ...), never
   * what's resolving. The engine NEVER decides on a player's behalf —
   * while this is non-null, normal game flow (voting, rolling combat
   * dice, bombarding, ...) is BLOCKED until every player in `order` has
   * consecutively passed. See rules/priorityWindow.ts for how this gets
   * opened/advanced/closed, and that file's own header comment for
   * exactly which of this project's reactive abilities go through this
   * vs. don't need to (an ability whose own timing window is inherently
   * single-actor — e.g. "after YOU activate a system", which only ever
   * means the ability owner's own activation — has no one else to ask,
   * so it doesn't open one of these), plus how a not-yet-built faction/
   * relic/leader ability plugs into an EXISTING `kind` or adds a new one.
   */
  pendingPriorityWindow: PendingPriorityWindow | null;
  /** One-shot marker for RR "Political Stability"'s own status->strategy-phase transition window (phases/actionPhase.ts's own autoAdvancePhase) — set true once that window has run its course for the CURRENT status phase, reset (implicitly, by simply not being copied forward) the next time startNewRound actually runs. */
  statusPhaseStrategyReturnWindowDone?: boolean;
  /** Same one-shot-per-round shape as statusPhaseStrategyReturnWindowDone above, but for RR "Ancient Burial Sites"'s own "at the start of the agenda phase" window (phases/actionPhase.ts's own autoAdvancePhase) — reset every time startNewRound actually runs. */
  agendaPhaseStartWindowDone?: boolean;
  /** Same one-shot shape, scoped to a single agenda's own resolution (reset the moment the NEXT agenda is revealed, or a new round begins) — RR "Confusing/Confounding Legal Text"'s own "elected_as_outcome" window, see finalizeAgendaResolution's own doc comment on its timing. */
  electedOutcomeWindowDone?: boolean;
  /** Same one-shot shape, scoped to a single agenda resolution's own RR "Deadly Plot" window — set true the moment the window opens (not just once closed), so a re-entrant resolveAgendaVote call (GameEngine.ts's own window-close handling) proceeds straight past it instead of re-opening. Cleared again once finalizeAgendaResolutionWithPredictions actually runs. */
  outcomeWouldBeResolvedWindowDone?: boolean;
  /** Same one-shot-continuation idea as the agenda-phase markers above, but for RR "Infiltrate"/"Reparations"' own "planet_control_gained" window — 2 different call sites (phases/invasion.ts's own commitGroundForces uncontested-landing branch, and wrapUpGroundCombat) open it, each needing a DIFFERENT continuation once it closes, so GameEngine.ts's own window-close handling reads this to know which. */
  pendingPlanetControlGainedContinuation?: "check_ground_forces_committed" | "ground_combat_wrap_up";
  /**
   * RR (yjmrobert.com/tirules/rules/r_action_cards, confirmed via the
   * Xxcha Kingdom's own Instinct Training rules): a player playing ANY
   * action card must announce its targets/variable-cost BEFORE Sabotage
   * (or a Sabotage-like cancel effect) may be played — dice are rolled,
   * technology choices are revealed, etc. only after every other eligible
   * player has declined that chance. This holds the ANNOUNCED action
   * (untyped here — GameState.ts can't import GameAction without creating
   * a circular import with types/Actions.ts, which already imports FROM
   * this file for AgendaPredictionReward; GameEngine.ts casts it back to
   * GameAction, since that file already imports both) while the
   * "action_card_announced" priority window (opened at the same time,
   * see rules/priorityWindow.ts) runs its course. Once that window fully
   * closes with no cancellation, GameEngine.ts dispatches this SAME
   * stored action to its real handler for the first time — nothing
   * (hand removal, cost payment, effect) happens at announce time itself.
   */
  pendingActionCardAnnouncement?: { playerId: PlayerId; cardId: ActionCardId; action: unknown };
  /** RR "Coup d'Etat": the same announce-then-window shape as pendingActionCardAnnouncement above, but for RESOLVE_STRATEGY_PRIMARY specifically (GameEngine.ts's own applyAction intercepts it the same way) — opens the "strategic_action_start" priority window before a strategic action actually resolves, so Coup d'Etat can cancel it outright (ending that player's turn, no exhaustion) instead of only ever being able to react to already-resolved effects. */
  pendingStrategicActionAnnouncement?: { playerId: PlayerId; action: unknown };
  /**
   * A card can be announced WHILE another priority window is already open
   * (e.g. a rider during "agenda_revealed", or Morale Boost during
   * "combat_round_start") — this stashes that OUTER window here for the
   * duration of the resulting "action_card_announced" one, then restores
   * it once that inner window closes (whether the card resolved or got
   * Sabotaged), so the outer window's own round-robin picks up exactly
   * where it left off. Deliberately only 1 level deep: announcing a
   * second card (e.g. Sabotage targeting a Sabotage) while one is already
   * pending here is refused outright rather than silently attempting
   * arbitrary-depth nesting — an extremely rare edge case, flagged rather
   * than guessed at.
   */
  stashedPriorityWindow?: PendingPriorityWindow | null;
  /** RR 8: exactly 2 agendas get resolved per agenda phase (fewer if the deck runs out). Reset to 0 when the agenda phase begins. */
  agendaPhaseAgendasResolved?: number;
  /** RR "Public Execution": the elected player cannot vote on any agendas for the REST of the current agenda phase (not future ones) — reset alongside agendaPhaseAgendasResolved whenever a fresh agenda phase begins. Checked when building each new agenda's voting order (see phases/agendaPhase.ts's revealAgenda). */
  agendaPhaseBannedFromVoting?: PlayerId[];
  /**
   * RR "Colonial Redistribution": the CONTROLLER's own choice of which
   * fewest-VP player gets the infantry offer below — only set when 2+
   * players are tied for fewest VP (a single lowest-VP player skips
   * straight to pendingColonialRedistributionInfantryOffer instead, since
   * there's no real choice to make there).
   */
  pendingColonialRedistributionChoice?: { planetId: PlanetId; controllerId: PlayerId; candidateIds: PlayerId[] };
  /** RR "Colonial Redistribution": the chosen player's own optional choice of whether to place 1 infantry (from reinforcements) on the elected planet. */
  pendingColonialRedistributionInfantryOffer?: { planetId: PlanetId; playerId: PlayerId };
  /** RR "Research Grant Reallocation": the elected player's own choice of which technology to gain (no prerequisite check — this grant bypasses RR 90.7 entirely, per the card's own "any 1 technology of their choice" text). */
  pendingResearchGrantReallocationChoice?: PlayerId;
  /** RR "Ixthian Artifact" ("for"): true while waiting on the speaker's own die roll (trusted-RNG, same convention as combat dice elsewhere — see USE_IXTHIAN_ARTIFACT_DIE_ROLL). */
  pendingIxthianArtifactDieRoll?: boolean;
  /** RR "Ixthian Artifact" (die roll 6-10): each non-eliminated player may research up to this many technologies (starts at 2 each) — free research, no resource cost, same convention as this card's own "may research" text (no cost specified). */
  pendingIxthianArtifactResearch?: Partial<Record<PlayerId, number>>;
  /** RR "Wormhole Research" ("for"): players with 1+ ships in a wormhole system who still have their own optional (free) research decision pending. */
  pendingWormholeResearchOffer?: PlayerId[];
  /** RR "Galactic Crisis Pact": every non-eliminated player's own optional, free (no strategy-token cost) chance to use the elected strategy card's secondary — cleared per-player as each uses or declines it. */
  pendingGalacticCrisisPactOffer?: { cardId: StrategyCardId; playersRemaining: PlayerId[] };
  /** RR 45.4/61.21: players currently over the 3-total-secret-objectives limit (unscored + scored combined) who owe their own choice of which UNSCORED one to return to the deck. See phases/agendaEffects.ts's maybeQueueSecretObjectiveLimit/returnSecretObjective. */
  pendingSecretObjectiveReturn?: PlayerId[];
  /** RR 83.4/82.1a: which players have already resolved a given strategy card's SECONDARY ability this round — a player can only do so once per card per round, regardless of how many times they'd otherwise be offered the chance. Reset (all cards) whenever a new round starts. */
  strategyCardSecondariesUsedBy?: Partial<Record<StrategyCardId, PlayerId[]>>;
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
  /** TE "Crisis": the specific player whose UPCOMING turn should be skipped once — checked (and cleared) by phases/actionPhase.ts's own advanceActivePlayer the next time it computes who's up next. Deliberately NOT the same as hasPassed (a passed player never acts again this round at all; this is a one-time skip of whoever's turn would be next, who can still act on their OWN later turn if the action phase continues that far). */
  skipNextTurnForPlayerId?: PlayerId;
  /** TE "Extreme Duress": set when played during the turn_start window (advanceActivePlayer's own doc comment above) — checked by GameEngine.ts's own post-dispatch logic against the ARMED player's very next action; if it's anything other than RESOLVE_STRATEGY_PRIMARY, the punishment fires and this is cleared either way. */
  pendingExtremeDuress?: { armedPlayerId: PlayerId; casterId: PlayerId };
  /** TE "Puppets on a String" (yjmrobert.com/tirules/components/c_action_cards): "The active player cannot use the Fleet Logistics technology to perform an additional action [during this granted turn]... they may use the Master Plan action card or the Minister of War agenda to perform additional actions [instead]." Set true only while this player's own Puppets-granted bonus action is in progress; checked (and skipped past) by maybeAdvanceActivePlayer's own Fleet Logistics check specifically — Master Plan's own bonus isn't affected. */
  puppetsOnAStringActive?: boolean;
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
   * RR "Committee Formation": confirmed, this check happens BEFORE any
   * vote opens on an agenda whose own outcome elects a player — if
   * someone currently owns Committee Formation, THEY get first refusal:
   * discard it to directly pick the elected player (no vote at all for
   * this agenda), or decline and let the normal vote proceed as usual.
   * Set by revealAgenda instead of immediately opening pendingAgendaVote;
   * cleared (one way or the other) by USE_COMMITTEE_FORMATION or
   * SKIP_COMMITTEE_FORMATION — see phases/agendaEffects.ts.
   */
  pendingCommitteeFormationDecision?: { agendaId: AgendaId; ownerId: PlayerId };
  /**
   * RR "Homeland Defense Act" ("against"): players who still owe
   * destroying 1 of their own PDS units — a real choice of WHICH one (they
   * may have PDS on more than one planet), same "player picks" pattern as
   * everywhere else in this project. See phases/agendaEffects.ts.
   */
  pendingHomelandDefenseActDestruction?: PlayerId[];
  /**
   * RR "Executive Sanctions" ("against"): players who still owe discarding
   * 1 random action card — the RANDOMNESS itself is resolved by whichever
   * trusted context applies the action (same convention as pre-rolled
   * dice elsewhere in this project: the client can guess locally for an
   * instant animation, but the Edge Function's own random pick is what
   * actually gets persisted), not a genuine player choice, so this still
   * needs its own pending+action pair even though nobody's really
   * "deciding" anything. See phases/agendaEffects.ts.
   */
  pendingExecutiveSanctionsRandomDiscard?: PlayerId[];
  /**
   * RR "Representative Government" (either version, "against"): players
   * who voted "against" and so owe exhausting ALL of their cultural
   * planets — accumulates across however many agendas trigger it in the
   * same agenda phase, applied automatically (no player choice needed,
   * it's unconditionally "all" of them) right when the next strategy
   * phase actually starts — see phases/actionPhase.ts's startNewRound.
   */
  pendingRepresentativeGovernmentAgainstVoters?: PlayerId[];
  /**
   * RR "Arms Reduction" ("against"): a flat flag (not per-player — this
   * applies to EVERY player unconditionally, unlike Representative
   * Government's own voter-scoped list above) — at the start of the next
   * strategy phase, every player exhausts each of their planets that has a
   * technology specialty. See phases/actionPhase.ts's startNewRound.
   */
  pendingArmsReductionExhaustTechSpecialty?: boolean;
  /**
   * RR "New Constitution" ("for"): same shape as Arms Reduction's own flag
   * above — every player exhausts each planet in their OWN home system, at
   * the start of the next strategy phase.
   */
  pendingNewConstitutionExhaustHomeSystem?: boolean;
  /**
   * RR 20/70.5: confirmed — whenever a player gains a NEW command token
   * from any source (RR 70.5's status-phase gain is the only source this
   * engine currently implements, but there are several others in the
   * full game), the PLAYER decides which of their 3 pools it goes into,
   * it's never auto-assigned. This tracks how many still-unplaced tokens
   * each player owes from whatever they most recently gained — see
   * rules/commandTokens.ts's placeGainedCommandTokens (the shared
   * validate+place logic, including RR "Fleet Regulations"'s own fleet-
   * pool cap when active) and PLACE_GAINED_COMMAND_TOKENS. Blocks the
   * status phase from finishing until every listed player has placed
   * theirs — see phases/actionPhase.ts's autoAdvancePhase.
   */
  pendingCommandTokenGains?: Partial<Record<PlayerId, number>>;
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
  /** "Intercept": this player cannot retreat for the rest of this space combat round — checked by phases/spaceCombat.ts's own announceRetreat. */
  interceptedPlayerId?: PlayerId;
  /** "Waylay": this player's own Anti-Fighter Barrage hits can be assigned against ANY of the opponent's ships this round, not just fighters (phases/spaceCombat.ts's own assignAntiFighterBarrageHits). */
  waylayPlayerId?: PlayerId;
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
  /** TE DUAL PLANET TRAITS (rulebook p.11): banks the committing player's own chosenTrait from COMMIT_GROUND_FORCES for a CONTESTED planet — control (and RR 25.1c's own automatic exploration) isn't actually established until combat concludes, potentially several rounds later, but the player already specified which trait they want right when they first committed, so there's no need to ask again at combat's end. Keyed by planetId since a player could be contesting more than one planet across the same invasion step. */
  dualTraitChoices?: Partial<Record<PlanetId, "cultural" | "industrial" | "hazardous">>;
  /** Same "banked now, consumed once control is actually established later" shape as dualTraitChoices above — a player's own exploration-card choice for whatever card gets drawn once this contested planet's combat concludes (see phases/exploration.ts's own ExplorationCardChoice). */
  pendingExplorationChoices?: Partial<Record<PlanetId, import("../phases/exploration").ExplorationCardChoice>>;
  /** Arborec "Duha Menaimon" (flagship): true only if the flagship was actually present in this system at the moment it was activated — see phases/tacticalAction.ts's own activateSystem and rules/arborec.ts's own useDuhaMenaimonProduction. */
  duhaMenaimonPresentAtActivation?: boolean;
  /**
   * TE COEXIST (yjmrobert.com/tirules/rules/r_coexistence): the exact 2
   * players actively fighting the CURRENT ground combat on
   * currentInvasionPlanetId — distinct from "everyone with ground forces
   * on that planet" (playersWithGroundForces), since a 3rd (or more)
   * coexisting party can be present on the SAME planet without being
   * part of THIS specific fight. Set whenever a ground combat actually
   * starts (startGroundCombat, initiateCoexistCombat); every combat-
   * resolution function (buildGroundCombatEntries, wrapUpGroundCombat,
   * the sole-survivor check) reads this pair instead of re-deriving
   * combatants from scratch, so bystanders are never pulled in.
   */
  groundCombatParticipantIds?: [PlayerId, PlayerId];
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
   * RR "action card" temporary modifiers scoped to THIS tactical action
   * (cleared for free the moment `pendingTacticalAction` itself resets to
   * null at the end of the action — none of these need their own
   * explicit cleanup). Each is a single named field, same "no generic
   * pluggable system" convention this interface already uses everywhere
   * else (predictiveIntelligenceBonusUsedBy, crownOfThalnosPendingPlayers,
   * ...) rather than a generic modifiers list.
   */
  /** "Flank Speed": +1 move value for every one of this player's ships during this tactical action's movement step (phases/tacticalAction.ts's own moveShips). */
  flankSpeedPlayerId?: PlayerId;
  /** "In the Silence of Space": this player's ships whose move originates from this specific system can pass through systems containing other players' ships for the rest of this tactical action (rules/movement.ts's own canShipReachSystem, same `ignoreEnemyFleets` flag Light Wave Deflector already uses — just scoped to 1 origin system instead of unconditional). */
  passThroughEnemiesFromSystemId?: SystemId;
  /** "Lost Star Chart": alpha and beta wormhole systems count as adjacent to each other for the rest of this tactical action (rules/adjacency.ts's own getAdjacentSystems). */
  lostStarChartActive?: boolean;
  /** "Solar Flare": no other player may use Space Cannon against this player's ships for the rest of this tactical action's movement (rules/combat.ts's own getSpaceCannonOffenseEligiblePlayers) — does NOT stop this player's own Space Cannon Offense against someone else. */
  solarFlarePlayerId?: PlayerId;
  /** "Nav Suite": ignore anomaly effects entirely (asteroid field/supernova blocking, nebula's move-value clamp) for the rest of this tactical action's movement step (rules/movement.ts's own canShipReachSystem). */
  navSuiteActive?: boolean;
  /** "Morale Boost": +1 to the result of every one of this player's combat rolls — expressed as -1 to hitOn, same convention as every other die modifier in rules/combat.ts. Self-expiring by design: only checked when `round` matches the CURRENT `combatRound` above, so it never needs an explicit clear step once that round ends. */
  moraleBoost?: { playerId: PlayerId; round: number };
  /** "Fighter Prototype": +2 to the result of this player's fighter combat rolls, round 1 of a space combat only (rules/combat.ts's own getFighterPrototypeHitOnBonus explicitly checks combatRound === 1, since this same window reopens for round 2+ too). */
  fighterPrototypePlayerId?: PlayerId;
  /** "Bunker": -4 to the result of enemy Bombardment rolls against planets this player controls, for the rest of this invasion (phases/invasion.ts's own bombard/buildBombardmentEntries) — expressed as +4 to hitOn. */
  bunkerPlayerId?: PlayerId;
  /** "Blitz": every one of this player's non-fighter ships in the active system that doesn't already have Bombardment gains Bombardment 6 (1 die) for the rest of this invasion (rules/combat.ts's own buildBombardmentEntries). */
  blitzPlayerId?: PlayerId;
  /** "Disable": this player's opponents' PDS units in the active system lose Planetary Shield (phases/invasion.ts's own bombard) and Space Cannon (rules/combat.ts's own buildSpaceCannonDefenseEntries) for the rest of the invasion. */
  disablePlayerId?: PlayerId;
  /** RR "Parley": once this returns a player's committed units to space, "the returned ground forces cannot be committed to another planet during the same tactical action" — tracked here, checked by commitGroundForces. */
  parleyBlockedPlayerIds?: PlayerId[];
  /** Set true the first time EITHER phases/invasion.ts's own bombard or commitGroundForces actually runs this invasion step (regardless of whether bombardment scored any hits — a miss leaves no other trace in this interface at all, so this can't be inferred from pendingHits/currentInvasionPlanetId being unset). Exists ONLY so PLAY_BUNKER/PLAY_BLITZ can enforce their own "at the start of an invasion" timing precisely instead of the fragile "nothing else happens to be pending right now" proxy this file used before — with multiple contested planets in 1 invasion step, that proxy could let either card be played after a DIFFERENT planet's bombardment already happened. */
  invasionStepStarted?: boolean;
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
  /** Letnev "Dunlain Reaper" (mech, DEPLOY): "once per timing window" — resets at the start of each new ground combat round (rules/letnev.ts's own useDunlainReaperDeploy). */
  usedDunlainReaperDeployThisRound?: boolean;
  /** Sardakk N'orr "Tekklar Legion" (promissory note): "At the start of an invasion combat" — played once for the whole invasion (not per-round, unlike most other reroll/bonus abilities here), applying its +1/-1 to every round of THIS ground combat. Set once, at round 1, by rules/sardakk.ts's own useTekklarLegion. */
  tekklarLegionHolderIdThisCombat?: PlayerId;
  /** Sardakk N'orr "Sh'val, Harbinger — TEKKLAR CONDITIONING" (hero): set once used, right after movement — skips Space Cannon Offense/Space Combat/Bombardment entirely, straight to Commit Ground Forces. Purge + return-ships-to-reinforcements happens once commits finish (phases/invasion.ts's own finishInvasionCommits). */
  shvalHarbingerActive?: boolean;
  /** Jol-Nar "Spatial Conduit Cylinder" (faction tech): set once used, for the rest of THIS system activation only — see rules/adjacency.ts's own getAdjacentSystems. */
  spatialConduitCylinderActive?: { playerId: PlayerId; systemId: SystemId };
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
  /**
   * RR "The Crown of Thalnos": which combatant(s) still owe this decision
   * for the round that JUST resolved — the owner's own choice of how many
   * dice, PER UNIT TYPE they own in this fight, to reroll (only from among
   * that type's own MISSED dice this round — see
   * rules/combat.ts's CombatRoundResult.missedDiceByPlayerAndType, snapshotted
   * here the moment the round resolves). Whichever of the new rolls still
   * miss destroys that many units of that type — mandatory, but the
   * PLAYER decides how many (if any) of each type to even attempt,
   * per the confirmed example: 5 cruisers all miss, owner rerolls only 2,
   * only those 2 are ever at risk. Cleared (all types) once the owner
   * either uses or explicitly skips it for this round — doesn't block
   * `pendingHits` from being assigned in parallel, since this only ever
   * affects the OWNER's own units, never the opponent's.
   */
  crownOfThalnosPendingPlayers?: PlayerId[];
  crownOfThalnosMissedDiceByPlayer?: Partial<Record<PlayerId, Partial<Record<UnitType, number>>>>;
  /** Letnev "Munitions Reserves" (faction ability, SPACE combat only — unlike Crown of Thalnos, which applies to any combat round): same missed-dice-count tracking, but requires actually spending 2 trade goods (not free) and can only be used once per round. Tracked here (not reusing crownOfThalnosMissedDiceByPlayer directly) since eligibility/cost differ even though the underlying reroll mechanic is identical. */
  munitionsReservesMissedDiceByPlayer?: Partial<Record<PlayerId, Partial<Record<UnitType, number>>>>;
  usedMunitionsReservesThisRound?: boolean;
  /** Letnev "War Funding"/"War Funding Ω" (promissory notes): "cannot play it again until the next round of combat" — tracked per-holder (not a flat boolean, since different players could hold/play it across different rounds), reset each new space combat round. */
  usedWarFundingThisRoundBy?: PlayerId;
  /**
   * RR 16.3/78.10a: right when space combat ends, if the WINNER's
   * fighters + ground forces sitting in the system's space area now
   * exceed the combined capacity of their OWN surviving ships there
   * (some of which may have just been destroyed this combat, reducing
   * available capacity below what was already parked there), they must
   * choose which excess units to remove — blocks the transition to the
   * "invasion" step until resolved, same "gate before advancing" pattern
   * as this project's other pending player-choice fields.
   */
  pendingCapacityOverflow?: { playerId: PlayerId; excessCount: number };
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
  /**
   * The 8 "rider" action cards (Imperial/Leadership/... Rider) plus any
   * future card sharing the same "predict aloud, can't vote, reward if
   * right" shape (RR/PoK political cards) — checked once against `winner`
   * in phases/actionCardEffects.ts's own applyAgendaPredictionRewards,
   * called from agendaPhase.ts's resolveAgendaVote right before it hands
   * off to finalizeAgendaResolution. The predicting player is ALSO
   * removed from `votingOrder` above at submission time (phases/
   * actionCardEffects.ts's own submitRiderPrediction) — same mechanism
   * PLAY_ASSASSINATE_REPRESENTATIVE's plain "can't vote" effect uses,
   * just with a reward attached.
   */
  predictions?: { playerId: PlayerId; cardId: ActionCardId; predictedOutcome: string; reward: AgendaPredictionReward }[];
}

/**
 * RR 1.19 (action phase) / RR 1.20 (strategy/agenda phase): the generic
 * round-robin priority mechanism — each player in `order`, starting from
 * `currentIndex`, gets asked in turn whether they want to resolve a
 * when/after/at-the-start/at-the-end ability. Whoever's turn it currently
 * is, is `order[currentIndex]`. Playing something resets
 * `consecutivePasses` to 0 and moves `currentIndex` to the player AFTER
 * the one who just acted (the rotation continues from there, it doesn't
 * restart) — see rules/priorityWindow.ts's own advanceAfterAction. PASS_
 * PRIORITY increments `consecutivePasses` and moves to the next player;
 * once `consecutivePasses` reaches `order.length` (everyone in a row
 * declined), the window is fully closed and normal game flow resumes.
 */
export interface PendingPriorityWindow {
  /** Which trigger this window is for — NOT which specific cards are legal (each PLAY_<CARD> function still validates its own full legality against the rest of GameState); only used to gate normal flow and to compute what `order` meant when the window opened. */
  kind:
    | "agenda_revealed"
    | "combat_round_start"
    | "invasion_start"
    | "system_activated"
    | "after_system_activated"
    | "action_card_announced"
    | "strategy_phase_start"
    | "strategy_card_chosen"
    | "status_phase_strategy_card_return"
    | "strategic_action_start"
    | "agenda_phase_start"
    | "after_speaker_votes"
    | "elected_as_outcome"
    | "after_you_cast_votes"
    | "outcome_would_be_resolved"
    | "planet_control_gained"
    | "ground_forces_committed"
    | "after_another_player_activates_system"
    | "space_combat_won"
    | "end_of_turn"
    | "after_ships_moved_in"
    | "after_transaction_resolved"
    | "last_ship_destroyed"
    | "turn_start";
  order: PlayerId[];
  currentIndex: number;
  consecutivePasses: number;
}

/** Reward payloads for the 8 rider cards (see PendingAgendaVote.predictions above) — the specific choice each reward needs (which planet, which system, which tech, ...) is captured at PLAY time since applying it later, at agenda resolution, happens with no further interactive input in this engine's model. */
export type AgendaPredictionReward =
  | { kind: "victory_point" } // RR "Imperial Rider"
  | { kind: "trade_goods" } // RR "Trade Rider": flat 5, no extra param
  | { kind: "command_tokens"; tactic: number; fleet: number; strategy: number } // RR "Leadership Rider": must sum to 3
  | { kind: "space_dock"; planetId: PlanetId } // RR "Construction Rider"
  | { kind: "command_token_to_others"; systemId: SystemId } // RR "Diplomacy Rider"
  | { kind: "action_cards_and_speaker" } // RR "Politics Rider": draw 3 + gain speaker token
  | { kind: "technology"; techId: TechId; exhaustPlanetIdsForTechSpecialty?: PlanetId[] } // RR "Technology Rider"
  | { kind: "dreadnought"; systemId: SystemId } // RR "Warfare Rider"
  | { kind: "sanction" }; // RR "Sanction": no reward for the predictor themselves — see its own doc comment in actionCardEffects.ts
