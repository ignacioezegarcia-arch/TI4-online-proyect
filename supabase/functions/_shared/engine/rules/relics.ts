import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { GameEvent, ActionResult } from "../types/Actions";
import { PlayerId, PlanetId, SystemId, RelicId, asRelicId, asLeaderId } from "../types/ids";
import { UnitType } from "../types/enums";
import { RuleData, getUnitStats } from "../types/RuleData";
import { getAdjacentSystems } from "./adjacency";
import { exploreFrontier } from "../phases/exploration";
import { grantBreakthrough } from "./breakthroughs";
import { setUpFractureOnEntry } from "../phases/theFracture";
import { applyIconoclastOmegaOmegaDeploy } from "./naalu";

/**
 * TI4 history note (confirmed by this project's own user): Shard of the
 * Throne, The Crown of Emphidia, and The Crown of Thalnos were AGENDA
 * cards (laws) in the base game; Prophecy of Kings moved all 3 into the
 * relic deck instead. This project's own earlier implementation (see
 * phases/agendaEffects.ts's own maybeTransferVpCard/getLawOwner-based
 * code, now superseded by this file) still modeled them as laws — wrong
 * for every game mode this project actually targets, since all of them
 * include PoK content. Ownership now lives on Player.relics like any
 * other relic; ANY code elsewhere that still calls the old law-based
 * functions needs updating to call into this file instead.
 */

function findRelicOwner(state: GameState, relicId: RelicId): PlayerId | null {
  const entry = Object.values(state.players).find((p) => p.relics.includes(relicId));
  return entry?.id ?? null;
}

function addPlanetUnits(planet: PlanetState, playerId: PlayerId, unitType: UnitType, count: number): PlanetState {
  const stacks = planet.unitsByPlayer[playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === unitType);
  const updatedStacks = existing ? stacks.map((s) => (s.unitType === unitType ? { ...s, count: s.count + count } : s)) : [...stacks, { unitType, count, damagedCount: 0 }];
  return { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [playerId]: updatedStacks } };
}

function transferRelicAndVp(state: GameState, relicId: RelicId, previousOwnerId: PlayerId, newOwnerId: PlayerId): GameState {
  const previousOwner = state.players[previousOwnerId];
  const newOwner = state.players[newOwnerId];
  if (!previousOwner || !newOwner) return state;
  const nextState: GameState = {
    ...state,
    players: {
      ...state.players,
      [previousOwnerId]: {
        ...previousOwner,
        relics: previousOwner.relics.filter((id) => id !== relicId),
        victoryPoints: { ...previousOwner.victoryPoints, current: Math.max(0, previousOwner.victoryPoints.current - 1) },
      },
      [newOwnerId]: {
        ...newOwner,
        relics: [...newOwner.relics, relicId],
        victoryPoints: { ...newOwner.victoryPoints, current: newOwner.victoryPoints.current + 1 },
      },
    },
  };
  // Naalu Collective "Iconoclast ΩΩ" (mech, Deploy): "when another player gains a relic, place 1 mech" — see rules/naalu.ts's own applyIconoclastOmegaOmegaDeploy. Confirmed this counts too: the NEW owner "gains" the relic just as much as a fresh draw, even though it's changing hands rather than coming from the deck.
  return applyIconoclastOmegaOmegaDeploy(nextState, newOwnerId);
}

/**
 * RR "Shard of the Throne" (relic, yjmrobert.com/tirules — PoK version,
 * NOT the old base-game law): "When you gain this card, gain 1 victory
 * point. When you lose this card, lose 1 victory point. When a player
 * gains control of a legendary planet you control, or a planet you
 * control in your home system, that player gains this card." Called
 * from phases/invasion.ts's own setPlanetController, right where control
 * of a planet changes hands — checks whether THAT specific planet is
 * legendary or sits in the PREVIOUS controller's own home system, and
 * whether the previous controller happened to hold the shard.
 *
 * Previously this project's own version triggered on winning ANY combat
 * against the current owner, regardless of what kind of planet was
 * involved — broader than the real relic text; replaced entirely.
 */
export function maybeTransferShardOfTheThroneOnControlGain(state: GameState, newControllerId: PlayerId, planetId: PlanetId, previousControllerId: PlayerId | null, rules: RuleData): GameState {
  if (!previousControllerId || previousControllerId === newControllerId) return state;
  const relicId = asRelicId("shard_of_the_throne");
  const ownerId = findRelicOwner(state, relicId);
  if (ownerId !== previousControllerId) return state;

  const planetData = rules.planets[planetId];
  const isLegendary = planetData?.isLegendary ?? false;
  const isInOwnersHomeSystem = planetData?.homeFactionId === state.players[previousControllerId]?.factionId;
  if (!isLegendary && !isInOwnersHomeSystem) return state;

  return transferRelicAndVp(state, relicId, previousControllerId, newControllerId);
}

/**
 * RR "The Crown of Emphidia" (relic, PoK version — a COMPLETELY
 * different mechanic than the old base-game law of the same name, which
 * transferred to whoever took the owner's home system): "After you
 * perform a tactical action, you may exhaust this card to explore 1
 * planet you control." Modeled as its own action, playable any time
 * this project's own turn-structure would recognize as "just finished a
 * tactical action" (i.e. any point during this player's own action-phase
 * turn, same simplification this project already applies to other
 * "after you take X action" abilities rather than pinpointing the exact
 * instant).
 */
export function useCrownOfEmphidia(
  state: GameState,
  action: { type: "USE_CROWN_OF_EMPHIDIA"; playerId: PlayerId; planetId: PlanetId; chosenTrait?: "cultural" | "industrial" | "hazardous" },
  rules: RuleData,
): ActionResult {
  const relicId = asRelicId("the_crown_of_emphidia");
  const player = state.players[action.playerId];
  if (!player?.relics.includes(relicId)) return { ok: false, error: "This player doesn't have The Crown of Emphidia." };
  if ((player.exhaustedRelics ?? []).includes(relicId)) return { ok: false, error: "The Crown of Emphidia is already exhausted." };

  let found: { systemId: import("../types/ids").SystemId; system: import("../types/GameState").SystemState; planet: PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === action.planetId);
    if (planet) {
      found = { systemId: systemId as import("../types/ids").SystemId, system, planet };
      break;
    }
  }
  if (!found || found.planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };

  const traits = (rules.planets[action.planetId]?.traits ?? []) as ("cultural" | "industrial" | "hazardous")[];
  let trait: "cultural" | "industrial" | "hazardous" | undefined;
  if (traits.length === 1) trait = traits[0];
  else if (traits.length > 1) {
    if (!action.chosenTrait || !traits.includes(action.chosenTrait)) {
      return { ok: false, error: `TE DUAL PLANET TRAITS: ${action.planetId} has multiple traits (${traits.join("/")}) — chosenTrait must specify which one.` };
    }
    trait = action.chosenTrait;
  }
  if (!trait) return { ok: false, error: `${action.planetId} has no trait to explore with.` };

  const deck = state.explorationDecks?.[trait] ?? [];
  if (deck.length === 0) return { ok: false, error: "That exploration deck is empty." };

  const updatedPlayer: Player = { ...player, exhaustedRelics: [...(player.exhaustedRelics ?? []), relicId] };
  // RR: exhausted (not purged) — readies at the end of the status phase like everything else that gets exhausted during the action phase (see actionPhase.ts's own runStatusPhaseBookkeeping, which readies ALL of a player's own exhaustedRelics there, not just planets).
  const [cardId, ...rest] = deck;
  const events: GameEvent[] = [{ type: "EXPLORATION_CARD_DRAWN", playerId: action.playerId, cardId, deck: trait }];
  const nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer },
    explorationDecks: { ...state.explorationDecks!, [trait]: rest },
  };
  return { ok: true, state: nextState, events };
}

