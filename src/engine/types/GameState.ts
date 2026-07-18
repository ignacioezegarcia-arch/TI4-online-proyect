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
   * Ground forces and structures phys
