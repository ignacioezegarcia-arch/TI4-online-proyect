import { GameState, Player, PlanetState, SystemState } from "../types/GameState";
import { ActionResult, GameEvent } from "../types/Actions";
import { PlayerId, PlanetId, SystemId } from "../types/ids";
import { RuleData } from "../types/RuleData";
import { UnitType } from "../types/enums";
import { buildBombardmentEntries, resolveCombatRound, planetHasShield } from "./combat";
import { hasCodex } from "./gameMode";
import { checkReinforcementsAvailable } from "./reinforcements";

/**
 * L1Z1X "ASSIMILATE" (faction ability): the "steal from elsewhere"
 * fallback half — "If the L1Z1X player would have to place a structure,
 * but there are none of that type left in their reinforcements, they
 * may remove a structure of that type from any system that does not
 * contain one of their command tokens and place that instead."
 * Confirmed (yjmrobert.com/tirules/factions/f_lizix). The main
 * replacement (when reinforcements ARE sufficient) already happens
 * automatically inside phases/invasion.ts's own setPlanetController;
 * this only resolves whatever got queued there because reinforcements
 * were empty at that moment.
 */
export function resolveAssimilateSubstitute(
  state: GameState,
  action: { type: "RESOLVE_ASSIMILATE_SUBSTITUTE"; playerId: PlayerId; planetId: PlanetId; unitType: UnitType; substituteSourceSystemId: SystemId },
): ActionResult {
  const player = state.players[action.playerId];
  const pending = player.pendingAssimilateReplacements ?? [];
  const idx = pending.findIndex((p) => p.planetId === action.planetId && p.unitType === action.unitType);
  if (idx === -1) return { ok: false, error: "This player has no pending Assimilate replacement for that planet/unit type." };

  if (player.commandTokens.onBoard.includes(action.substituteSourceSystemId)) {
    return { ok: false, error: "ASSIMILATE: the substitute system cannot contain this player's own command token." };
  }
  const substituteSystem = state.systems[action.substituteSourceSystemId];
  if (!substituteSystem) return { ok: false, error: `No system ${action.substituteSourceSystemId}.` };
  const substitutePlanet = substituteSystem.planets.find((p) => (p.unitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === action.unitType && s.count > 0));
  if (!substitutePlanet) return { ok: false, error: `No ${action.unitType} of this player's own in ${action.substituteSourceSystemId} to relocate.` };

  const substituteStacks = substitutePlanet.unitsByPlayer[action.playerId] ?? [];
  const substituteStack = substituteStacks.find((s) => s.unitType === action.unitType)!;
  const updatedSubstituteStacks = substituteStacks.map((s) => (s === substituteStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
  const updatedSubstitutePlanet: PlanetState = { ...substitutePlanet, unitsByPlayer: { ...substitutePlanet.unitsByPlayer, [action.playerId]: updatedSubstituteStacks } };
  let systems: GameState["systems"] = {
    ...state.systems,
    [action.substituteSourceSystemId]: { ...substituteSystem, planets: substituteSystem.planets.map((p) => (p.planetId === substitutePlanet.planetId ? updatedSubstitutePlanet : p)) },
  };

  let destFound: { systemId: SystemId; system: SystemState; planet: PlanetState } | null = null;
  for (const [systemId, system] of Object.entries(systems)) {
    const planet = system.planets.find((p) => p.planetId === action.planetId);
    if (planet) {
      destFound = { systemId: systemId as SystemId, system, planet };
      break;
    }
  }
  if (!destFound) return { ok: false, error: `No planet ${action.planetId}.` };
  const destStacks = destFound.planet.unitsByPlayer[action.playerId] ?? [];
  const existing = destStacks.find((s) => s.unitType === action.unitType);
  const updatedDestStacks = existing ? destStacks.map((s) => (s.unitType === action.unitType ? { ...s, count: s.count + 1 } : s)) : [...destStacks, { unitType: action.unitType, count: 1, damagedCount: 0 }];
  const updatedDestPlanet: PlanetState = { ...destFound.planet, unitsByPlayer: { ...destFound.planet.unitsByPlayer, [action.playerId]: updatedDestStacks } };
  systems = { ...systems, [destFound.systemId]: { ...destFound.system, planets: destFound.system.planets.map((p) => (p.planetId === action.planetId ? updatedDestPlanet : p)) } };

  const remainingPending = [...pending.slice(0, idx), ...pending.slice(idx + 1)];
  const updatedPlayer: Player = { ...player, pendingAssimilateReplacements: remainingPending.length > 0 ? remainingPending : undefined };

  return {
    ok: true,
    state: { ...state, systems, players: { ...state.players, [action.playerId]: updatedPlayer } },
    events: [{ type: "UNITS_PRODUCED", playerId: action.playerId, systemId: destFound.systemId, planetId: action.planetId, unitType: action.unitType, count: 1, totalCost: 0 }],
  };
}

/**
 * L1Z1X "HARROW" (faction ability): "At the end of each round of ground
 * combat, your ships in the active system may use their Bombardment
 * abilities against your opponent's ground forces on the planet."
 * Confirmed (yjmrobert.com/tirules/factions/f_lizix):
 *  - Planetary Shield blocks Harrow on that planet entirely (same
 *    planetHasShield check as normal Bombardment's own — including the
 *    same war-sun/Disable exceptions, since this reuses that exact
 *    function).
 *  - Only usable by the ACTIVE player (matters for e.g. Sardakk N'orr's
 *    own G'hom Sek'kus, which can put a NON-active player into ground
 *    combat).
 *  - Usable even at the end of the round in which L1Z1X's OWN last
 *    ground force there was destroyed — may cause the combat to end in
 *    a draw.
 *  - Unlike the Bombardment STEP itself (1 unit = 1 planet), during
 *    Harrow EVERY qualifying unit in the system targets the SAME
 *    planet (achieved for free by reusing buildBombardmentEntries
 *    exactly as-is — that function already builds from every ship in
 *    the system, with no per-unit "which planet" restriction of its
 *    own; that restriction lives at the BOMBARD action's own call site
 *    instead, which this function never goes through).
 *  - X-89 Bacterial Weapon Ω/ΩΩ apply here too (already inside
 *    buildBombardmentEntries itself).
 *  - An Annihilator (mech) may Harrow even while NOT currently
 *    participating in ground combat itself — not specially handled
 *    here at all, since Harrow's own eligibility is about SHIPS in the
 *    system's space area, and a mech committed to a DIFFERENT planet's
 *    ground combat was never part of buildBombardmentEntries' own
 *    space-area scan in the first place; nothing to exclude.
 *
 * Uses the SAME 2-step flow as normal Bombardment (roll here, assign
 * hits via a follow-up ASSIGN_HARROW_HITS) rather than resolving both
 * in one call, for consistency with every other combat-roll action in
 * this project.
 */
export function useHarrow(
  state: GameState,
  action: { type: "USE_HARROW"; playerId: PlayerId; diceRolls: number[]; plasmaScoringUnitType?: UnitType },
  rules: RuleData,
): ActionResult {
  const pending = state.pendingTacticalAction;
  if (!pending || pending.playerId !== action.playerId) return { ok: false, error: "No tactical action in progress for this player." };
  if (pending.step !== "invasion" || !pending.currentInvasionPlanetId) {
    return { ok: false, error: "HARROW is only usable at the end of a ground combat round." };
  }
  if (pending.pendingHits && Object.keys(pending.pendingHits).length > 0) {
    return { ok: false, error: "Resolve the current pending hits before using HARROW." };
  }
  const player = state.players[action.playerId];
  if (player.factionId !== ("l1z1x" as never)) return { ok: false, error: "This player doesn't have HARROW." };

  const systemId = pending.systemId;
  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === pending.currentInvasionPlanetId)!;
  const defenderId = Object.keys(planet.unitsByPlayer).find((id) => id !== action.playerId) as PlayerId | undefined;
  if (!defenderId) return { ok: false, error: "No opponent's ground forces on that planet." };
  const defenderPlayer = state.players[defenderId];

  const attackerHasWarSunInSystem = (system.spaceUnitsByPlayer[action.playerId] ?? []).some((s) => s.unitType === "war_sun" && s.count > 0);
  const disableActive = state.pendingTacticalAction?.disablePlayerId === action.playerId;
  if (!disableActive && !has2ramBombardmentOverride(state, action.playerId) && planetHasShield(planet, defenderId, defenderPlayer.factionId, defenderPlayer.unitUpgrades, rules, attackerHasWarSunInSystem)) {
    return { ok: false, error: "HARROW: that planet has Planetary Shield." };
  }

  const entries = buildBombardmentEntries(state, rules, systemId, action.playerId, action.plasmaScoringUnitType, defenderId, [pending.currentInvasionPlanetId]);
  if (entries.length === 0) return { ok: false, error: "This player has no Bombardment-capable ships in this system." };

  let result;
  try {
    result = resolveCombatRound(entries, action.diceRolls);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const hits = result.hitsScoredByPlayer[action.playerId] ?? 0;
  if (hits <= 0) return { ok: true, state, events: [] };

  const nextState: GameState = { ...state, pendingTacticalAction: { ...pending, pendingHits: { ...pending.pendingHits, [defenderId]: (pending.pendingHits?.[defenderId] ?? 0) + hits } } };
  return { ok: true, state: nextState, events: [{ type: "HARROW_HITS_SCORED", playerId: action.playerId, targetPlayerId: defenderId, hits }] };
}

function findL1z1xPlayerId(state: GameState): PlayerId | undefined {
  return Object.values(state.players).find((p) => p.factionId === ("l1z1x" as never))?.id;
}

/**
 * L1Z1X "Cybernetic Enhancements" (promissory note, original): "At the
 * start of your turn: Remove 1 token from the L1Z1X player's strategy
 * pool and return it to their reinforcements. Then, place 1 command
 * token from your OWN reinforcements in your OWN strategy pool. Then,
 * return this card to the L1Z1X player." Confirmed
 * (yjmrobert.com/tirules/factions/f_lizix): "if the L1Z1X player has no
 * command tokens in their strategy pool, Cybernetic Enhancements cannot
 * be played" — a hard requirement (not a soft "if able"), same shape as
 * Xxcha's own Political Favor.
 */
export function useCyberneticEnhancements(state: GameState, action: { type: "USE_CYBERNETIC_ENHANCEMENTS"; playerId: PlayerId } ): ActionResult {
  const player = state.players[action.playerId];
  // NOTE: same "no separate id for original vs Ω" situation as Letnev's own War Funding/Arborec's own Stymie — see rules/letnev.ts's own useWarFunding for the fuller explanation. Gated here by game mode instead.
  if (!player?.promissoryNotesInHand.includes("l1z1x_promissory" as never)) {
    return { ok: false, error: "This player doesn't have Cybernetic Enhancements in hand." };
  }
  if (hasCodex(state.mode)) return { ok: false, error: "This game uses Cybernetic Enhancements Ω instead (Codex content is active)." };
  const l1z1xPlayerId = findL1z1xPlayerId(state);
  if (!l1z1xPlayerId) return { ok: false, error: "No L1Z1X player in this game." };
  const l1z1xPlayer = state.players[l1z1xPlayerId];
  if (l1z1xPlayer.commandTokens.strategy <= 0) {
    return { ok: false, error: "Cybernetic Enhancements cannot be played — the L1Z1X player has no command tokens in their strategy pool." };
  }
  const { tactic, fleet, strategy, onBoard } = player.commandTokens;
  if (tactic + fleet + strategy + onBoard.length >= 16) {
    return { ok: false, error: "This player already has all 16 of their command tokens in play." };
  }

  const updatedL1z1xPlayer: Player = {
    ...l1z1xPlayer,
    commandTokens: { ...l1z1xPlayer.commandTokens, strategy: l1z1xPlayer.commandTokens.strategy - 1 },
    promissoryNotesInHand: [...l1z1xPlayer.promissoryNotesInHand, "l1z1x_promissory" as never],
  };
  const updatedPlayer: Player = {
    ...player,
    commandTokens: { ...player.commandTokens, strategy: player.commandTokens.strategy + 1 },
    promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("l1z1x_promissory" as never)),
  };

  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer, [l1z1xPlayerId]: updatedL1z1xPlayer } },
    events: [],
  };
}

