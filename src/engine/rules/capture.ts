import { GameState } from "../types/GameState";
import { PlayerId, SystemId } from "../types/ids";
import { UnitType } from "../types/enums";

/**
 * RR "Capture": shared plumbing for every per-faction capture ability
 * (Vuil'Raith's own DEVOUR faction ability today; more to come as each
 * faction's own specific triggers are wired in — same deferred-scope
 * pattern as this project's Deploy/Leaders infrastructure: the GENERIC
 * mechanic gets built now, each faction's own trigger condition gets
 * connected later). Confirmed, capture splits into two completely
 * different tracks depending on unit type:
 *
 *  - NON-FIGHTER SHIPS AND MECHS: sit on the CAPTURING player's own
 *    faction sheet (tracked in Player.capturedUnits, per original owner)
 *    until returned — which only happens via a transaction agreement, an
 *    ability's own cost, or the ORIGINAL owner blockading one of the
 *    capturing player's space docks (see isBlockaded/
 *    maybeReturnCapturedUnitsOnBlockade below). While captured, the
 *    original owner cannot produce or place that unit at all.
 *  - FIGHTERS AND INFANTRY: return to their own owner's reinforcements
 *    IMMEDIATELY — confirmed, they never sit on the capturing player's
 *    faction sheet as themselves. The capturing player instead gets a
 *    plain, colorless marker (Player.capturedGenericUnits) that belongs to
 *    no player color at all: not tradeable, not affected by blockades,
 *    removed only when some other ability specifically instructs it.
 *
 *  - MUTUAL RESTRICTION: confirmed, if a player's own space dock is
 *    currently being blockaded, that player cannot capture units from
 *    whoever is blockading them (canCapture below) — checked at the same
 *    time as (and independently from) the OTHER direction (an existing
 *    capture returning because ITS original owner is now the blockader).
 */

/** RR-confirmed blockade condition: is `playerId` blockaded IN `systemId` — i.e. do they have none of their own ships there, while at least one other player does? (This is the same condition RR ties to a Production-capable unit losing its ability to produce ships — reused here as-is for Capture's own blockade check.) */
export function isBlockaded(state: GameState, playerId: PlayerId, systemId: SystemId): boolean {
  const system = state.systems[systemId];
  if (!system) return false;
  const ownShipsHere = (system.spaceUnitsByPlayer[playerId] ?? []).some((s) => s.count > 0);
  if (ownShipsHere) return false;
  return Object.entries(system.spaceUnitsByPlayer).some(([otherId, stacks]) => otherId !== playerId && (stacks ?? []).some((s) => s.count > 0));
}

/** Is any of `capturingPlayerId`'s own space docks (anywhere on the board) currently blockaded specifically BY `blockadingPlayerId`? */
function hasSpaceDockBlockadedBy(state: GameState, capturingPlayerId: PlayerId, blockadingPlayerId: PlayerId): boolean {
  for (const [systemId, system] of Object.entries(state.systems)) {
    const hasOwnSpaceDockHere = system.planets.some((p) => (p.unitsByPlayer[capturingPlayerId] ?? []).some((s) => s.unitType === "space_dock" && s.count > 0));
    if (!hasOwnSpaceDockHere) continue;
    if (!isBlockaded(state, capturingPlayerId, systemId as SystemId)) continue;
    const blockaderHasShipsHere = (system.spaceUnitsByPlayer[blockadingPlayerId] ?? []).some((s) => s.count > 0);
    if (blockaderHasShipsHere) return true;
  }
  return false;
}

/** RR "Capture": can `capturingPlayerId` currently capture a unit FROM `fromPlayerId` at all? False if `fromPlayerId` is currently blockading one of `capturingPlayerId`'s own space docks. */
export function canCapture(state: GameState, capturingPlayerId: PlayerId, fromPlayerId: PlayerId): boolean {
  return !hasSpaceDockBlockadedBy(state, capturingPlayerId, fromPlayerId);
}