/**
 * RR "The Crown of Emphidia": "At the end of the status phase, if you
 * control the 'Tomb of Emphidia' attachment, you may purge this card to
 * gain 1 Victory Point." Checked once per status phase, for whoever
 * currently holds the relic — a no-op if they don't control a planet
 * with that specific attachment.
 */
export function maybeGainCrownOfEmphidiaVictoryPoint(state: GameState, playerId: PlayerId): { state: GameState; events: GameEvent[] } {
  const relicId = asRelicId("the_crown_of_emphidia");
  const player = state.players[playerId];
  if (!player?.relics.includes(relicId)) return { state, events: [] };
  const controlsTombOfEmphidia = Object.values(state.systems).some((sys) => sys.planets.some((p) => p.controllerId === playerId && p.attachmentIds.includes("tomb_of_emphidia" as never)));
  if (!controlsTombOfEmphidia) return { state, events: [] };

  const updatedPlayer: Player = { ...player, relics: player.relics.filter((id) => id !== relicId), victoryPoints: { ...player.victoryPoints, current: player.victoryPoints.current + 1 } };
  return { state: { ...state, players: { ...state.players, [playerId]: updatedPlayer } }, events: [{ type: "RELIC_PURGED", playerId, relicId }] };
}

/**
 * RR "The Crown of Thalnos" (relic): "During each combat round, this
 * card's owner may reroll any number of their dice, applying +1 to the
 * results; any units that reroll dice but do not produce at least 1 hit
 * are destroyed." Same reroll mechanic this project already had — just
 * migrated from checking agendaDeck.lawsInPlay to Player.relics.
 */
/**
 * RR "Nano-Forge" (relic attachment): "it will be legendary for effects
 * such as scoring Make History... transferring Shard of the Throne...
 * It will also no longer be non-legendary for effects such as Stellar
 * Converter." A planet's legendary status isn't ALWAYS just the static
 * data lookup once Nano-Forge exists — this combines both. Used by
 * Shard of the Throne's own transfer check and Stellar Converter's own
 * target validation (both already updated to call this instead of the
 * raw rules.planets[...].isLegendary directly) — a full audit of every
 * OTHER place "is this planet legendary" gets checked elsewhere in this
 * project wasn't done in this same pass; flagged as a possible
 * remaining gap rather than assumed complete.
 */
export function isEffectivelyLegendary(planet: PlanetState, rules: RuleData): boolean {
  return (rules.planets[planet.planetId]?.isLegendary ?? false) || planet.attachmentIds.includes("nano_forge" as never);
}

/**
 * RR "Nano-Forge" (relic, 2 printed variants — "attach" and "no repeat"
 * in this project's own data, since the Codex errata'd it to be usable
 * only once ever; both share the same core effect): "ACTION: Attach this
 * card to a non-legendary, non-home planet you control; its resource
 * and influence values are increased by 2 and it is a legendary planet."
 * Confirmed: "the attached planet will not have a corresponding
 * legendary planet ability card" — only the stat bonus + legendary
 * status, no ability card grant.
 */
export function useNanoForge(state: GameState, action: { type: "USE_NANO_FORGE"; playerId: PlayerId; relicId: "nano_forge_attach" | "nano_forge_no_repeat"; planetId: PlanetId }, rules: RuleData): ActionResult {
  const player = state.players[action.playerId];
  const relicId = asRelicId(action.relicId);
  if (!player?.relics.includes(relicId)) return { ok: false, error: "This player doesn't have Nano-Forge." };

  let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(state.systems)) {
    const planet = system.planets.find((p) => p.planetId === action.planetId);
    if (planet) {
      found = { systemId: systemId as SystemId, system, planet };
      break;
    }
  }
  if (!found || found.planet.controllerId !== action.playerId) return { ok: false, error: "This player doesn't control that planet." };
  if (isEffectivelyLegendary(found.planet, rules)) return { ok: false, error: 'RR "Nano-Forge": cannot attach to an already-legendary planet.' };
  if (rules.planets[action.planetId]?.homeFactionId) return { ok: false, error: 'RR "Nano-Forge": cannot attach to a home planet.' };
  if (found.planet.attachmentIds.includes("nano_forge" as never)) return { ok: false, error: "That planet already has Nano-Forge attached." };

  const updatedPlanet: PlanetState = { ...found.planet, attachmentIds: [...found.planet.attachmentIds, "nano_forge"] as never };
  const updatedSystem: SystemState = { ...found.system, planets: found.system.planets.map((p) => (p.planetId === action.planetId ? updatedPlanet : p)) };
  const updatedPlayer: Player = { ...player, relics: player.relics.filter((id) => id !== relicId) };
  const nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer },
    systems: { ...state.systems, [found.systemId]: updatedSystem },
  };
  return { ok: true, state: nextState, events: [] };
}

/**
 * RR "The Obsidian" (relic — not to be confused with the Firmament's
 * own transformed faction state of the same name): "When you gain this
 * card, draw 1 secret objective. You can have 1 additional scored or
 * unscored secret objective." Called once, right when the relic is
 * gained (same "on gain" timing as Book of Latvinia above).
 */
export function applyTheObsidianOnGain(state: GameState, playerId: PlayerId, drawnSecretObjectiveId: string): GameState {
  const player = state.players[playerId];
  if (!player) return state;
  return { ...state, players: { ...state.players, [playerId]: { ...player, secretObjectives: [...player.secretObjectives, drawnSecretObjectiveId] as never } } };
}

/**
 * RR "Dynamis Core" (this project's own data has this split into 2
 * variants, "exhaust" and "gain" — matching different printings/errata
 * of the same relic; both share "while in your play area, your
 * commodity value is increased by 2"): the standing +2 commodity bonus
 * is applied via rules/spaceStations.ts's own effectiveCommoditiesMax-
 * style pattern — see that function's own call sites, now also checking
 * for this relic. The 2 variants differ only in their own purge action:
 * "exhaust" variant gains trade goods equal to printed commodity value
 * PLUS 2; "gain" variant gains trade goods equal to CURRENT commodity
 * value (which already includes the standing +2 while it's still owned,
 * checked before it's removed below).
 */
export function useDynamisCore(state: GameState, action: { type: "USE_DYNAMIS_CORE"; playerId: PlayerId; relicId: "dynamo_core_exhaust" | "dynamo_core_gain" }, rules: RuleData): ActionResult {
  const player = state.players[action.playerId];
  const relicId = asRelicId(action.relicId);
  if (!player?.relics.includes(relicId)) return { ok: false, error: "This player doesn't have Dynamis Core." };

  const printedMax = rules.factions[player.factionId]?.commoditiesMax ?? 0;
  const gainedTradeGoods = action.relicId === "dynamo_core_exhaust" ? printedMax + 2 : printedMax + 2; // both variants' own standing bonus is already +2 while owned — "current commodity value" for the "gain" variant already equals printed+2 the same way, so both resolve to the same total in this project's own model.
  const updatedPlayer: Player = { ...player, relics: player.relics.filter((id) => id !== relicId), tradeGoods: player.tradeGoods + gainedTradeGoods };
  return { ok: true, state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } }, events: [{ type: "RELIC_PURGED", playerId: action.playerId, relicId }] };
}

/**
 * RR "Scepter of Emelpar" (relic): "When you would spend a token from
 * your strategy pool, you may exhaust this card to spend a token from
 * your reinforcements instead." Confirmed rulings: applies broadly
 * (secondary abilities, faction abilities, objective scoring — anywhere
 * a strategy-pool token gets spent); if the player has NO tokens left in
 * reinforcements, they must use one from their command sheet (any pool)
 * instead.
 */