/**
 * L1Z1X "Cybernetic Enhancements Ω" (promissory note, Codex version):
 * "When you gain command tokens during the status phase: Gain 1
 * additional command token. Then, return this card to the L1Z1X
 * player." No additional confirmed rulings beyond the printed text.
 */
export function useCyberneticEnhancementsOmega(
  state: GameState,
  action: { type: "USE_CYBERNETIC_ENHANCEMENTS_OMEGA"; playerId: PlayerId; commandTokenPool: "tactic" | "fleet" | "strategy" },
): ActionResult {
  const player = state.players[action.playerId];
  if (!player?.promissoryNotesInHand.includes("l1z1x_promissory" as never)) {
    return { ok: false, error: "This player doesn't have Cybernetic Enhancements Ω in hand." };
  }
  if (!hasCodex(state.mode)) return { ok: false, error: "This game uses the original Cybernetic Enhancements instead (Codex content isn't active)." };
  const l1z1xPlayerId = findL1z1xPlayerId(state);
  if (!l1z1xPlayerId) return { ok: false, error: "No L1Z1X player in this game." };

  const { tactic, fleet, strategy, onBoard } = player.commandTokens;
  if (tactic + fleet + strategy + onBoard.length >= 16) {
    return { ok: false, error: "This player already has all 16 of their command tokens in play." };
  }

  const l1z1xPlayer = state.players[l1z1xPlayerId];
  const updatedPlayer: Player = {
    ...player,
    commandTokens: { ...player.commandTokens, [action.commandTokenPool]: player.commandTokens[action.commandTokenPool] + 1 },
    promissoryNotesInHand: player.promissoryNotesInHand.filter((id) => id !== ("l1z1x_promissory" as never)),
  };
  const updatedL1z1xPlayer: Player = { ...l1z1xPlayer, promissoryNotesInHand: [...l1z1xPlayer.promissoryNotesInHand, "l1z1x_promissory" as never] };

  return {
    ok: true,
    state: { ...state, players: { ...state.players, [action.playerId]: updatedPlayer, [l1z1xPlayerId]: updatedL1z1xPlayer } },
    events: [],
  };
}

