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
import { UnitType } from "./enums";

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
      /** Fighters/ground forces picked up along the way per RR 84.1 — kept separate from ship moves because capacity is checked against these, not against ships. */
      transportedGroundForces?: { fromSystemId: SystemId; count: number }[];
      transportedFighters?: { fromSystemId: SystemId; count: number }[];
    }
  | { type: "USE_SPACE_CANNON_OFFENSE"; playerId: PlayerId; assignHitsTo: { unitType: UnitType }[] } // RR 66.2 — TODO
  | { type: "ANNOUNCE_RETREAT"; playerId: PlayerId; toSystemId: SystemId } // RR 67.4
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
  | { type: "BOMBARD"; playerId: PlayerId; targetPlanetId: PlanetId } // RR 44.1 / 15 — TODO
  | { type: "COMMIT_GROUND_FORCES"; playerId: PlayerId; targetPlanetId: PlanetId; count: number } // RR 44.2 — TODO
  | { type: "PRODUCE_UNITS"; playerId: PlayerId; planetId: PlanetId; units: { unitType: UnitType; count: number }[] } // RR 58 / 59 — TODO

  // --- Strategy card primary/secondary abilities (RR 71) ---
  | { type: "RESOLVE_STRATEGY_PRIMARY"; playerId: PlayerId; cardId: StrategyCardId; payload: unknown } // TODO, one payload shape per card
  | { type: "RESOLVE_STRATEGY_SECONDARY"; playerId: PlayerId; cardId: StrategyCardId; payload: unknown } // TODO

  // --- Component actions (RR 21) ---
  | { type: "PLAY_ACTION_CARD"; playerId: PlayerId; cardId: ActionCardId; payload: unknown } // TODO
  | { type: "RESEARCH_TECHNOLOGY"; playerId: PlayerId; techId: TechId } // RR 79.9 — TODO
  | { type: "RESEARCH_UNIT_UPGRADE"; playerId: PlayerId; upgradeId: UnitUpgradeId } // TODO

  // --- Transactions (RR 83) ---
  | {
      type: "PROPOSE_TRANSACTION";
      playerId: PlayerId;
      withPlayerId: PlayerId;
      offer: { tradeGoods: number; commodities: number; promissoryNoteId?: PromissoryNoteId };
      request: { tradeGoods: number; commodities: number; promissoryNoteId?: PromissoryNoteId };
    } // TODO — binding immediately since both sides confirm client-side before submitting

  // --- Status phase (RR 70) — mostly automatic, but objective scoring is a player choice ---
  | { type: "SCORE_OBJECTIVE"; playerId: PlayerId; objectiveId: ObjectiveId } // RR 52 — TODO

  // --- Agenda phase (RR 8) ---
  | { type: "CAST_VOTES"; playerId: PlayerId; outcome: string; exhaustPlanetIds: PlanetId[] } // TODO
  | { type: "REVEAL_AGENDA" } // engine-driven, no playerId — TODO

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
  | { type: "RETREAT_ANNOUNCED"; playerId: PlayerId; toSystemId: SystemId }
  | { type: "COMBAT_ROUND_RESOLVED"; systemId: SystemId; round: number; hitsScoredByPlayer: Partial<Record<PlayerId, number>> }
  | { type: "UNITS_DESTROYED"; playerId: PlayerId; systemId: SystemId; unitType: UnitType; count: number }
  | { type: "UNIT_SUSTAINED_DAMAGE"; playerId: PlayerId; systemId: SystemId; unitType: UnitType; count: number }
  | { type: "SPACE_COMBAT_ENDED"; systemId: SystemId; survivingPlayerId: PlayerId | null }
  | { type: "PHASE_CHANGED"; from: string; to: string; round: number }
  | { type: "ROUND_STARTED"; round: number }
  | { type: "GAME_ENDED"; winnerId: PlayerId };

export interface ActionResult {
  ok: boolean;
  /** Present when ok === true. */
  state?: import("./GameState").GameState;
  events?: GameEvent[];
  /** Present when ok === false — always a human-readable reason tied to a specific rule, e.g. "RR 5.2: system already activated by this player". */
  error?: string;
}