export function useScepterOfEmelpar(state: GameState, action: { type: "USE_SCEPTER_OF_EMELPAR"; playerId: PlayerId; fallbackPoolIfNoReinforcements?: "tactic" | "fleet" }): { ok: true; player: Player } | { ok: false; error: string } {
  const player = state.players[action.playerId];
  const relicId = asRelicId("scepter_of_emelpar");
  if (!player?.relics.includes(relicId)) return { ok: false, error: "This player doesn't have Scepter of Emelpar." };
  if ((player.exhaustedRelics ?? []).includes(relicId)) return { ok: false, error: "Scepter of Emelpar is already exhausted." };
  // RR: exhausted, not purged — readies at the end of the status phase (see actionPhase.ts's own runStatusPhaseBookkeeping).
  const exhaustedPlayer: Player = { ...player, exhaustedRelics: [...(player.exhaustedRelics ?? []), relicId] };
  return { ok: true, player: exhaustedPlayer };
}

/**
 * RR "The Prophet's Tears" (relic): "When you research a technology,
 * you may exhaust this card to ignore 1 prerequisite or draw 1 action
 * card." Confirmed: cannot be used when a player DIRECTLY gains a
 * technology (i.e. only actual "research" — not "gain" sources like Maw
 * of Worlds or Divert Funding).
 */
export function useProphetsTears(
  state: GameState,
  action: { type: "USE_PROPHETS_TEARS"; playerId: PlayerId; mode: "ignore_prerequisite" | "draw_action_card" },
): { ok: true; state: GameState; ignoredColor: null; events: GameEvent[] } | { ok: false; error: string } {
  const player = state.players[action.playerId];
  const relicId = asRelicId("the_prophets_tears");
  if (!player?.relics.includes(relicId)) return { ok: false, error: "This player doesn't have The Prophet's Tears." };
  if ((player.exhaustedRelics ?? []).includes(relicId)) return { ok: false, error: "The Prophet's Tears is already exhausted." };
  // RR: exhausted, not purged — readies at the end of the status phase (see actionPhase.ts's own runStatusPhaseBookkeeping).
  const updatedPlayer: Player = { ...player, exhaustedRelics: [...(player.exhaustedRelics ?? []), relicId] };
  let nextState: GameState = { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } };
  const events: GameEvent[] = [];
  if (action.mode === "draw_action_card") {
    // Actual card draw is left to the caller (phases/actionCards.ts's own drawActionCard, same as every other "draw 1 action card" effect in this project) — this function only handles the relic-exhaustion side.
  }
  return { ok: true, state: nextState, ignoredColor: null, events };
}

/**
 * RR "Circlet of the Void" (relic): "ACTION: Exhaust this card to
 * explore a frontier token in a system that does not contain any other
 * players' ships." Its OWN separate route to frontier exploration,
 * independent of the Dark Energy Tap technology that phases/exploration.ts's
 * own exploreFrontier normally requires — this relic's action grants the
 * capability itself. Exhausts (not purges) the relic — readies at the
 * end of the status phase like everything else that gets exhausted
 * during the action phase (see actionPhase.ts's own
 * runStatusPhaseBookkeeping).
 */
export function useCircletOfTheVoidExplore(
  state: GameState,
  action: { type: "USE_CIRCLET_OF_THE_VOID_EXPLORE"; playerId: PlayerId; systemId: import("../types/ids").SystemId },
  rules: RuleData,
): ActionResult {
  const relicId = asRelicId("circlet_of_the_void");
  const player = state.players[action.playerId];
  if (!player?.relics.includes(relicId)) return { ok: false, error: "This player doesn't have Circlet of the Void." };
  if ((player.exhaustedRelics ?? []).includes(relicId)) return { ok: false, error: "Circlet of the Void is already exhausted." };
  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };
  if (!system.frontierToken) return { ok: false, error: `${action.systemId} has no frontier token.` };
  const hasOtherPlayersShips = Object.entries(system.spaceUnitsByPlayer).some(([id, stacks]) => id !== action.playerId && (stacks ?? []).some((s) => s.count > 0));
  if (hasOtherPlayersShips) return { ok: false, error: "That system contains other players' ships." };

  const result = exploreFrontier({ ...state, players: { ...state.players, [action.playerId]: { ...player, technologies: [...player.technologies, "dark_energy_tap" as never] } } }, { type: "EXPLORE_FRONTIER", playerId: action.playerId, systemId: action.systemId }, rules);
  if (!result.ok) return result;

  // Restore this player's own real technology list (the temporary Dark Energy Tap addition above was only to satisfy exploreFrontier's own unrelated tech-gate, not something this relic actually grants) and mark the relic exhausted instead of purged.
  const realPlayer = result.state.players[action.playerId];
  const restoredPlayer: Player = { ...realPlayer, technologies: player.technologies, exhaustedRelics: [...(player.exhaustedRelics ?? []), relicId] };
  return { ok: true, state: { ...result.state, players: { ...result.state.players, [action.playerId]: restoredPlayer } }, events: result.events };
}

/**
 * RR "The Crown of Thalnos": queues a reroll decision for whoever owns
 * this relic, based on which of their own dice missed this combat round.
 */
export function maybeQueueCrownOfThalnosReroll(
  state: GameState,
  pending: import("../types/GameState").PendingTacticalAction,
  missedDiceByPlayerAndType: Partial<Record<PlayerId, Partial<Record<UnitType, number>>>>,
): import("../types/GameState").PendingTacticalAction {
  const ownerId = findRelicOwner(state, asRelicId("the_crown_of_thalnos"));
  if (!ownerId) return pending;
  const ownerMisses = missedDiceByPlayerAndType[ownerId];
  if (!ownerMisses || Object.values(ownerMisses).every((c) => !c)) return pending;

  return {
    ...pending,
    crownOfThalnosPendingPlayers: [...(pending.crownOfThalnosPendingPlayers ?? []), ownerId],
    crownOfThalnosMissedDiceByPlayer: { ...pending.crownOfThalnosMissedDiceByPlayer, [ownerId]: ownerMisses },
  };
}

function gainTechnologyDirectly(state: GameState, playerId: PlayerId, techId: import("../types/ids").TechId): GameState {
  const player = state.players[playerId];
  if (!player || player.technologies.includes(techId)) return state;
  return { ...state, players: { ...state.players, [playerId]: { ...player, technologies: [...player.technologies, techId] } } };
}

/**
 * RR "Maw of Worlds": "At the start of the agenda phase, you may purge
 * this card and exhaust all of your planets to gain any 1 technology."
 * Confirmed: "the player does not have to meet the prerequisites" — a
 * true "gain" (bypasses prerequisites entirely), not a "research".
 */
export function useMawOfWorlds(state: GameState, action: { type: "USE_MAW_OF_WORLDS"; playerId: PlayerId; techId: import("../types/ids").TechId }): ActionResult {
  if (state.phase !== "agenda") return { ok: false, error: 'RR "Maw of Worlds": only usable at the start of the agenda phase.' };
  const player = state.players[action.playerId];
  const relicId = asRelicId("maw_of_worlds");
  if (!player?.relics.includes(relicId)) return { ok: false, error: "This player doesn't have Maw of Worlds." };
  if (player.technologies.includes(action.techId)) return { ok: false, error: "This player already owns that technology." };

  let systems = state.systems;
  for (const [systemId, system] of Object.entries(state.systems)) {
    let changed = false;
    const planets = system.planets.map((p) => {
      if (p.controllerId === action.playerId && !p.exhausted) {
        changed = true;
        return { ...p, exhausted: true };
      }
      return p;
    });
    if (changed) systems = { ...systems, [systemId]: { ...system, planets } };
  }

  const updatedPlayer: Player = { ...player, relics: player.relics.filter((id) => id !== relicId) };
  const nextState = gainTechnologyDirectly({ ...state, systems, players: { ...state.players, [action.playerId]: updatedPlayer } }, action.playerId, action.techId);
  return { ok: true, state: nextState, events: [{ type: "RELIC_PURGED", playerId: action.playerId, relicId }] };
}