/**
 * L1Z1X "2RAM" (commander, passive): "Units that have PLANETARY SHIELD
 * do not prevent you from using Bombardment." Confirmed
 * (yjmrobert.com/tirules/factions/f_lizix): "those units STILL have
 * Planetary Shield" (not removed — the owner can still use Magen
 * Defense Grid) — this ONLY overrides L1Z1X's OWN ability to bombard
 * THROUGH it, unlike e.g. Letnev's own Arc Secundus, which actually
 * strips the ability itself. Checked at both of this player's own
 * Bombardment call sites: phases/invasion.ts's own bombard, and this
 * file's own useHarrow above.
 */
export function has2ramBombardmentOverride(state: GameState, playerId: PlayerId): boolean {
  const player = state.players[playerId];
  const commanderEntry = player?.leaders.find((l) => l.leaderId === ("l1z1x_commander" as never));
  return !!commanderEntry && !commanderEntry.locked;
}

/**
 * L1Z1X "I48S" (agent): "After a player activates a system: You may
 * exhaust this card to allow that player to replace 1 of their
 * infantry in the active system with 1 mech from their reinforcements."
 * Confirmed (yjmrobert.com/tirules/factions/f_lizix):
 *  - "The infantry must be in the system WHEN IT IS ACTIVATED... it
 *    cannot be replaced if moved into or produced in the active system
 *    later in the turn." KNOWN SIMPLIFICATION: this project has no
 *    per-player, per-unit "present at activation" snapshot generalized
 *    beyond Arborec's own Duha Menaimon (which only tracks the
 *    FLAGSHIP specifically) — checked here against CURRENT presence
 *    instead, same "immediately after X, trusted timing" category as
 *    several other reactive abilities in this project.
 *  - Steal-from-elsewhere fallback for the mech (same as
 *    Freelancers/Letani Ospha/Dirzuga Rophal/ASSIMILATE above).
 *  - This is the AGENT-BENEFITS-ANOTHER-PLAYER pattern — ownerId
 *    (whoever holds I48S) separate from targetPlayerId (whose infantry
 *    actually gets replaced).
 */
