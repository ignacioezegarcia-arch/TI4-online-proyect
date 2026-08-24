import { GameState, Player } from "../types/GameState";
import { PlayerId, SystemId } from "../types/ids";
import { UnitType } from "../types/enums";

/**
 * Confirmed via the TI4 Wiki's own "Reinforcements" page (twilight-
 * imperium.fandom.com/wiki/Reinforcements) — how many of each unit type
 * exist in a player's box, in their own color. This is a real, hard
 * limit: "the components in a player's reinforcements are limited and
 * the above serves as a maximum number for each that can be on the game
 * board at a given time."
 *
 * Infantry and Fighters are DELIBERATELY absent — the same page confirms
 * both are "effectively unlimited" (token substitution: as long as 1
 * physical piece accompanies a stack, the rest can be represented by
 * numbered tokens), so this engine keeps treating those 2 as untracked,
 * same as every "free unit" ability already did before this file existed.
 */
export const UNIT_SUPPLY_LIMITS: Partial<Record<UnitType, number>> = {
  destroyer: 8,
  cruiser: 8,
  carrier: 4,
  dreadnought: 5,
  war_sun: 2,
  flagship: 1,
  pds: 6,
  space_dock: 3,
  mech: 4, // PoK only — the cap simply never comes up in a base-only game since nothing there grants a mech
};

/** Same source: 16 total command tokens per player color — covers every pool (tactic/fleet/strategy) AND every token currently sitting on the board all at once. There's no separate "extra" pool beyond this; RR/the wiki's own gain-a-token text always ultimately traces back to this same fixed 16. */
export const COMMAND_TOKEN_TOTAL_SUPPLY = 16;

/**
 * How many of `unitType` this player currently has ANYWHERE — on the
 * board (any system's space area, any planet) AND captured away by
 * another player (RR "Capture": a captured non-fighter ship/mech still
 * counts against its ORIGINAL owner's reinforcement limit for as long as
 * it's captured — they can't produce a replacement until it's returned).
 * Deliberately ignores `upgradeId` — a unit-upgrade tech changes a unit's
 * stats, not which box/reinforcement pool it's drawn from.
 */
export function countUnitsOwned(state: GameState, playerId: PlayerId, unitType: UnitType): number {
  let count = 0;
  for (const system of Object.values(state.systems)) {
    for (const stack of system.spaceUnitsByPlayer[playerId] ?? []) {
      if (stack.unitType === unitType) count += stack.count;
    }
    for (const planet of system.planets) {
      for (const stack of planet.unitsByPlayer[playerId] ?? []) {
        if (stack.unitType === unitType) count += stack.count;
      }
    }
  }
  for (const otherPlayer of Object.values(state.players)) {
    for (const captured of otherPlayer.capturedUnits) {
      if (captured.fromPlayerId === playerId && captured.unitType === unitType) count += captured.count;
    }
  }
  return count;
}

/**
 * How many MORE of `unitType` this player could place right now before
 * their box's own supply limit is hit. `null` = uncapped (infantry,
 * fighter — see UNIT_SUPPLY_LIMITS' own doc comment).
 */
export function reinforcementsAvailable(state: GameState, playerId: PlayerId, unitType: UnitType): number | null {
  const limit = UNIT_SUPPLY_LIMITS[unitType];
  if (limit === undefined) return null;
  return Math.max(0, limit - countUnitsOwned(state, playerId, unitType));
}

/** Validates a whole batch of `{unitType, count}` placements against this player's remaining supply for each capped type in ONE pass — every call site that grants free/produced units should run this before actually placing anything, so a partially-illegal batch fails cleanly with no partial state change. */
export function checkReinforcementsAvailable(state: GameState, playerId: PlayerId, units: { unitType: UnitType; count: number }[]): { ok: true } | { ok: false; error: string } {
  const requested = new Map<UnitType, number>();
  for (const { unitType, count } of units) {
    if (count <= 0) continue;
    requested.set(unitType, (requested.get(unitType) ?? 0) + count);
  }
  for (const [unitType, count] of requested) {
    const available = reinforcementsAvailable(state, playerId, unitType);
    if (available !== null && count > available) {
      return { ok: false, error: `RR: only ${available} ${unitType}(s) left in this player's reinforcements (box limit ${UNIT_SUPPLY_LIMITS[unitType]}).` };
    }
  }
  return { ok: true };
}

/** How many command tokens (out of the fixed 16) this player still has available to GAIN — i.e. not yet in any of their 3 pools and not already on the board. Only relevant when a NEW token is being created for this player; moving/returning a token they already have between pools/board/reinforcements needs no check at all (the total never changes, so this count adjusts on its own). */
export function commandTokensAvailableInReinforcements(player: Pick<Player, "commandTokens">): number {
  const { tactic, fleet, strategy, onBoard } = player.commandTokens;
  return Math.max(0, COMMAND_TOKEN_TOTAL_SUPPLY - (tactic + fleet + strategy + onBoard.length));
}

/**
 * RR/the wiki's own ruling: "If a game effect would place a player's
 * command token from their reinforcements and none are available, that
 * player must take a token from a pool on their command sheet" — i.e.
 * placing a token onto a system, sourced from reinforcements, falls back
 * to spending 1 from an existing pool (tactic, then fleet, then
 * strategy — the ruling doesn't say which; this engine picks a fixed
 * order since there's no interactive per-player choice available at the
 * automatic-resolution points that call this, e.g. Signal Jamming/
 * Diplomacy Rider) instead of failing outright. Only actually fails if
 * this player has 0 tokens anywhere at all — reinforcements AND all 3
 * pools simultaneously empty.
 */
export function placeCommandTokenFromReinforcements(player: Player, systemId: SystemId): { ok: true; player: Player } | { ok: false; error: string } {
  // RR (yjmrobert.com/tirules/components/c_action_cards, confirmed via Skilled Retreat): "If the destination system already contains a player's command token, no command token is placed" — a player can only ever have 1 of their own tokens in a given system.
  if (player.commandTokens.onBoard.includes(systemId)) {
    return { ok: true, player };
  }
  const onBoard = [...player.commandTokens.onBoard, systemId];
  if (commandTokensAvailableInReinforcements(player) > 0) {
    return { ok: true, player: { ...player, commandTokens: { ...player.commandTokens, onBoard } } };
  }
  if (player.commandTokens.tactic > 0) {
    return { ok: true, player: { ...player, commandTokens: { ...player.commandTokens, tactic: player.commandTokens.tactic - 1, onBoard } } };
  }
  if (player.commandTokens.fleet > 0) {
    return { ok: true, player: { ...player, commandTokens: { ...player.commandTokens, fleet: player.commandTokens.fleet - 1, onBoard } } };
  }
  if (player.commandTokens.strategy > 0) {
    return { ok: true, player: { ...player, commandTokens: { ...player.commandTokens, strategy: player.commandTokens.strategy - 1, onBoard } } };
  }
  return { ok: false, error: "This player has no command tokens anywhere left to place." };
}