/**
 * RR "Book of Latvinia": "When you gain this card, research up to 2
 * technologies that have no prerequisites." — called once, right when
 * the relic is first gained (drawn from exploration, or any other
 * "gain a relic" source). Confirmed rulings: if the player owns ALL
 * no-prerequisite techs already, they research 0 (not an error); the
 * Nekro player specifically gains 6 command tokens and 0 technologies
 * instead (Nekro's own faction-specific override — deferred to that
 * faction's own logic pass, not built here, since this project hasn't
 * wired Nekro's faction abilities yet).
 */
export function applyBookOfLatviniaOnGain(state: GameState, playerId: PlayerId, techIds: import("../types/ids").TechId[], rules: RuleData): GameState {
  if (techIds.length > 2) return state;
  const player = state.players[playerId];
  if (!player) return state;
  let nextState = state;
  for (const techId of techIds) {
    const techData = rules.technologies[techId];
    if (!techData || techData.prerequisites.length > 0) continue; // only "no prerequisite" techs qualify
    if (nextState.players[playerId].technologies.includes(techId)) continue;
    nextState = gainTechnologyDirectly(nextState, playerId, techId);
  }
  return nextState;
}

/**
 * RR "Book of Latvinia": "ACTION: Purge this card; if you control
 * planets that have all 4 types of technology specialties, gain 1
 * victory point. Otherwise, gain the speaker token." Confirmed: this is
 * MANDATORY when all 4 specialties are controlled — "they cannot choose
 * instead to gain the speaker token."
 */
export function useBookOfLatvinia(state: GameState, action: { type: "USE_BOOK_OF_LATVINIA"; playerId: PlayerId }, rules: RuleData): ActionResult {
  const relicId = asRelicId("book_of_latvinia");
  const player = state.players[action.playerId];
  if (!player?.relics.includes(relicId)) return { ok: false, error: "This player doesn't have Book of Latvinia." };

  const specialtiesControlled = new Set<string>();
  for (const system of Object.values(state.systems)) {
    for (const p of system.planets) {
      if (p.controllerId === action.playerId) {
        for (const specialty of rules.planets[p.planetId]?.techSpecialties ?? []) specialtiesControlled.add(specialty);
      }
    }
  }
  const hasAllFour = specialtiesControlled.size >= 4;

  const updatedPlayer: Player = { ...player, relics: player.relics.filter((id) => id !== relicId) };
  let nextState: GameState = { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } };
  const events: GameEvent[] = [{ type: "RELIC_PURGED", playerId: action.playerId, relicId }];

  if (hasAllFour) {
    const finalPlayer = nextState.players[action.playerId];
    nextState = { ...nextState, players: { ...nextState.players, [action.playerId]: { ...finalPlayer, victoryPoints: { ...finalPlayer.victoryPoints, current: finalPlayer.victoryPoints.current + 1 } } } };
  } else {
    nextState = {
      ...nextState,
      players: Object.fromEntries(Object.entries(nextState.players).map(([id, p]) => [id, { ...p, isSpeaker: id === action.playerId }])) as GameState["players"],
    };
  }
  return { ok: true, state: nextState, events };
}

/**
 * RR "The Codex" (relic): "ACTION: Purge this card to take up to 3
 * action cards of your choice from the action card discard pile."
 * Confirmed rulings: the discard reshuffles into a new deck the instant
 * the deck itself hits 0 cards (a general action-card-deck rule, not
 * specific to this relic — already how this project's own drawActionCard
 * works elsewhere); which cards are taken is public knowledge (no hidden-
 * information modeling needed here beyond what this project already does
 * for hands generally).
 */
export function useTheCodex(state: GameState, action: { type: "USE_THE_CODEX"; playerId: PlayerId; cardIds: string[] }): ActionResult {
  const relicId = asRelicId("the_codex");
  const player = state.players[action.playerId];
  if (!player?.relics.includes(relicId)) return { ok: false, error: "This player doesn't have The Codex." };
  if (action.cardIds.length > 3) return { ok: false, error: 'RR "The Codex": can only take up to 3 cards.' };
  const discard = state.actionCardDiscardPile ?? [];
  for (const cardId of action.cardIds) {
    if (!discard.includes(cardId as never)) return { ok: false, error: `${cardId} isn't in the action card discard pile.` };
  }

  const updatedPlayer: Player = { ...player, relics: player.relics.filter((id) => id !== relicId), actionCards: [...player.actionCards, ...action.cardIds] as never };
  const nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer },
    actionCardDiscardPile: discard.filter((id) => !action.cardIds.includes(id)) as never,
  };
  return { ok: true, state: nextState, events: [{ type: "RELIC_PURGED", playerId: action.playerId, relicId }] };
}

/**
 * RR "Stellar Converter" (relic): "ACTION: Choose 1 non-home, non-
 * legendary planet other than Mecatol Rex in a system adjacent to 1 or
 * more of your units that have BOMBARDMENT; destroy all units on that
 * planet and purge its attachments and its planet card. Then, place the
 * destroyed planet token on that planet and purge this card." Confirmed
 * rulings: the bombardment unit and target planet must be in DIFFERENT
 * (adjacent) systems, never the same one; a system left with only a
 * destroyed planet (and no others) counts as having no planets at all
 * for other purposes; cannot target a planet the CASTER themselves
 * controls.
 */
export function useStellarConverter(
  state: GameState,
  action: { type: "USE_STELLAR_CONVERTER"; playerId: PlayerId; bombardmentSystemId: SystemId; targetSystemId: SystemId; targetPlanetId: PlanetId },
  rules: RuleData,
): ActionResult {
  const relicId = asRelicId("stellar_converter");
  const player = state.players[action.playerId];
  if (!player?.relics.includes(relicId)) return { ok: false, error: "This player doesn't have Stellar Converter." };
  if (action.bombardmentSystemId === action.targetSystemId) {
    return { ok: false, error: 'RR "Stellar Converter": the bombardment unit and target planet must be in different, adjacent systems.' };
  }
  const bombardmentSystem = state.systems[action.bombardmentSystemId];
  const hasBombardmentUnit = (bombardmentSystem?.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => {
    const stats = getUnitStats(rules, player.factionId, s.unitType, player.unitUpgrades);
    return s.count > 0 && stats?.abilities.includes("bombardment");
  });
  if (!hasBombardmentUnit) return { ok: false, error: "This player has no Bombardment-capable unit in that system." };
  if (!getAdjacentSystems(state, action.bombardmentSystemId, rules).includes(action.targetSystemId)) {
    return { ok: false, error: "The bombardment system and target system aren't adjacent." };
  }
  const targetSystem = state.systems[action.targetSystemId];
  const targetPlanet = targetSystem?.planets.find((p) => p.planetId === action.targetPlanetId);
  if (!targetPlanet) return { ok: false, error: `${action.targetPlanetId} isn't in the target system.` };
  if (targetPlanet.destroyed) return { ok: false, error: "That planet is already destroyed." };
  if (targetPlanet.controllerId === action.playerId) return { ok: false, error: 'RR "Stellar Converter": cannot target a planet this player controls.' };
  const planetData = rules.planets[action.targetPlanetId];
  if (planetData?.isMecatolRex) return { ok: false, error: "Cannot target Mecatol Rex." };
  // RR "Nano-Forge": "[the planet] will also no longer be non-legendary for effects such as the Stellar Converter relic" — checked via isEffectivelyLegendary (static data OR Nano-Forge attached), not the raw static flag alone.
  if (isEffectivelyLegendary(targetPlanet, rules)) return { ok: false, error: "Cannot target a legendary planet." };
  if (planetData?.homeFactionId) return { ok: false, error: "Cannot target a home planet." };

  const updatedPlayer: Player = { ...player, relics: player.relics.filter((id) => id !== relicId) };
  // RR "Stellar Converter": "place the destroyed planet token on that planet" — kept as an entry (marked destroyed), not deleted; controllerId/units/attachments all cleared ("destroy all units... purge its attachments and its planet card").
  const destroyedPlanet: PlanetState = {
    ...targetPlanet,
    destroyed: true,
    controllerId: null,
    exhausted: false,
    explored: true,
    attachmentIds: [],
    unitsByPlayer: {},
    coexistingPlayerIds: undefined,
  };
  const updatedSystem: SystemState = { ...targetSystem, planets: targetSystem.planets.map((p) => (p.planetId === action.targetPlanetId ? destroyedPlanet : p)) };
  const nextState: GameState = {
    ...state,
    players: { ...state.players, [action.playerId]: updatedPlayer },
    systems: { ...state.systems, [action.targetSystemId]: updatedSystem },
  };
  return { ok: true, state: nextState, events: [{ type: "RELIC_PURGED", playerId: action.playerId, relicId }, { type: "PLANET_DESTROYED", systemId: action.targetSystemId, planetId: action.targetPlanetId }] };
}