export function useI48s(
  state: GameState,
  action: { type: "USE_I48S"; ownerId: PlayerId; targetPlayerId: PlayerId; systemId: SystemId; targetPlanetId?: PlanetId; substituteSourceSystemId?: SystemId },
): ActionResult {
  const owner = state.players[action.ownerId];
  const agentEntry = owner.leaders.find((l) => l.leaderId === ("l1z1x_agent" as never));
  if (!agentEntry) return { ok: false, error: "This player doesn't have I48S." };
  if (agentEntry.exhausted) return { ok: false, error: "I48S is already exhausted." };

  const system = state.systems[action.systemId];
  if (!system) return { ok: false, error: `No system ${action.systemId}.` };

  let infantryStacks: { unitType: UnitType; count: number; damagedCount: number }[];
  let removeInfantry: (s: { unitType: UnitType; count: number; damagedCount: number }) => GameState;
  if (action.targetPlanetId) {
    const planet = system.planets.find((p) => p.planetId === action.targetPlanetId);
    if (!planet) return { ok: false, error: `No planet ${action.targetPlanetId}.` };
    infantryStacks = planet.unitsByPlayer[action.targetPlayerId] ?? [];
    removeInfantry = (stack) => {
      const updatedStacks = infantryStacks.map((s) => (s === stack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
      const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [action.targetPlayerId]: updatedStacks } };
      return { ...state, systems: { ...state.systems, [action.systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedPlanet : p)) } } };
    };
  } else {
    infantryStacks = system.spaceUnitsByPlayer[action.targetPlayerId] ?? [];
    removeInfantry = (stack) => {
      const updatedStacks = infantryStacks.map((s) => (s === stack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
      return { ...state, systems: { ...state.systems, [action.systemId]: { ...system, spaceUnitsByPlayer: { ...system.spaceUnitsByPlayer, [action.targetPlayerId]: updatedStacks } } } };
    };
  }
  const infantryStack = infantryStacks.find((s) => s.unitType === "infantry" && s.count > 0);
  if (!infantryStack) return { ok: false, error: "That player has no infantry there to replace." };

  let nextState = removeInfantry(infantryStack);

  const reinforcementsCheck = checkReinforcementsAvailable(nextState, action.targetPlayerId, [{ unitType: "mech", count: 1 }]);
  if (!reinforcementsCheck.ok) {
    if (!action.substituteSourceSystemId) return reinforcementsCheck;
    const target = state.players[action.targetPlayerId];
    if (target.commandTokens.onBoard.includes(action.substituteSourceSystemId)) {
      return { ok: false, error: "I48S: the substitute system cannot contain this player's own command token." };
    }
    const substituteSystem = nextState.systems[action.substituteSourceSystemId];
    if (!substituteSystem) return { ok: false, error: `No system ${action.substituteSourceSystemId}.` };
    const substitutePlanet = substituteSystem.planets.find((p) => (p.unitsByPlayer[action.targetPlayerId] ?? []).some((s) => s.unitType === "mech" && s.count > 0));
    const substituteStacks = substitutePlanet ? substitutePlanet.unitsByPlayer[action.targetPlayerId] ?? [] : substituteSystem.spaceUnitsByPlayer[action.targetPlayerId] ?? [];
    const substituteStack = substituteStacks.find((s) => s.unitType === "mech" && s.count > 0);
    if (!substituteStack) return { ok: false, error: `No mech of this player's own in ${action.substituteSourceSystemId} to relocate.` };
    const updatedSubstituteStacks = substituteStacks.map((s) => (s === substituteStack ? { ...s, count: s.count - 1 } : s)).filter((s) => s.count > 0);
    if (substitutePlanet) {
      const updatedSubstitutePlanet: PlanetState = { ...substitutePlanet, unitsByPlayer: { ...substitutePlanet.unitsByPlayer, [action.targetPlayerId]: updatedSubstituteStacks } };
      nextState = { ...nextState, systems: { ...nextState.systems, [action.substituteSourceSystemId]: { ...substituteSystem, planets: substituteSystem.planets.map((p) => (p.planetId === substitutePlanet.planetId ? updatedSubstitutePlanet : p)) } } };
    } else {
      nextState = { ...nextState, systems: { ...nextState.systems, [action.substituteSourceSystemId]: { ...substituteSystem, spaceUnitsByPlayer: { ...substituteSystem.spaceUnitsByPlayer, [action.targetPlayerId]: updatedSubstituteStacks } } } };
    }
  }

  const finalSystem = nextState.systems[action.systemId];
  if (action.targetPlanetId) {
    const finalPlanet = finalSystem.planets.find((p) => p.planetId === action.targetPlanetId)!;
    const destStacks = finalPlanet.unitsByPlayer[action.targetPlayerId] ?? [];
    const existing = destStacks.find((s) => s.unitType === "mech");
    const updatedDestStacks = existing ? destStacks.map((s) => (s.unitType === "mech" ? { ...s, count: s.count + 1 } : s)) : [...destStacks, { unitType: "mech" as const, count: 1, damagedCount: 0 }];
    const updatedFinalPlanet: PlanetState = { ...finalPlanet, unitsByPlayer: { ...finalPlanet.unitsByPlayer, [action.targetPlayerId]: updatedDestStacks } };
    nextState = { ...nextState, systems: { ...nextState.systems, [action.systemId]: { ...finalSystem, planets: finalSystem.planets.map((p) => (p.planetId === action.targetPlanetId ? updatedFinalPlanet : p)) } } };
  } else {
    const destStacks = finalSystem.spaceUnitsByPlayer[action.targetPlayerId] ?? [];
    const existing = destStacks.find((s) => s.unitType === "mech");
    const updatedDestStacks = existing ? destStacks.map((s) => (s.unitType === "mech" ? { ...s, count: s.count + 1 } : s)) : [...destStacks, { unitType: "mech" as const, count: 1, damagedCount: 0 }];
    nextState = { ...nextState, systems: { ...nextState.systems, [action.systemId]: { ...finalSystem, spaceUnitsByPlayer: { ...finalSystem.spaceUnitsByPlayer, [action.targetPlayerId]: updatedDestStacks } } } };
  }

  nextState = { ...nextState, players: { ...nextState.players, [action.ownerId]: { ...owner, leaders: owner.leaders.map((l) => (l.leaderId === ("l1z1x_agent" as never) ? { ...l, exhausted: true } : l)) } } };

  return { ok: true, state: nextState, events: [{ type: "UNITS_PRODUCED", playerId: action.targetPlayerId, systemId: action.systemId, unitType: "mech", count: 1, totalCost: 0 }] };
}

/**
 * L1Z1X "The Helmsman — DARK SPACE NAVIGATION" (hero, single-use):
 * "ACTION: Choose 1 system that does not contain other players' ships;
 * you may move your flagship and any number of your dreadnoughts from
 * other systems into the chosen system. Then, purge this card."
 * Confirmed (yjmrobert.com/tirules/factions/f_lizix):
 *  - Ships in systems WITH this player's own command token may move.
 *  - Ships may transport units only if their OWN origin system does
 *    NOT contain this player's own command token.
 *  - Ships move directly (no intermediate hops) and may only transport
 *    from their own origin system.
 *  - Cannot move into a nebula or supernova; may move into an asteroid
 *    field only with Antimass Deflectors.
 *  - Can activate the Wormhole Nexus if used to move there while
 *    inactive.
 *
 * KNOWN SIMPLIFICATION: gravity-rift removal rolls for ships moved out
 * of one aren't applied here — this project's own gravity-rift-roll
 * plumbing is normally driven by the NORMAL move-ships flow (checked
 * per-ship there), which this standalone hero action bypasses entirely
 * rather than routing through; flagged rather than silently correct.
 */
export function useTheHelmsman(
  state: GameState,
  action: {
    type: "USE_THE_HELMSMAN";
    playerId: PlayerId;
    targetSystemId: SystemId;
    moves: { fromSystemId: SystemId; unitType: "flagship" | "dreadnought"; count: number; transportedUnits?: { unitType: import("../types/enums").UnitType; count: number }[] }[];
  },
  rules: RuleData,
): ActionResult {
  const player = state.players[action.playerId];
  const heroEntry = player.leaders.find((l) => l.leaderId === ("l1z1x_hero" as never));
  if (!heroEntry || heroEntry.locked) return { ok: false, error: "This player doesn't have an unlocked The Helmsman." };

  const targetSystem = state.systems[action.targetSystemId];
  if (!targetSystem) return { ok: false, error: `No system ${action.targetSystemId}.` };
  if (Object.entries(targetSystem.spaceUnitsByPlayer).some(([pid, stacks]) => pid !== action.playerId && (stacks ?? []).some((s) => s.count > 0))) {
    return { ok: false, error: "The Helmsman: the chosen system cannot contain other players' ships." };
  }
  if (targetSystem.anomalies?.includes("nebula" as never) || targetSystem.anomalies?.includes("supernova" as never)) {
    return { ok: false, error: "The Helmsman: cannot move into a nebula or supernova." };
  }
  if (targetSystem.anomalies?.includes("asteroid_field" as never) && !player.technologies.includes("antimass_deflectors" as never)) {
    return { ok: false, error: "The Helmsman: moving into an asteroid field requires Antimass Deflectors." };
  }

  let nextState: GameState = state;
  const events: GameEvent[] = [];
  let targetSpaceStacks = (nextState.systems[action.targetSystemId]?.spaceUnitsByPlayer[action.playerId] ?? []).map((s) => ({ ...s }));

  for (const move of action.moves) {
    if (move.count <= 0) continue;
    if (!player.commandTokens.onBoard.includes(move.fromSystemId)) {
      return { ok: false, error: `The Helmsman: this player has no command token in ${move.fromSystemId} — those ships can't move.` };
    }
    const fromSystem = nextState.systems[move.fromSystemId];
    if (!fromSystem) return { ok: false, error: `No system ${move.fromSystemId}.` };
    const stacks = fromSystem.spaceUnitsByPlayer[action.playerId] ?? [];
    const stack = stacks.find((s) => s.unitType === move.unitType && s.count > 0);
    if (!stack || stack.count < move.count) return { ok: false, error: `Not enough ${move.unitType} in ${move.fromSystemId}.` };
    if (move.unitType === "flagship" && move.count > 1) return { ok: false, error: "Only 1 flagship can move." };

    const updatedFromStacks = stacks.map((s) => (s === stack ? { ...s, count: s.count - move.count } : s)).filter((s) => s.count > 0);
    let updatedFromSystem: SystemState = { ...fromSystem, spaceUnitsByPlayer: { ...fromSystem.spaceUnitsByPlayer, [action.playerId]: updatedFromStacks } };

    if (move.transportedUnits && move.transportedUnits.length > 0) {
      if (player.commandTokens.onBoard.includes(move.fromSystemId)) {
        return { ok: false, error: `The Helmsman: cannot transport from ${move.fromSystemId} — it contains this player's own command token.` };
      }
      for (const { unitType, count } of move.transportedUnits) {
        if (count <= 0) continue;
        // Ground forces sitting in the origin system's own space area (already-loaded cargo) — moved alongside the ship.
        const cargoStacks = updatedFromSystem.spaceUnitsByPlayer[action.playerId] ?? [];
        const cargoStack = cargoStacks.find((s) => s.unitType === unitType && s.count > 0);
        if (!cargoStack || cargoStack.count < count) return { ok: false, error: `Not enough ${unitType} in ${move.fromSystemId}'s space area to transport.` };
        const updatedCargoStacks = cargoStacks.map((s) => (s === cargoStack ? { ...s, count: s.count - count } : s)).filter((s) => s.count > 0);
        updatedFromSystem = { ...updatedFromSystem, spaceUnitsByPlayer: { ...updatedFromSystem.spaceUnitsByPlayer, [action.playerId]: updatedCargoStacks } };
        const existingTarget = targetSpaceStacks.find((s) => s.unitType === unitType);
        if (existingTarget) existingTarget.count += count;
        else targetSpaceStacks.push({ unitType, count, damagedCount: 0 });
      }
    }

    nextState = { ...nextState, systems: { ...nextState.systems, [move.fromSystemId]: updatedFromSystem } };
    const existingTargetShip = targetSpaceStacks.find((s) => s.unitType === move.unitType);
    if (existingTargetShip) existingTargetShip.count += move.count;
    else targetSpaceStacks.push({ unitType: move.unitType, count: move.count, damagedCount: 0 });
    events.push({ type: "SHIPS_MOVED", playerId: action.playerId, toSystemId: action.targetSystemId });
  }

  nextState = {
    ...nextState,
    systems: { ...nextState.systems, [action.targetSystemId]: { ...nextState.systems[action.targetSystemId], spaceUnitsByPlayer: { ...nextState.systems[action.targetSystemId].spaceUnitsByPlayer, [action.playerId]: targetSpaceStacks } } },
    players: { ...nextState.players, [action.playerId]: { ...nextState.players[action.playerId], leaders: nextState.players[action.playerId].leaders.filter((l) => l.leaderId !== ("l1z1x_hero" as never)) } },
  };

  return { ok: true, state: nextState, events };
}

/**
 * L1Z1X "Fealty Uplink" (Breakthrough ability): "When you gain control
 * of a planet, place infantry from your reinforcements equal to that
 * planet's influence value on that planet." Confirmed
 * (yjmrobert.com/tirules/factions/f_lizix): (1) for an uncontrolled
 * planet, this player may choose whether to place the infantry BEFORE
 * or AFTER exploring it — not applicable to this function directly
 * (an ordering choice for the CALLER of setPlanetController, not this
 * function's own concern); (2) mandatory (not "may").
 */
export function applyFealtyUplink(state: GameState, playerId: PlayerId, systemId: SystemId, planetId: PlanetId, rules: RuleData): GameState {
  const player = state.players[playerId];
  if (!player.hasBreakthrough || player.factionId !== ("l1z1x" as never)) return state;
  const influenceValue = rules.planets[planetId]?.influence ?? 0;
  if (influenceValue <= 0) return state;

  const system = state.systems[systemId];
  const planet = system.planets.find((p) => p.planetId === planetId);
  if (!planet) return state;

  const stacks = planet.unitsByPlayer[playerId] ?? [];
  const existing = stacks.find((s) => s.unitType === "infantry");
  const updatedStacks = existing ? stacks.map((s) => (s.unitType === "infantry" ? { ...s, count: s.count + influenceValue } : s)) : [...stacks, { unitType: "infantry" as const, count: influenceValue, damagedCount: 0 }];
  const updatedPlanet: PlanetState = { ...planet, unitsByPlayer: { ...planet.unitsByPlayer, [playerId]: updatedStacks } };
  return { ...state, systems: { ...state.systems, [systemId]: { ...system, planets: system.planets.map((p) => (p.planetId === planetId ? updatedPlanet : p)) } } };
}