/** RR "Capture": places a non-fighter ship or mech on the capturing player's own faction sheet, tracked by original owner. Merges into an existing entry for the same (unitType, fromPlayerId) pair rather than adding a duplicate. */
export function captureShipOrMech(state: GameState, capturingPlayerId: PlayerId, fromPlayerId: PlayerId, unitType: UnitType, count: number): GameState {
  const player = state.players[capturingPlayerId];
  const existing = player.capturedUnits.find((c) => c.unitType === unitType && c.fromPlayerId === fromPlayerId);
  const updatedCaptured = existing
    ? player.capturedUnits.map((c) => (c === existing ? { ...c, count: c.count + count } : c))
    : [...player.capturedUnits, { unitType, fromPlayerId, count }];
  return { ...state, players: { ...state.players, [capturingPlayerId]: { ...player, capturedUnits: updatedCaptured } } };
}

/** RR "Capture": returns a previously-captured non-fighter ship/mech to its ORIGINAL owner's reinforcements (i.e. just removes the tracking entry — this engine doesn't model a finite reinforcement supply, per its own existing scope note on that). */
export function returnCapturedShipOrMech(state: GameState, capturingPlayerId: PlayerId, fromPlayerId: PlayerId, unitType: UnitType, count: number): GameState {
  const player = state.players[capturingPlayerId];
  const existing = player.capturedUnits.find((c) => c.unitType === unitType && c.fromPlayerId === fromPlayerId);
  if (!existing) return state;
  const remaining = Math.max(0, existing.count - count);
  const updatedCaptured =
    remaining > 0
      ? player.capturedUnits.map((c) => (c === existing ? { ...c, count: remaining } : c))
      : player.capturedUnits.filter((c) => c !== existing);
  return { ...state, players: { ...state.players, [capturingPlayerId]: { ...player, capturedUnits: updatedCaptured } } };
}

/** RR "Capture": confirmed, a captured fighter/infantry unit returns to ITS OWN owner's reinforcements immediately (nothing to track per-owner) — the capturing player instead gains a colorless marker of their own. `fromPlayerId` isn't needed here at all (unlike ships/mechs) since these never belong to any player color once captured. */
export function captureFighterOrInfantry(state: GameState, capturingPlayerId: PlayerId, unitType: "infantry" | "fighter", count: number): GameState {
  const player = state.players[capturingPlayerId];
  return {
    ...state,
    players: { ...state.players, [capturingPlayerId]: { ...player, capturedGenericUnits: { ...player.capturedGenericUnits, [unitType]: player.capturedGenericUnits[unitType] + count } } },
  };
}

/** RR "Capture": returns `count` of the capturing player's own colorless captured fighter/infantry markers to the supply (i.e. just decrements the count) — only ever done because some OTHER ability specifically instructs it, never automatically. */
export function returnCapturedGenericUnits(state: GameState, capturingPlayerId: PlayerId, unitType: "infantry" | "fighter", count: number): GameState {
  const player = state.players[capturingPlayerId];
  const remaining = Math.max(0, player.capturedGenericUnits[unitType] - count);
  return { ...state, players: { ...state.players, [capturingPlayerId]: { ...player, capturedGenericUnits: { ...player.capturedGenericUnits, [unitType]: remaining } } } };
}

/**
 * RR "Capture": sweeps every player's own captured non-fighter ships/mechs
 * and auto-returns any whose ORIGINAL owner is now blockading the
 * capturing player's own space dock — confirmed, this is the one
 * automatic (not ability-triggered) return path. Call this after anything
 * that could change blockade state (today: only ship movement — see
 * phases/tacticalAction.ts's moveShips).
 */
export function maybeReturnCapturedUnitsOnBlockade(state: GameState): GameState {
  let nextState = state;
  for (const capturingPlayerId of Object.keys(state.players) as PlayerId[]) {
    const player = nextState.players[capturingPlayerId];
    for (const captured of [...player.capturedUnits]) {
      if (hasSpaceDockBlockadedBy(nextState, capturingPlayerId, captured.fromPlayerId)) {
        nextState = returnCapturedShipOrMech(nextState, capturingPlayerId, captured.fromPlayerId, captured.unitType, captured.count);
      }
    }
  }
  return nextState;
}
