import {
  ActionCardId,
  AgendaId,
  ObjectiveId,
  PlanetId,
  PlayerId,
  PromissoryNoteId,
  StrategyCardId,
  SystemId,
  TechId,
  UnitUpgradeId,
} from "./ids";
import { UnitType, ObjectiveKind } from "./enums";

/**
 * Every action a player (or the "bot"/engine acting on a timer, e.g. an
 * auto-pass) can submit. This is intentionally one big union rather than
 * per-phase unions: async play means a client might submit a
 * PRODUCE_UNITS action while another player's agenda vote is technically
 * still resolving (RR 8.5 transactions can happen anytime), so the engine
 * needs one entry point that can reject anything illegal for the *current*
 * state rather than relying on the UI to only ever offer phase-appropriate
 * actions.
 *
 * Implemented in this first pass (see phases/): CHOOSE_STRATEGY_CARD, PASS,
 * ACTIVATE_SYSTEM, MOVE_SHIPS.
 * Everything else is typed now so the shape is locked in, and stubbed with
 * a NotImplementedError in GameEngine.ts — fill in one handler at a time
 * following the same pattern (see phases/README.md).
 */
export type GameAction =
  // --- Strategy phase (RR 73) ---
  | { type: "CHOOSE_STRATEGY_CARD"; playerId: PlayerId; cardId: StrategyCardId }

  // --- Action phase / turn structure (RR 3) ---
  | { type: "PASS"; playerId: PlayerId }

  // --- Tactical action (RR 78) ---
  | { type: "ACTIVATE_SYSTEM"; playerId: PlayerId; systemId: SystemId }
  | {
      type: "MOVE_SHIPS";
      playerId: PlayerId;
      /** One entry per origin system a ship is moving from; ships not listed stay put. */
      moves: {
        fromSystemId: SystemId;
        unitType: UnitType;
        count: number;
      }[];
      /** Ground forces picked up along the way per RR 84.1 — kept separate from ship moves because capacity is checked against these, not against ships. Must come from the same fromSystemId as one of the `moves` entries above (multi-hop pickup along the path isn't supported yet — flagged in moveShips). */
      transportedGroundForces?: { fromSystemId: SystemId; unitType: "infantry" | "mech"; count: number }[];
      transportedFighters?: { fromSystemId: SystemId; count: number }[];
      /** RR "Gravity Drive": exhaust that tech (if owned and readied) to apply +1 move value to ONE of the moves entries above (identified by its fromSystemId) for this tactical action only. */
      gravityDriveBoostFromSystemId?: SystemId;
    }
  | {
      type: "USE_SPACE_CANNON_OFFENSE";
      playerId: PlayerId;
      /** Pre-rolled dice, same trusted-RNG convention as RESOLVE_COMBAT_ROUND — see that action's doc comment. One dice-group per qualifying unit TYPE (not just PDS — some faction units carry Space Cannon too), each in the active system plus any range-upgraded (e.g. PDS II) in an adjacent system. RR 77. */
      diceRolls: number[];
      /** RR "Plasma Scoring": which of this player's qualifying unit types gets the +1 die — only matters if they own the tech and have 2+ types with different hitOn values. Ignored otherwise. */
      plasmaScoringUnitType?: UnitType;
    }
  | { type: "SKIP_SPACE_CANNON_OFFENSE"; playerId: PlayerId } // RR 77: this player declines to fire, even though they had qualifying units
  | {
      type: "ASSIGN_SPACE_CANNON_OFFENSE_HITS";
      playerId: PlayerId;
      /** Always the ACTIVE player (whoever's ships got shot at) — same destroy/flip-per-unit shape as ASSIGN_HITS. RR 77/76. */
      assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[];
    }
  | { type: "ANNOUNCE_RETREAT"; playerId: PlayerId; toSystemId: SystemId } // RR 67.4
  | {
      type: "USE_DURANIUM_ARMOR";
      playerId: PlayerId;
      /** RR "Duranium Armor": the player's own choice of WHICH Sustain-Damage unit type (already damaged before this round) to repair — only offered when they actually own the tech and have an eligible unit; see PendingTacticalAction.duraniumArmorPendingPlayers's own doc comment. */
      unitType: UnitType;
    }
  | { type: "SKIP_DURANIUM_ARMOR"; playerId: PlayerId } // declines the repair even though eligible
  | {
      type: "USE_ANTI_FIGHTER_BARRAGE";
      playerId: PlayerId;
      /** Same trusted-RNG convention as everywhere else. Mandatory (not skippable) for any combatant with an AFB-capable ship — RR 67.1. */
      diceRolls: number[];
    }
  | {
      type: "ASSIGN_ANTI_FIGHTER_BARRAGE_HITS";
      playerId: PlayerId;
      /** Same destroy/flip shape as ASSIGN_HITS, but every unitType here MUST be "fighter" — AFB can't hit anything else. RR 67.1/76. */
      assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[];
    }
  | {
      type: "RESOLVE_COMBAT_ROUND";
      playerId: PlayerId;
      /**
       * Pre-rolled 1-10 values, one per die, in a fixed order: iterate
       * playerIds as returned by playersWithShipsInSystem (seat order isn't
       * used here, just whatever that function returns), then that
       * player's UnitStacks in the order GameState.systems[...].
       * spaceUnitsByPlayer[...] happens to list them, `combatDiceCount`
       * dice per unit in the stack. The engine re-derives this same order
       * when checking length, so a mismatched count is rejected outright,
       * but a *correctly-sized* array in the wrong order would silently
       * mis-assign hits — this is why diceRolls always come from the
       * trusted Edge Function's own re-derivation of the entries, never
       * taken as-is from a client-submitted action. RR 67.5 / 38.1.
       */
      diceRolls: number[];
    }
  | {
      type: "ASSIGN_HITS";
      playerId: PlayerId;
      /**
       * One entry per hit owed (or per remaining unit, if hits exceed units
       * left — RR 67.6: excess hits beyond total units are simply lost).
       * The player chooses, per hit, which unit absorbs it and how:
       * "destroy" removes it outright; "flip" uses Sustain Damage instead
       * (only legal for a unit with that ability that isn't already
       * damaged). This is a real choice, not automatic — e.g. a player may
       * prefer to destroy a cheap fighter and leave an undamaged
       * Sustain-Damage dreadnought completely untouched (banking its flip
       * for a worse hit later) rather than flip it now. RR 67.6 / 38.2.
       */
      assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[];
    }
  | {
      type: "BOMBARD";
      playerId: PlayerId;
      targetPlanetId: PlanetId;
      /** Pre-rolled dice, same trusted-RNG convention as RESOLVE_COMBAT_ROUND — see that action's doc comment. Order: iterate the bombarding player's bombardment-capable ship stacks in the order they appear in the system's spaceUnitsByPlayer, abilityValues.bombardment.dice dice per unit in the stack. RR 44.1 / 15. */
      diceRolls: number[];
      /** RR "Plasma Scoring": which of this player's Bombardment-capable unit types gets the +1 die — the player's own choice, only relevant if they own the tech and have 2+ qualifying types with different hitOn values. Ignored otherwise. */
      plasmaScoringUnitType?: UnitType;
    }
  | {
      type: "ASSIGN_BOMBARDMENT_HITS";
      playerId: PlayerId;
      targetPlanetId: PlanetId;
      /** Same destroy/flip-per-unit shape as ASSIGN_HITS (ground forces have no Sustain Damage except Mechs) — RR 44.1 / 76. */
      assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[];
    }
  | {
      type: "COMMIT_GROUND_FORCES";
      playerId: PlayerId;
      targetPlanetId: PlanetId;
      units: { unitType: UnitType; count: number }[];
    } // RR 44.2: moves ground forces from the active system's space area onto a planet there.
  | { type: "FINISH_INVASION_COMMITS"; playerId: PlayerId } // RR 44.2: attacker signals no more planets will be invaded this tactical action.
  | {
      type: "START_GROUND_COMBAT";
      playerId: PlayerId;
      targetPlanetId: PlanetId;
      /** RR 44.4: the active player picks which contested planet resolves next, each time — independent of commit order, and independent of any previous pick. */
    }
  | {
      type: "USE_SPACE_CANNON_DEFENSE";
      playerId: PlayerId;
      /** Same trusted-RNG convention as everywhere else. This is the DEFENDER's own optional choice — RR 44's Space Cannon Defense, fired at the attacker's just-committed ground forces on this planet, before ground combat starts. */
      diceRolls: number[];
      /** RR "Plasma Scoring": which of the defender's qualifying unit types gets the +1 die — see USE_SPACE_CANNON_OFFENSE's own note. */
      plasmaScoringUnitType?: UnitType;
    }
  | { type: "SKIP_SPACE_CANNON_DEFENSE"; playerId: PlayerId } // RR 44: the defender declines to use it, even though they had qualifying units
  | {
      type: "ASSIGN_SPACE_CANNON_DEFENSE_HITS";
      playerId: PlayerId;
      /** Always the ATTACKER (whoever's ground forces got shot at) — same destroy/flip-per-unit shape as ASSIGN_HITS. RR 44/76. */
      assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[];
    }
  | {
      type: "PRODUCE_UNITS";
      playerId: PlayerId;
      planetId: PlanetId;
      units: { unitType: UnitType; count: number }[];
      /** RR "AI Development Algorithm"'s OTHER ability (distinct from its unit-upgrade-research one, but shares the same exhausted state): exhaust to reduce this production's combined cost by the number of unit upgrade technologies this player owns. */
      useAiDevelopmentAlgorithmForCost?: boolean;
    }
  | { type: "FINISH_TACTICAL_ACTION"; playerId: PlayerId } // RR 78: ends the tactical action (only legal once step reaches "production"), advancing the turn to the next player — nothing cleared pendingTacticalAction before this existed, so no one could ever PASS again after their first tactical action.

  // --- Strategy card primary/secondary abilities (RR 71) ---
  | { type: "RESOLVE_STRATEGY_PRIMARY"; playerId: PlayerId; cardId: StrategyCardId; payload: unknown } // TODO, one payload shape per card
  | { type: "RESOLVE_STRATEGY_SECONDARY"; playerId: PlayerId; cardId: StrategyCardId; payload: unknown } // TODO

  // --- Component actions (RR 21) ---
  | {
      type: "PLAY_ACTION_CARD";
      playerId: PlayerId;
      cardId: ActionCardId;
      /** Reserved for future per-card choices (targets, etc.) once individual card effects are implemented — unused for now. See phases/actionCards.ts's own note on what this action does and doesn't do yet. */
      payload?: unknown;
    }
  | {
      type: "DISCARD_ACTION_CARD";
      playerId: PlayerId;
      cardId: ActionCardId;
      /** RR 2.4-adjacent: voluntary discard — hand-limit compliance, or discarding for its own sake (e.g. the "discard N action cards" secret objective). Distinct from PLAY_ACTION_CARD's own discard-after-use, which does NOT count toward that objective's tally (see Player.actionCardsDiscardedCount's own doc comment). */
    }
  | {
      type: "RESEARCH_TECHNOLOGY";
      playerId: PlayerId;
      techId: TechId;
      /** How this specific research is being paid for — 0/empty for a source that grants it free (e.g. some faction abilities); nonzero needs enough resources from the exhausted planets (falls back to trade goods for any shortfall). RR 90.7 prerequisites are always checked regardless of cost. */
      cost: number;
      exhaustPlanetIdsForResources: PlanetId[];
    } // RR 90
  | {
      type: "RESEARCH_UNIT_UPGRADE";
      playerId: PlayerId;
      upgradeId: UnitUpgradeId;
      cost: number;
      exhaustPlanetIdsForResources: PlanetId[];
      /** RR "AI Development Algorithm": exhaust that tech (if owned and readied) to ignore exactly ONE instance of this one color's prerequisite for this research (e.g. a "2 red" requirement becomes "1 red") — not the whole prerequisite list. */
      aiDevelopmentAlgorithmIgnoreColor?: string;
    } // RR 90/86
  | { type: "EXPLORE_PLANET"; playerId: PlayerId; planetId: PlanetId } // RR 35 — PoK only (rejected in Base-only games)
  | { type: "EXPLORE_FRONTIER"; playerId: PlayerId; systemId: SystemId } // RR 35 — PoK only
  | {
      type: "PURGE_RELIC_FRAGMENTS";
      playerId: PlayerId;
      fragmentType: "cultural" | "industrial" | "hazardous";
      useCount: number;
      useUnknownCount: number;
    } // RR 35.9 — PoK only

  // --- Standalone technology abilities (see phases/technologyAbilities.ts's own header note on why these are separate actions rather than modifiers on an existing one) ---
  | { type: "USE_SELF_ASSEMBLY_ROUTINES"; playerId: PlayerId; planetId: PlanetId } // exhausts the tech; +1 free mech on a planet where this player already has one
  | { type: "USE_DACXIVE_ANIMATORS"; playerId: PlayerId; planetId: PlanetId } // not exhaustable; +1 free infantry after winning ground combat there this tactical action
  | { type: "USE_INTEGRATED_ECONOMY"; playerId: PlayerId; planetId: PlanetId; units: { unitType: UnitType; count: number }[] } // not exhaustable; free production up to the planet's resource value, after gaining control of it this tactical action
  | { type: "USE_X89_BACTERIAL_WEAPON"; playerId: PlayerId; targetPlanetId: PlanetId } // component action (uses this player's whole turn); exhausts the tech
  | { type: "USE_PSYCHOARCHAEOLOGY"; playerId: PlayerId; planetId: PlanetId } // exhausts the PLANET (not this tech) for 1 trade good
  | {
      type: "USE_SLING_RELAY";
      playerId: PlayerId;
      systemId: SystemId;
      planetId: PlanetId;
      unitType: UnitType;
      count: number;
    } // component action (uses this player's whole turn); exhausts the tech; produce 1 ship in any system with this player's own space dock, paying its normal cost against that dock's Production limit
  | { type: "USE_SCANLINK_DRONE_NETWORK"; playerId: PlayerId; planetId: PlanetId } // not exhaustable; explores a planet in the just-activated system that has this player's own units on it

  // --- Transactions (RR 83) ---
  | {
      type: "PROPOSE_TRANSACTION";
      playerId: PlayerId;
      withPlayerId: PlayerId;
      offer: { tradeGoods: number; commodities: number; promissoryNoteId?: PromissoryNoteId };
      request: { tradeGoods: number; commodities: number; promissoryNoteId?: PromissoryNoteId };
    } // TODO — binding immediately since both sides confirm client-side before submitting

  // --- Status phase (RR 70) — mostly automatic, but objective scoring is a player choice ---
  | {
      type: "SCORE_OBJECTIVE";
      playerId: PlayerId;
      objectiveId: ObjectiveId;
      /**
       * Only for "spend X" objectives (RR: this spending happens as part of
       * claiming the objective during the status phase, not tracked
       * historically through the round — see data/objectives.json's rules
       * note). Ignored for every other checkType.
       */
      spend?: {
        exhaustPlanetIdsForResources?: PlanetId[];
        exhaustPlanetIdsForInfluence?: PlanetId[];
        tradeGoods?: number;
        commandTokens?: { tactic?: number; strategy?: number };
        /** RR "Destroy Heretical Works": purge 2 relic fragments of any type/mix — separate from PURGE_RELIC_FRAGMENTS's own 3-for-1 exchange, this doesn't grant a relic. */
        relicFragments?: { cultural?: number; industrial?: number; hazardous?: number; unknown?: number };
      };
    } // RR 52/70.1
  | { type: "FINISH_STATUS_PHASE_SCORING"; playerId: PlayerId } // RR 70.1: player signals done scoring (0, 1, or 2 objectives) for this status phase

  // --- Agenda phase (RR 8) ---
  | {
      type: "CAST_VOTES";
      playerId: PlayerId;
      /** "for" / "against", or an elect-agenda's candidate (player id, planet id, etc.) — NOT validated against the agenda's actual legal candidates yet (see RuleData.agendas' own scope note); trusts the caller/UI to only offer legal options. */
      outcome: string;
      /** Planets to exhaust for influence — votes cast = sum of their influence (RR 8.3). Empty array = abstain. Doesn't support paying with trade goods (RR 82) yet. */
      exhaustPlanetIds: PlanetId[];
    }
  | { type: "REVEAL_AGENDA" } // RR 8.2: engine-driven (no playerId) — pops the agenda deck and opens voting; wired into autoAdvancePhase so nothing needs to remember to call it, but kept as a real action for direct/manual triggering too.

  // --- Meta ---
  | { type: "END_TURN_TIMEOUT"; playerId: PlayerId }; // async safety valve: auto-pass a player who's gone silent, driven by a scheduled job, not a human click