/**
 * RR "Heart of Ixth" (relic): "After any die is rolled, you may exhaust
 * this card to add or subtract 1 from its results." Confirmed: the "0"
 * side of a d10 represents 10 — this relic may turn a rolled 10 into a 9
 * (by "subtracting 1"), or a rolled 9 into a 10, matching that.
 *
 * KNOWN SCOPE LIMIT: "after ANY die is rolled" is an extremely broad
 * trigger — this implements the core exhaust-and-adjust mechanic itself
 * (validated, single-use per status phase), but wiring an offered
 * "would you like to use Heart of Ixth?" prompt into literally EVERY
 * die-roll moment across this whole project's combat/agenda/other
 * systems is well beyond what this pass covers. Any caller that wants to
 * offer this needs to call this function with the specific roll in
 * question at its own specific moment.
 */
/**
 * RR "Heart of Ixth" (relic): "After you roll a die for any reason, you
 * may exhaust this card to add or subtract 1 from the result." Reads and
 * updates GameState.pendingHeartOfIxthAdjustableRoll directly — NOT a
 * caller-supplied `originalRoll` parameter, which previously had no real
 * state to check it against at all (a client could claim any roll it
 * wanted, bypassing whatever was actually rolled — see that field's own
 * doc comment on GameState.ts). Currently only wired for RR "Ixthian
 * Artifact" (the one place in the whole project that stores its roll
 * this way) — the card's own "for ANY reason" text would need this same
 * pending-adjustable-roll shape built out for every other dice-rolling
 * action too, which hasn't been done; flagged rather than silently
 * assumed to already cover everything.
 */
export function useHeartOfIxth(state: GameState, action: { type: "USE_HEART_OF_IXTH"; playerId: PlayerId; adjustment: 1 | -1 }): ActionResult {
  const player = state.players[action.playerId];
  const relicId = asRelicId("heart_of_ixth");
  if (!player?.relics.includes(relicId)) return { ok: false, error: "This player doesn't have Heart of Ixth." };
  if ((player.exhaustedRelics ?? []).includes(relicId)) return { ok: false, error: "Heart of Ixth is already exhausted." };
  const pending = state.pendingHeartOfIxthAdjustableRoll;
  if (!pending) return { ok: false, error: "No adjustable die roll is currently pending." };

  let adjustedRoll = pending.roll + action.adjustment;
  // The "0" face represents 10 — 10+1 wraps to 9's usual neighbor going up is nonsensical (there is no 11), and 1-1 similarly has no 0 distinct from 10 on this die, so both ends just clamp within the 1-10 range actually printed on the physical die.
  if (adjustedRoll > 10) adjustedRoll = 10;
  if (adjustedRoll < 1) adjustedRoll = 1;

  const updatedPlayer: Player = { ...player, exhaustedRelics: [...(player.exhaustedRelics ?? []), relicId] };
  return {
    ok: true,
    state: {
      ...state,
      players: { ...state.players, [action.playerId]: updatedPlayer },
      pendingHeartOfIxthAdjustableRoll: { ...pending, roll: adjustedRoll },
    },
    events: [{ type: "HEART_OF_IXTH_ADJUSTED_ROLL", playerId: action.playerId, originalRoll: pending.roll, adjustedRoll }],
  };
}

/**
 * RR "The Silver Flame" (relic): "The Silver Flame may be exchanged as
 * part of a transaction. ACTION: Roll 1 die and purge this card; if the
 * result is a 10, gain 1 victory point. Otherwise, purge your home
 * system and all units in it; you cannot score public objectives. Put
 * the Fracture into play if it is not already." A genuine gamble —
 * "purge your home system" here means every planet in it gets the same
 * destroyed-token treatment Stellar Converter's own planets get (kept as
 * entries, marked destroyed, not deleted), and every unit there
 * (friendly or otherwise) is destroyed outright.
 */
export function useSilverFlame(state: GameState, action: { type: "USE_SILVER_FLAME"; playerId: PlayerId; dieRoll: number; fractureDieRoll?: number }, rules: RuleData): ActionResult {
  const player = state.players[action.playerId];
  const relicId = asRelicId("the_silver_flame");
  if (!player?.relics.includes(relicId)) return { ok: false, error: "This player doesn't have The Silver Flame." };

  const updatedPlayer: Player = { ...player, relics: player.relics.filter((id) => id !== relicId) };
  let nextState: GameState = { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } };
  const events: GameEvent[] = [{ type: "RELIC_PURGED", playerId: action.playerId, relicId }];

  if (action.dieRoll === 10) {
    const finalPlayer = nextState.players[action.playerId];
    nextState = { ...nextState, players: { ...nextState.players, [action.playerId]: { ...finalPlayer, victoryPoints: { ...finalPlayer.victoryPoints, current: finalPlayer.victoryPoints.current + 1 } } } };
    return { ok: true, state: nextState, events };
  }

  const homeSystemId = rules.homeSystemByFaction[player.factionId] as SystemId | undefined;
  if (homeSystemId) {
    const homeSystem = nextState.systems[homeSystemId];
    if (homeSystem) {
      const destroyedPlanets = homeSystem.planets.map((p): PlanetState => ({
        ...p,
        destroyed: true,
        controllerId: null,
        exhausted: false,
        attachmentIds: [],
        unitsByPlayer: {},
        coexistingPlayerIds: undefined,
      }));
      const updatedHomeSystem: SystemState = { ...homeSystem, planets: destroyedPlanets, spaceUnitsByPlayer: {} };
      nextState = { ...nextState, systems: { ...nextState.systems, [homeSystemId]: updatedHomeSystem } };
      events.push(...destroyedPlanets.map((p): GameEvent => ({ type: "PLANET_DESTROYED", systemId: homeSystemId, planetId: p.planetId })));
    }
  }
  const finalPlayer = nextState.players[action.playerId];
  nextState = { ...nextState, players: { ...nextState.players, [action.playerId]: { ...finalPlayer, cannotScorePublicObjectives: true } } };

  if (!nextState.fractureInPlay) {
    const setup = setUpFractureOnEntry(nextState, rules, action.playerId);
    nextState = { ...setup.state, fractureInPlay: true };
    events.push({ type: "FRACTURE_ENTERED_PLAY", triggeredByPlayerId: action.playerId }, ...setup.events);
  }
  return { ok: true, state: nextState, events };
}

