/**
 * Branded primitive types.
 *
 * TypeScript structurally types plain strings, so a raw `string` for every id
 * (playerId, systemId, planetId, techId...) means the compiler will happily
 * accept a PlanetId where a SystemId belongs. Branding fixes that at zero
 * runtime cost: these are still just strings under the hood, but the
 * compiler treats them as distinct types.
 *
 * Construct one with `asPlayerId(rawString)` etc. — never with `as PlayerId`
 * directly outside this file, so every conversion is a conscious decision.
 */

type Brand<T, B extends string> = T & { readonly __brand: B };

export type PlayerId = Brand<string, "PlayerId">;
export type FactionId = Brand<string, "FactionId">; // matches key in data/factions/*.json, e.g. "sol", "letnev"
export type SystemId = Brand<string, "SystemId">; // matches tiles.json id, e.g. "18" (Mecatol Rex), "92" (Thunder's Edge tile)
export type PlanetId = Brand<string, "PlanetId">; // matches planet name/id inside tiles.json, e.g. "jord"
export type TechId = Brand<string, "TechId">; // matches technologies.json id
export type UnitUpgradeId = Brand<string, "UnitUpgradeId">; // matches unitUpgrades.json id
export type ActionCardId = Brand<string, "ActionCardId">;
export type AgendaId = Brand<string, "AgendaId">;
export type ObjectiveId = Brand<string, "ObjectiveId">;
export type ExplorationCardId = Brand<string, "ExplorationCardId">;
export type RelicId = Brand<string, "RelicId">;
export type PromissoryNoteId = Brand<string, "PromissoryNoteId">;
export type StrategyCardId = Brand<string, "StrategyCardId">; // "leadership" | "diplomacy" | ... (see enums.ts for the closed set)
export type LeaderId = Brand<string, "LeaderId">; // PoK/TE agent/commander/hero
export type AbilityId = Brand<string, "AbilityId">; // snake_case, matches player.hasAbility(id) convention

const brand =
  <B extends string>() =>
  <T extends string>(value: T): Brand<T, B> =>
    value as Brand<T, B>;

export const asPlayerId = brand<"PlayerId">();
export const asFactionId = brand<"FactionId">();
export const asSystemId = brand<"SystemId">();
export const asPlanetId = brand<"PlanetId">();
export const asTechId = brand<"TechId">();
export const asUnitUpgradeId = brand<"UnitUpgradeId">();
export const asActionCardId = brand<"ActionCardId">();
export const asAgendaId = brand<"AgendaId">();
export const asObjectiveId = brand<"ObjectiveId">();
export const asExplorationCardId = brand<"ExplorationCardId">();
export const asRelicId = brand<"RelicId">();
export const asPromissoryNoteId = brand<"PromissoryNoteId">();
export const asStrategyCardId = brand<"StrategyCardId">();
export const asLeaderId = brand<"LeaderId">();
export const asAbilityId = brand<"AbilityId">();