/**
 * Append-only log entries the engine emits alongside a state transition.
 * These are what gets written to a `game_events` table in Supabase (in
 * addition to overwriting the `game_state` snapshot) — cheap audit trail,
 * "what happened" feed for the UI, and a replay mechanism if a rule bug is
 * ever found and state needs to be recomputed from scratch.
 */
export type GameEvent =
  | { type: "STRATEGY_CARD_CHOSEN"; playerId: PlayerId; cardId: StrategyCardId }
  | { type: "PLAYER_PASSED"; playerId: PlayerId }
  | { type: "SYSTEM_ACTIVATED"; playerId: PlayerId; systemId: SystemId }
  | { type: "SHIPS_MOVED"; playerId: PlayerId; toSystemId: SystemId }
  | { type: "SPACE_CANNON_OFFENSE_FIRED"; playerId: PlayerId; systemId: SystemId; hits: number }
  | { type: "SPACE_CANNON_OFFENSE_SKIPPED"; playerId: PlayerId }
  | { type: "ANTI_FIGHTER_BARRAGE_FIRED"; playerId: PlayerId; systemId: SystemId; hits: number }
  | { type: "SPACE_CANNON_DEFENSE_FIRED"; playerId: PlayerId; systemId: SystemId; planetId: PlanetId; hits: number }
  | { type: "SPACE_CANNON_DEFENSE_SKIPPED"; playerId: PlayerId }
  | { type: "RETREAT_ANNOUNCED"; playerId: PlayerId; toSystemId: SystemId }
  | { type: "COMBAT_ROUND_RESOLVED"; systemId: SystemId; planetId?: PlanetId; round: number; hitsScoredByPlayer: Partial<Record<PlayerId, number>> }
  | { type: "UNITS_DESTROYED"; playerId: PlayerId; systemId: SystemId; planetId?: PlanetId; unitType: UnitType; count: number }
  | { type: "UNIT_SUSTAINED_DAMAGE"; playerId: PlayerId; systemId: SystemId; planetId?: PlanetId; unitType: UnitType; count: number }
  | { type: "UNIT_REPAIRED"; playerId: PlayerId; systemId: SystemId; planetId?: PlanetId; unitType: UnitType; count: number }
  | { type: "SPACE_COMBAT_ENDED"; systemId: SystemId; survivingPlayerId: PlayerId | null }
  | { type: "GROUND_FORCES_COMMITTED"; playerId: PlayerId; systemId: SystemId; planetId: PlanetId }
  | { type: "BOMBARDMENT_RESOLVED"; playerId: PlayerId; systemId: SystemId; planetId: PlanetId; hits: number }
  | { type: "GROUND_COMBAT_ENDED"; systemId: SystemId; planetId: PlanetId; survivingPlayerId: PlayerId | null }
  | { type: "PLANET_CONTROL_ESTABLISHED"; systemId: SystemId; planetId: PlanetId; playerId: PlayerId }
  | { type: "UNITS_PRODUCED"; playerId: PlayerId; systemId: SystemId; planetId: PlanetId; unitType: UnitType; count: number; totalCost: number }
  | { type: "OBJECTIVE_SCORED"; playerId: PlayerId; objectiveId: ObjectiveId; points: number }
  | { type: "PUBLIC_OBJECTIVE_REVEALED"; objectiveId: ObjectiveId; kind: ObjectiveKind }
  | { type: "ACTION_CARD_DRAWN"; playerId: PlayerId; cardId: ActionCardId }
  | { type: "ACTION_CARD_PLAYED"; playerId: PlayerId; cardId: ActionCardId }
  | { type: "ACTION_CARD_DISCARDED"; playerId: PlayerId; cardId: ActionCardId }
  | { type: "AGENDA_REVEALED"; agendaId: AgendaId }
  | { type: "VOTES_CAST"; playerId: PlayerId; outcome: string; votes: number }
  | { type: "AGENDA_RESOLVED"; agendaId: AgendaId; outcome: string; becameLaw: boolean }
  | { type: "PHASE_CHANGED"; from: string; to: string; round: number }
  | { type: "ROUND_STARTED"; round: number }
  | { type: "EXPLORATION_CARD_DRAWN"; playerId: PlayerId; cardId: string; deck: "cultural" | "industrial" | "hazardous" | "frontier" }
  | { type: "RELIC_FRAGMENT_GAINED"; playerId: PlayerId; fragmentType: "cultural" | "industrial" | "hazardous" | "any" }
  | { type: "RELIC_GAINED"; playerId: PlayerId; relicId: string }
  | { type: "GAME_ENDED"; winnerId: PlayerId };

export type ActionResult =
  | { ok: true; state: import("./GameState").GameState; events: GameEvent[] }
  | { ok: false; error: string };