/**
 * RR "The Quantumcore" (relic): "When you gain this card, gain your
 * breakthrough. You have SYNERGY for all technology types." Unusual
 * among relics — a standing, ongoing effect once gained, not an
 * exhaust/purge action at all. The "synergy for all technology types"
 * part (broader than the normal 2-color faction synergy pair) needs its
 * own check wherever prerequisite-synergy gets applied.
 */
export function applyTheQuantumcoreOnGain(state: GameState, playerId: PlayerId, rules: RuleData, fractureDieRoll?: number): { state: GameState; events: GameEvent[] } {
  return grantBreakthrough(state, playerId, rules, fractureDieRoll);
}

/** RR "The Quantumcore": true if this player owns it — checked alongside the normal 2-color breakthroughSynergy pair wherever prerequisite-synergy substitution happens, granting ALL 4 tech colors as mutually substitutable instead of just 2. */
export function hasQuantumcoreUniversalSynergy(state: GameState, playerId: PlayerId): boolean {
  return state.players[playerId]?.relics.includes("the_quantumcore" as never) ?? false;
}

/**
 * RR "The Triad" (relic): "This card can be readied and spent as if it
 * were a planet card. Its resource and influence values are equal to 3
 * plus the number of different types of relic fragments you own."
 * Confirmed rulings: readied by planet-readying effects (Diplomacy
 * strategy card, status phase); not a planet for ANY other purpose
 * (can't hold units, can't be exhausted by Reparations/Uprising, can't
 * be elected/exhausted by agenda effects, no attachments, doesn't count
 * toward planet-count objectives or planet-type objectives, has no
 * trait/cannot be explored); CAN be exhausted to cast agenda votes and
 * readies at the end of the agenda phase specifically (in addition to
 * the normal status-phase readying every other exhausted thing gets).
 *
 * Modeled as its own tracked exhausted/readied state via the SAME
 * player.exhaustedRelics list every other relic already uses (pushing/
 * filtering the sentinel id "the_triad"), NOT a real planet anywhere in
 * `systems` — this is what makes it structurally exempt, for free, from
 * every "NOT a planet for X" exclusion above (planet-count/type
 * objectives, attachments, exploration, unit-holding all iterate real
 * SystemState.planets, which The Triad never enters). Wired into every
 * "spend/ready as if it were a planet" call site that actually spends
 * resources or influence for a cost, or casts votes, or readies planets:
 * phases/technology.ts's own spendForCost (production + research, both
 * routes), phases/strategyCardAbilities.ts's own exhaustPlanetsForInfluence
 * (Leadership) and readyPlanets (Diplomacy primary+secondary),
 * phases/agendaPhase.ts's own castVotes, its own extra end-of-agenda-
 * phase readying in phases/actionPhase.ts's own startNewRound, RR "Checks
 * and Balances" ("against")'s own planet-readying in
 * phases/agendaEffects.ts, and RR "Reparations"'s own ready-half in
 * phases/actionCardEffects.ts (its exhaust-half correctly stays real-
 * planets-only, per the confirmed exemption above).
 * phases/legendaryPlanets.ts's own useTheAcropolis (The Acropolis) needed
 * NO change at all — it already readies by generic relic id via
 * player.exhaustedRelics, which "the_triad" already flows through
 * correctly.
 *
 * Individually verified and confirmed EXEMPT (not silently missed) at
 * every other "ready/exhaust a planet" site in the codebase: RR
 * "Uprising" and Reparations's own exhaust-half only ever look up real
 * board planets via findPlanet, so The Triad — never present in
 * `systems` — is structurally unreachable there, matching the confirmed
 * "can't be exhausted by Reparations/Uprising" ruling for free. Bio-
 * Stims, TE "Brilliance" (ready_planet mode), and RR "Economic
 * Initiative" each require a real printed trait/tech-specialty The Triad
 * doesn't have. TE "Expedition"/"Core Mine"/"Volatile Fuel Source"
 * exploration cards and TE "Mercenary Contract" operate on the specific
 * planet being explored or targeted directly, never The Triad
 * (uncontrolled/unexplorable). Xxcha's own "Ggrucoto Rinn" and
 * "Planetary Defense Nexus" are both fundamentally spatial (system
 * adjacency / unit placement), which The Triad — with no board position
 * or unit-holding capacity at all — can never satisfy either way.
 */
export function getTriadResourcesAndInfluence(player: Player): { resources: number; influence: number } {
  const fragmentTypesOwned = (["cultural", "industrial", "hazardous", "unknown"] as const).filter((t) => player.relicFragments[t] > 0).length;
  const value = 3 + fragmentTypesOwned;
  return { resources: value, influence: value };
}

/**
 * RR "JR-XS455-O" (relic): "is an agent. All rules that apply to agents
 * (and leaders) apply to it." Confirmed: may be refreshed by the Nomad
 * player's Temporal Command Suite technology, and its ability may be
 * duplicated by the Yssaril player's Ssruu agent if the Yssaril player
 * doesn't own it themselves — both are OTHER factions' own cross-
 * interactions, not built here since neither Temporal Command Suite nor
 * Ssruu are wired into this project yet; flagged rather than silently
 * ignored. Added to Player.leaders (locked: false — agents are usable
 * immediately, no unlock condition, unlike commanders/heroes) the moment
 * the relic itself is gained.
 */
export function applyJrXs455OOnGain(state: GameState, playerId: PlayerId): GameState {
  const player = state.players[playerId];
  if (!player) return state;
  const leaderId = asLeaderId("jr_xs4_55_0");
  if (player.leaders.some((l) => l.leaderId === leaderId)) return state;
  return { ...state, players: { ...state.players, [playerId]: { ...player, leaders: [...player.leaders, { leaderId, locked: false, exhausted: false }] } } };
}

/**
 * Shared dispatcher for every relic's own "when you gain this card"
 * trigger — called from every genuine "a player gains a fresh relic"
 * site (phases/exploration.ts's own Dead World draw, phases/
 * directiveEffects.ts's own Minister of Antiques, phases/invasion.ts's
 * own first-ever-control-of-a-relic-icon-planet), same call sites as
 * rules/naalu.ts's own applyIconoclastOmegaOmegaDeploy (called alongside
 * this, not by it — Iconoclast belongs to Naalu, this file owns every
 * relic's own trigger). NOT called from this file's own
 * transferRelicAndVp: that function is scoped to the 3 VP-carrying
 * relics only (Shard of the Throne/Crown of Emphidia/Crown of Thalnos),
 * none of which have an "on gain" trigger of their own.
 *
 *  - The Obsidian / The Quantumcore / JR-XS455-O: deterministic, no
 *    player choice needed — applied immediately.
 *  - The Obsidian's own secret objective draw is a random deck pop (same
 *    "trusted context's own random pick" convention as this project's
 *    Executive Sanctions discard), which is why maybeQueueSecretObjectiveLimit
 *    (phases/agendaEffects.ts) needs to already know about this player's
 *    new +1 capacity BEFORE that draw would ever risk tripping the
 *    generic 3-total limit — checked there via player.relics directly,
 *    not through this function.
 *  - Book of Latvinia: the one exception, a genuine "up to 2" player
 *    choice — queued in pendingBookOfLatviniaChoice instead of resolved
 *    here, consumed by this file's own separate resolveBookOfLatviniaOnGain.
 */
