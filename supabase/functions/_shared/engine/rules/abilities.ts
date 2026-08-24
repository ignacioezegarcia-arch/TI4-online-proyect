import { AbilityId } from "../types/ids";
import { Player } from "../types/GameState";

/**
 * Generic check for "does this player currently have a faction- or
 * breakthrough-granted ability with this id" — the hook point
 * types/GameState.ts's own Player.abilityIds doc comment already
 * describes as `player.hasAbility(id)`. Kept as a plain function (not a
 * literal object method) since GameState is plain, serializable data
 * throughout this project, not a class.
 *
 * Deliberately generic: which SPECIFIC faction ability grants a given id
 * (e.g. which of Deepwrought's Research Team, the Firmament's own Viper
 * EX-23, or Titans of Ul's Coalescence grants "coexist_on_commit") is
 * faction-specific wiring that comes later — this file only needs to
 * know the id string itself, not who grants it.
 */
export function hasAbility(player: Player, id: AbilityId): boolean {
  return player.abilityIds.includes(id);
}