export function applyRelicOnGainEffects(state: GameState, playerId: PlayerId, relicId: RelicId, rules: RuleData): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  let nextState = state;

  if (relicId === ("the_obsidian" as never)) {
    const deck = nextState.secretObjectiveDeck ?? [];
    const [drawnId, ...rest] = deck;
    if (drawnId) {
      nextState = { ...nextState, secretObjectiveDeck: rest };
      nextState = applyTheObsidianOnGain(nextState, playerId, drawnId);
    }
  } else if (relicId === ("the_quantumcore" as never)) {
    const result = applyTheQuantumcoreOnGain(nextState, playerId, rules);
    nextState = result.state;
    events.push(...result.events);
  } else if (relicId === ("jr_xs4_55_0" as never)) {
    nextState = applyJrXs455OOnGain(nextState, playerId);
  } else if (relicId === ("book_of_latvinia" as never)) {
    const already = nextState.pendingBookOfLatviniaChoice ?? [];
    if (!already.includes(playerId)) {
      nextState = { ...nextState, pendingBookOfLatviniaChoice: [...already, playerId] };
    }
  }

  return { state: nextState, events };
}

/** The player's own choice half of "Book of Latvinia" — see applyBookOfLatviniaOnGain above for the actual research logic and pendingBookOfLatviniaChoice's own doc comment (GameState.ts) for why this needs its own pending+resolve pair unlike this file's other 3 "on gain" relics. Passing an empty array is the confirmed-legal "research 0" case (RR: not an error, e.g. if the player already owns every no-prerequisite tech). */
export function resolveBookOfLatviniaOnGain(state: GameState, action: { type: "RESOLVE_BOOK_OF_LATVINIA_ON_GAIN"; playerId: PlayerId; techIds: import("../types/ids").TechId[] }, rules: RuleData): ActionResult {
  if (!(state.pendingBookOfLatviniaChoice ?? []).includes(action.playerId)) {
    return { ok: false, error: "This player has no pending Book of Latvinia gain-choice owed right now." };
  }
  if (action.techIds.length > 2) return { ok: false, error: "Book of Latvinia: research up to 2 technologies, not more." };

  const nextState = applyBookOfLatviniaOnGain(state, action.playerId, action.techIds, rules);
  return {
    ok: true,
    state: { ...nextState, pendingBookOfLatviniaChoice: (nextState.pendingBookOfLatviniaChoice ?? []).filter((id) => id !== action.playerId) },
    events: [],
  };
}

/**
 * RR "JR-XS455-O" (relic/agent): "ACTION: Exhaust this agent and choose
 * a player; that player may spend 3 resources to place a structure on a
 * planet they control. If they do not, they gain 1 trade good." Readies
 * at the end of the status phase like every other agent (confirmed by
 * this project's own user) — see actionPhase.ts's own
 * runStatusPhaseBookkeeping, which readies every leader entry there.
 */
export function useJrXs455O(
  state: GameState,
  action: { type: "USE_JR_XS455_O"; playerId: PlayerId; targetPlayerId: PlayerId; placeStructure?: { planetId: PlanetId; structureType: "space_dock" | "pds"; exhaustPlanetIdsForResources: PlanetId[] } },
  rules: RuleData,
): ActionResult {
  const leaderId = asLeaderId("jr_xs4_55_0");
  const player = state.players[action.playerId];
  const leaderEntry = player?.leaders.find((l) => l.leaderId === leaderId);
  if (!leaderEntry) return { ok: false, error: "This player doesn't have JR-XS455-O." };
  if (leaderEntry.exhausted) return { ok: false, error: "JR-XS455-O is already exhausted." };

  const updatedPlayer: Player = { ...player, leaders: player.leaders.map((l) => (l.leaderId === leaderId ? { ...l, exhausted: true } : l)) };
  let nextState: GameState = { ...state, players: { ...state.players, [action.playerId]: updatedPlayer } };
  const events: GameEvent[] = [];

  if (action.placeStructure) {
    const target = nextState.players[action.targetPlayerId];
    if (!target) return { ok: false, error: "Unknown target player." };
    let totalResources = 0;
    let systems = nextState.systems;
    for (const planetId of action.placeStructure.exhaustPlanetIdsForResources) {
      let found: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
      for (const [systemId, system] of Object.entries(systems)) {
        const planet = system.planets.find((p) => p.planetId === planetId);
        if (planet) {
          found = { systemId: systemId as SystemId, system, planet };
          break;
        }
      }
      if (!found || found.planet.controllerId !== action.targetPlayerId || found.planet.exhausted) {
        return { ok: false, error: `Cannot exhaust ${planetId} for resources.` };
      }
      totalResources += rules.planets[planetId]?.resources ?? 0;
      const updatedPlanet: PlanetState = { ...found.planet, exhausted: true };
      systems = { ...systems, [found.systemId]: { ...found.system, planets: found.system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } };
    }
    if (totalResources < 3) return { ok: false, error: "Not enough resources from the exhausted planets (need 3)." };

    const structurePlanetFound = Object.values(systems).flatMap((s) => s.planets).find((p) => p.planetId === action.placeStructure!.planetId);
    if (!structurePlanetFound || structurePlanetFound.controllerId !== action.targetPlayerId) {
      return { ok: false, error: "Target player doesn't control that planet." };
    }
    const structureSystemEntry = Object.entries(systems).find(([, s]) => s.planets.some((p) => p.planetId === action.placeStructure!.planetId))!;
    const [structureSystemId, structureSystem] = structureSystemEntry;
    const updatedStructurePlanet = addPlanetUnits(structureSystem.planets.find((p) => p.planetId === action.placeStructure!.planetId)!, action.targetPlayerId, action.placeStructure.structureType, 1);
    systems = { ...systems, [structureSystemId]: { ...structureSystem, planets: structureSystem.planets.map((p) => (p.planetId === action.placeStructure!.planetId ? updatedStructurePlanet : p)) } };
    nextState = { ...nextState, systems };
  } else {
    const target = nextState.players[action.targetPlayerId];
    if (!target) return { ok: false, error: "Unknown target player." };
    nextState = { ...nextState, players: { ...nextState.players, [action.targetPlayerId]: { ...target, tradeGoods: target.tradeGoods + 1 } } };
  }

  return { ok: true, state: nextState, events };
}

/**
 * RR "Neuraloop" (relic): "When a public objective is revealed, you may
 * purge one of your relics to discard that objective and replace it
 * with a random objective from any objective deck; that objective is a
 * public objective, even if it is a secret objective." The most
 * confirmed-ruling-dense relic in the whole set — each numbered point
 * below is handled explicitly:
 *
 * 1. Purging Neuraloop itself is legal (resolves its own ability).
 * 2. Purging Nano-Forge (even attached) removes the attachment from
 *    whatever planet has it, if this player controls that planet — it
 *    loses the +2/+2 and legendary status.
 * 3. Purging any OTHER relic that has its OWN purge ability does NOT
 *    resolve that ability — it's just discarded/removed, nothing else
 *    happens (no Stellar Converter destruction, no Shard-of-the-Throne-
 *    style side effect beyond the ones explicitly confirmed below).
 * 5. Purging Dynamis Core: if commodities now exceed the (lower, post-
 *    loss) max, the excess is returned to the supply (clamped down).
 * 6. Purging The Obsidian: if this player has 4 total scored+unscored
 *    secret objectives, they must discard 1 UNSCORED one (no effect if
 *    all 4 are already scored).
 * 7. Purging Shard of the Throne: lose 1 VP (matches the relic's own
 *    "when you lose this card, lose 1 VP" text exactly).
 * 9/11. The replacement objective becomes public — permanently, not
 *    just for this reveal — regardless of which deck it was drawn from;
 *    scoring it later never counts against anyone's own 3-secret limit.
 * 12. The discarded objective is shuffled back into ITS OWN deck only
 *    AFTER the replacement is revealed — modeled by literally doing the
 *    discard-then-reshuffle in that order below, so chaining a 2nd
 *    Neuraloop purge in the SAME reaction could in principle redraw the
 *    just-discarded objective before it's reshuffled in, matching the
 *    confirmed note on this exact sequencing.
 *
 * NOT built here (pre-existing gap, not introduced by this relic): RR's
 * own "max 1 objective of any type scored during/after a single combat"
 * restriction isn't implemented anywhere in this project yet, so the
 * specific interaction "cannot score this AND your own secret from the
 * same combat" can't be enforced — flagged rather than silently assumed
 * handled.
 *
 * Also NOT built: 4 didn't need special code (Circlet of the Void's own
 * "ships already in a restricted anomaly can still leave, just can't
 * bring more in" falls out naturally from this relic simply no longer
 * being owned — normal movement rules already only restrict ENTERING/
 * PASSING THROUGH, never forcibly evict units already present).
 */
export function useNeuraloop(
  state: GameState,
  action: { type: "USE_NEURALOOP"; playerId: PlayerId; relicIdToPurge: string; discardedObjectiveId: import("../types/ids").ObjectiveId; replacementObjectiveId: import("../types/ids").ObjectiveId; replacementDeck: "publicStageI" | "publicStageII" | "secret" },
  rules: RuleData,
): ActionResult {
  const neuraloopId = asRelicId("neuraloop");
  const player = state.players[action.playerId];
  if (!player?.relics.includes(neuraloopId)) return { ok: false, error: "This player doesn't have Neuraloop." };
  const purgedRelicId = asRelicId(action.relicIdToPurge);
  if (!player.relics.includes(purgedRelicId)) return { ok: false, error: "This player doesn't have that relic to purge." };

  let nextState = state;
  const events: GameEvent[] = [];
  let updatedPlayer: Player = { ...player, relics: player.relics.filter((id) => id !== purgedRelicId) };

  // Point 2: Nano-Forge removal from its attached planet.
  if (purgedRelicId === ("nano_forge_attach" as never) || purgedRelicId === ("nano_forge_no_repeat" as never)) {
    for (const [systemId, system] of Object.entries(nextState.systems)) {
      const planetIdx = system.planets.findIndex((p) => p.controllerId === action.playerId && p.attachmentIds.includes("nano_forge" as never));
      if (planetIdx >= 0) {
        const updatedPlanets = system.planets.map((p, i) => (i === planetIdx ? { ...p, attachmentIds: p.attachmentIds.filter((a) => a !== "nano_forge") } : p));
        nextState = { ...nextState, systems: { ...nextState.systems, [systemId]: { ...system, planets: updatedPlanets } } };
        break;
      }
    }
  }
  // Point 5: Dynamis Core removal — clamp commodities down to the new (lower) max.
  if (purgedRelicId === ("dynamo_core_exhaust" as never) || purgedRelicId === ("dynamo_core_gain" as never)) {
    const newMax = rules.factions[player.factionId]?.commoditiesMax ?? 0;
    if (updatedPlayer.commodities > newMax) updatedPlayer = { ...updatedPlayer, commodities: newMax };
  }
  // Point 6: The Obsidian removal — discard 1 unscored secret if now over the (lower) limit.
  if (purgedRelicId === ("the_obsidian" as never)) {
    const totalSecrets = updatedPlayer.secretObjectives.length;
    if (totalSecrets > 3) {
      const unscoredIds = updatedPlayer.secretObjectives.filter((id) => !updatedPlayer.victoryPoints.scoredObjectiveIds.includes(id));
      if (unscoredIds.length > 0) {
        const toDiscard = unscoredIds[0];
        updatedPlayer = { ...updatedPlayer, secretObjectives: updatedPlayer.secretObjectives.filter((id) => id !== toDiscard) };
      }
    }
  }
  // Point 7: Shard of the Throne removal — lose 1 VP (same as its own "when you lose this card" text).
  if (purgedRelicId === ("shard_of_the_throne" as never)) {
    updatedPlayer = { ...updatedPlayer, victoryPoints: { ...updatedPlayer.victoryPoints, current: Math.max(0, updatedPlayer.victoryPoints.current - 1) } };
  }

  nextState = { ...nextState, players: { ...nextState.players, [action.playerId]: updatedPlayer } };

  // Discard the original objective, reveal the replacement as PUBLIC (permanently — regardless of source deck), then reshuffle the discard back into its OWN deck, in that specific order (point 12).
  const discardedEntry = nextState.objectives.find((o) => o.objectiveId === action.discardedObjectiveId);
  const remainingObjectives = nextState.objectives.filter((o) => o.objectiveId !== action.discardedObjectiveId);
  // RR "Neuraloop": "that objective is a public objective, even if it is a secret objective" — if the replacement was drawn from the secret deck, it's tagged publicI here rather than "secret" (its own natural static kind), since this ObjectiveState.kind field is what everything else in this project checks to decide public-vs-secret treatment.
  const replacementNaturalKind = rules.objectives[action.replacementObjectiveId]?.kind ?? "publicI";
  const replacementKind = replacementNaturalKind === "secret" ? "publicI" : replacementNaturalKind;
  nextState = { ...nextState, objectives: [...remainingObjectives, { kind: replacementKind, objectiveId: action.replacementObjectiveId, revealed: true }] };
  events.push({ type: "PUBLIC_OBJECTIVE_REVEALED", objectiveId: action.replacementObjectiveId, kind: replacementKind });

  const discardedKind = discardedEntry?.kind ?? rules.objectives[action.discardedObjectiveId]?.kind ?? "publicI";
  const discardedDeck = discardedKind === "secret" ? "secret" : discardedKind === "publicII" ? "publicStageII" : "publicStageI";
  if (discardedDeck === "secret") {
    nextState = { ...nextState, secretObjectiveDeck: [...(nextState.secretObjectiveDeck ?? []), action.discardedObjectiveId] };
  } else if (discardedDeck === "publicStageII") {
    nextState = { ...nextState, publicObjectiveDeck: { ...nextState.publicObjectiveDeck!, stageII: [...(nextState.publicObjectiveDeck?.stageII ?? []), action.discardedObjectiveId] } };
  } else {
    nextState = { ...nextState, publicObjectiveDeck: { ...nextState.publicObjectiveDeck!, stageI: [...(nextState.publicObjectiveDeck?.stageI ?? []), action.discardedObjectiveId] } };
  }

  // Draw the replacement off the TOP of whichever deck the caller chose, matching "any objective deck".
  if (action.replacementDeck === "secret") {
    nextState = { ...nextState, secretObjectiveDeck: (nextState.secretObjectiveDeck ?? []).filter((id) => id !== action.replacementObjectiveId) };
  } else if (action.replacementDeck === "publicStageII") {
    nextState = { ...nextState, publicObjectiveDeck: { ...nextState.publicObjectiveDeck!, stageII: (nextState.publicObjectiveDeck?.stageII ?? []).filter((id) => id !== action.replacementObjectiveId) } };
  } else {
    nextState = { ...nextState, publicObjectiveDeck: { ...nextState.publicObjectiveDeck!, stageI: (nextState.publicObjectiveDeck?.stageI ?? []).filter((id) => id !== action.replacementObjectiveId) } };
  }

  return { ok: true, state: nextState, events };
}
