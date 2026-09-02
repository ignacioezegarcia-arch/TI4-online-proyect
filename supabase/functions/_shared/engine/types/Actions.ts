import { AgendaPredictionReward } from "./GameState";
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
import { UnitType, ObjectiveKind, WormholeType } from "./enums";

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
  | {
      type: "CHOOSE_STRATEGY_CARD";
      playerId: PlayerId;
      cardId: StrategyCardId;
      /** RR "Checks and Balances" ("for"): while this law is active, the chosen card doesn't stay with the choosing player — it must go to another player who doesn't yet have their full strategy-card count for the round, if any such player exists. This is the choosing player's own pick of WHO receives it; ignored entirely when the law isn't active. */
      giveToPlayerId?: PlayerId;
    }

  // --- Action phase / turn structure (RR 3) ---
  | {
      type: "PASS";
      playerId: PlayerId;
      /** RR "when you pass" legendary planet abilities (Ordinian/4X41D Hyperion VI, Faunus/Maxis Central Control, Garbozia/Dok'N Pic's Salvage Yard's own store half, Industrex/Aeurex Mechanica) — genuinely tied to the moment of passing itself, unlike the generic "EXHAUST:" any-time abilities (The Atrament, Imperial Arms Vault, Exterrix Headquarters) or the "at the end of your turn" ones (The Acropolis, The Galactic Council — those use the end_of_turn window instead, since passing itself isn't required for them). Optional — a player passing without one of these planets, or choosing not to use it, simply omits this. */
      whenYouPassAbility?:
        | { kind: "4x41d_hyperion_vi"; commandTokenPool: "tactic" | "fleet" | "strategy" }
        | { kind: "maxis_central_control"; targetPlanetId: PlanetId; chosenTrait?: "cultural" | "industrial" | "hazardous" }
        | { kind: "dok_n_pics_salvage_yard_store"; cardId: string }
        | { kind: "aeurex_mechanica"; unitUpgradeId: UnitUpgradeId; targetSystemId: SystemId };
    }

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
        /**
         * RR "Gravity Rift" (yjmrobert.com/tirules/rules/r_gravity_rift):
         * "A ship that will move out of or through a gravity rift at
         * any time during its movement" — additional gravity-rift
         * systems (other than fromSystemId itself, checked
         * automatically) this move's own actual chosen path visits as a
         * mid-path hop. Each declared system is validated as an actually
         * reachable waypoint within this move's own effective move
         * budget (reusing canShipReachSystem's own mustPassThroughSystemId
         * parameter — the same mechanism Muaat's own Stellar Genesis
         * breakthrough already uses for Avernus) before being trusted;
         * this project still doesn't track a move's full literal path,
         * so a validated-reachable claim is trusted the same way this
         * project already trusts other caller-supplied choices, rather
         * than proving it's the ONE path taken.
         */
        passesThroughRiftSystemIds?: SystemId[];
      }[];
      /** Ground forces picked up along the way per RR 84.1 — kept separate from ship moves because capacity is checked against these, not against ships. Must come from the same fromSystemId as one of the `moves` entries above (multi-hop pickup along the path isn't supported yet — flagged in moveShips). */
      transportedGroundForces?: { fromSystemId: SystemId; unitType: "infantry" | "mech"; count: number }[];
      transportedFighters?: { fromSystemId: SystemId; count: number }[];
      /** RR "Gravity Drive": exhaust that tech (if owned and readied) to apply +1 move value to ONE of the moves entries above (identified by its fromSystemId) for this tactical action only. */
      gravityDriveBoostFromSystemId?: SystemId;
      /** TE "Ionian Fuel Refinery" (Tempesta's own legendary planet ability): same "+1 to one specific moves-entry" shape as Gravity Drive above, but exhausts the ability card instead of being a repeatable tech. */
      ionianFuelRefineryBoostFromSystemId?: SystemId;
      /** Winnu "Imperator" (Breakthrough ability): this player's own choice of which `moves` entry (by its own fromSystemId) gets the +1 granted by activating a system with a legendary planet this same tactical action — see phases/tacticalAction.ts's own moveShips for the full doc comment. */
      imperatorMoveBonusFromSystemId?: SystemId;
      /** RR "Dominus Orb" (relic): purges the card to bypass the normal reachability/adjacency check entirely for any move whose fromSystemId has this player's own command token. */
      useDominusOrb?: boolean;
      /** Muaat "Stellar Genesis" breakthrough ability: if a war sun's own path this action visits Avernus's system (as its literal origin OR a mid-path hop — properly tracked via canShipReachSystem's own mustPassThroughSystemId parameter, not just a direct-origin check), setting this brings Avernus's token along to the final destination — never into a home system. */
      relocateAvernusWithWarSun?: boolean;
      /**
       * RR "Gravity Rift" (yjmrobert.com/tirules/rules/r_gravity_rift):
       * "one die is rolled immediately before it exits the gravity rift
       * system... on a result of 1-3, that ship is removed." One entry
       * per (fromSystemId, unitType, riftSystemId) combination that
       * actually applies to a `moves` entry — riftSystemId is either
       * that move's own fromSystemId (moving OUT of a rift) or one of
       * its own declared passesThroughRiftSystemIds (a validated
       * mid-path hop). "A gravity rift can affect the same ship
       * multiple times" (note 6) — if a move passes through 2 different
       * rift systems, it needs 2 separate entries here, each with its
       * OWN roll per ship, and `rolls[i]` must consistently refer to the
       * SAME i-th physical ship across every entry sharing the same
       * (fromSystemId, unitType) — this is what lets a ship that
       * survives rift A's roll still be correctly tracked into rift B's
       * own roll. Exactly `move.count` pre-rolled dice per entry, same
       * trusted-RNG convention as RESOLVE_COMBAT_ROUND/USE_SPACE_CANNON_OFFENSE
       * above.
       */
      gravityRiftDieRolls?: { fromSystemId: SystemId; unitType: UnitType; riftSystemId: SystemId; rolls: number[] }[];
      /**
       * RR "Gravity Rift", note 2: "units being transported are removed
       * from the board if the ship transporting them is removed."
       * Confirmed (yjmrobert.com/tirules/rules/r_gravity_rift) — this
       * engine has no per-instance ship-to-cargo binding by default (all
       * cargo is tracked as a system-wide aggregate), so this is the
       * caller's own explicit declaration of which specific ship
       * (matching `gravityRiftDieRolls`' own per-ship index ordering for
       * that SAME fromSystemId + carrier unitType) is carrying how much
       * of each cargo type, for the sole purpose of resolving THIS
       * gravity-rift removal correctly. One entry per (fromSystemId,
       * carrier unitType) pair that both has capacity and is subject to
       * a gravity-rift roll this move.
       */
      gravityRiftCargoAssignments?: {
        fromSystemId: SystemId;
        carrierUnitType: UnitType;
        cargo: { unitType: "fighter" | "infantry" | "mech"; countsPerShip: number[] }[];
      }[];
    }
  | {
      type: "USE_SPACE_CANNON_OFFENSE";
      playerId: PlayerId;
      /** Pre-rolled dice, same trusted-RNG convention as RESOLVE_COMBAT_ROUND — see that action's doc comment. One dice-group per qualifying unit TYPE (not just PDS — some faction units carry Space Cannon too), each in the active system plus any range-upgraded (e.g. PDS II) in an adjacent system. RR 77. */
      diceRolls: number[];
      /** RR "Plasma Scoring": which of this player's qualifying unit types gets the +1 die — only matters if they own the tech and have 2+ types with different hitOn values. Ignored otherwise. */
      plasmaScoringUnitType?: UnitType;
      /** RR "Graviton Laser System": exhaust that tech (if owned and readied) before firing, so the active player's assignment of these hits must go to non-fighter ships first, while any remain. Only meaningful here — Space Cannon Defense fires at ground forces, never fighters. */
      useGravitonLaserSystem?: boolean;
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
      type: "REMOVE_EXCESS_CAPACITY_UNITS";
      playerId: PlayerId;
      /** RR 16.3/78.10a: right when space combat ends, the winner's own choice of which fighters/ground forces to remove — total must exactly match PendingTacticalAction.pendingCapacityOverflow's own excessCount. */
      removals: { unitType: UnitType; count: number }[];
    }
  | {
      type: "USE_ASSAULT_CANNON_DESTRUCTION";
      playerId: PlayerId;
      /** RR "Assault Cannon": mandatory (no skip) — the player's own choice of WHICH non-fighter ship type to destroy, only offered while PendingTacticalAction.assaultCannonPendingPlayer names them. */
      unitType: UnitType;
    }
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
      /** The Argent Flight "Strike Wing Ambuscade" (promissory note) / "Trrakan Aun Zulok" (commander): "+1 die to this roll" — see rules/combat.ts's own buildAntiFighterBarrageEntries for the full doc comment. diceRolls above must already include this extra die when set. */
      useUnitAbilityDieBonusSource?: "ambuscade" | "trrakan_zulok";
    }
  | {
      type: "ASSIGN_ANTI_FIGHTER_BARRAGE_HITS";
      playerId: PlayerId;
      /** Same destroy/flip shape as ASSIGN_HITS, but every unitType here MUST be "fighter" — AFB can't hit anything else. RR 67.1/76. */
      assignments: { unitType: UnitType; outcome: "destroy" | "flip" }[];
    }
  | { type: "USE_RAID_FORMATION"; playerId: PlayerId; targetUnitTypes: UnitType[] } // The Argent Flight's own faction ability — see rules/argent.ts
  | {
      type: "USE_HELIX_PROTOCOL";
      playerId: PlayerId;
      moves: { fromSystemId: SystemId; toSystemId: SystemId; unitType: UnitType; count: number }[];
      transportedGroundForces?: { fromSystemId: SystemId; toSystemId: SystemId; unitType: "infantry" | "mech"; count: number }[];
      transportedFighters?: { fromSystemId: SystemId; toSystemId: SystemId; count: number }[];
      gravityRiftDieRolls?: { fromSystemId: SystemId; unitType: UnitType; rolls: number[] }[];
    } // The Argent Flight's own hero — see rules/argent.ts
  | { type: "USE_PLACE_WING_TRANSFER_TOKENS"; playerId: PlayerId; targetSystemIds: SystemId[] } // The Argent Flight's own Breakthrough ability — see rules/argent.ts
  | { type: "USE_WING_TRANSFER_MOVE"; playerId: PlayerId; fromSystemId: SystemId; toSystemId: SystemId; unitType: UnitType; count: number } // The Argent Flight's own Breakthrough ability — see rules/argent.ts
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
      /** Sol "Evelyn DeLouis" (agent): "you may exhaust this card to choose 1 ground force in the active system; that ground force rolls 1 additional die during that combat round." Ground-combat-only (never applies to space combat's own use of this same action type) — see phases/invasion.ts's own resolveGroundCombatRound. ownerId (whoever holds Evelyn — need not be a combatant) is separate from targetPlayerId (whose unit actually benefits, must be a combatant) — an agent's ability can benefit ANY player, not just its own owner. */
      evelynDelouisBonus?: { ownerId: PlayerId; targetPlayerId: PlayerId; unitType: "infantry" | "mech" };
      /** Letnev "Viscount Unlenn" (agent): same idea as Evelyn DeLouis above, but for ships/space combat — see phases/spaceCombat.ts's own resolveSpaceCombatRound. */
      /** Letnev "Viscount Unlenn" (agent): same idea as Evelyn DeLouis above, but for ships/space combat — see phases/spaceCombat.ts's own resolveSpaceCombatRound. ownerId/targetPlayerId separated the same way (an agent's ability can benefit ANY player, not just its own owner). */
      viscountUnlennBonus?: { ownerId: PlayerId; targetPlayerId: PlayerId; unitType: UnitType };
      /** Letnev "Gravleash Maneuvers" (breakthrough): "apply +X to the results of 1 of your ship's rolls, where X is the number of ship types you have in the combat" — the CALLER just names which unit type gets the boosted die; X itself is computed server-side from the actual board state. Space-combat-only. */
      gravleashManeuversUnitType?: UnitType;
      /** Hacan "Wrath of Kenara" (flagship, Trade Good Bonus): trusted-input, same as every other roll here — see phases/spaceCombat.ts's own resolveSpaceCombatRound for the full doc comment. */
      wrathOfKenaraTradeGoodsSpent?: number;
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
      /** Sol "Spec Ops II" (RESPAWN, ground combat only): 1 pre-rolled die per Spec Ops infantry actually destroyed by this SAME assignment — trusted-RNG, same convention as every other roll. See phases/invasion.ts's own assignGroundCombatHits. */
      specOpsRespawnDieRolls?: number[];
    }
  | {
      type: "BOMBARD";
      playerId: PlayerId;
      targetPlanetId: PlanetId;
      /** Pre-rolled dice, same trusted-RNG convention as RESOLVE_COMBAT_ROUND — see that action's doc comment. Order: iterate the bombarding player's bombardment-capable ship stacks in the order they appear in the system's spaceUnitsByPlayer, abilityValues.bombardment.dice dice per unit in the stack. RR 44.1 / 15. */
      diceRolls: number[];
      /** RR "Plasma Scoring": which of this player's Bombardment-capable unit types gets the +1 die — the player's own choice, only relevant if they own the tech and have 2+ qualifying types with different hitOn values. Ignored otherwise. */
      plasmaScoringUnitType?: UnitType;
      /** TE COEXIST: which defender this roll targets, required when the target planet has more than 1 defending player (a coexisting pair) — each gets bombarded with their own separate roll. Optional/ignored when there's exactly 1 defender. */
      targetPlayerId?: PlayerId;
      /** Jol-Nar "Ta Zern" (commander, passive): applied inline right after this same bombardment's own initial roll resolves — see phases/invasion.ts's own bombard for the full doc comment, including its own single-target scope limit. */
      taZernRerolls?: { unitType: UnitType; newRolls: number[] }[];
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
      /** TE COEXIST: if this player has an ability granting the choice (see rules/abilities.ts's own hasAbility) and their own units on this planet aren't already coexisting, they may choose this instead of triggering ground combat. */
      coexist?: boolean;
      /** TE DUAL PLANET TRAITS: required if this planet has never been controlled and has 2 traits — see phases/invasion.ts's own commitGroundForces for exactly when this is checked/banked. */
      chosenTrait?: "cultural" | "industrial" | "hazardous";
      /** Same "banked now, consumed once control is actually established" shape as chosenTrait above — this player's own choice for whatever exploration card gets drawn once this planet is actually gained, whether immediately (uncontested) or after combat concludes (contested). */
      explorationChoice?: import("../phases/exploration").ExplorationCardChoice;
    } // RR 44.2: moves ground forces from the active system's space area onto a planet there.
  | {
      type: "INITIATE_COEXIST_COMBAT";
      playerId: PlayerId;
      planetId: PlanetId;
      /** TE COEXIST: which coexisting party to attack — only required when the CONTROLLER is attacking and there's more than 1 coexisting party present. See phases/invasion.ts's own initiateCoexistCombat. */
      targetPlayerId?: PlayerId;
    }
  | {
      type: "CLAIM_EXPEDITION_SLICE";
      playerId: PlayerId;
      slice: import("./enums").ThunderEdgeExpeditionSliceCost;
      exhaustPlanetIds?: PlanetId[];
      discardActionCardIds?: string[];
      discardSecretObjectiveId?: string;
      exhaustTechSpecialtyPlanetId?: PlanetId;
      fractureDieRoll?: number;
      /** Yin Brotherhood "Yin Ascendant": which faction's alliance ability this player's own random pick landed on, only consulted if this player's faction is Yin and this claim is what actually grants their breakthrough — see rules/yin.ts's own grantYinAscendant doc comment. */
      randomFactionIdForYinAscendant?: string;
    } // TE Thunder's Edge Expedition — see phases/expedition.ts's own claimExpeditionSlice.
  | {
      type: "COMPLETE_THUNDER_EDGE_EXPEDITION";
      playerId: PlayerId;
      targetSystemId: SystemId;
      infantryPlacingPlayerId?: PlayerId;
      /** Trusted-RNG input for grantBreakthrough's own Fracture-roll, since completing the expedition also grants the breakthrough (via Jupiter Brain, Thunder's Edge's own legendary ability) if the placing player doesn't already have it. */
      fractureDieRoll?: number;
      /** Yin Brotherhood "Yin Ascendant": same as CLAIM_EXPEDITION_SLICE's own field above — see rules/yin.ts's own grantYinAscendant doc comment. */
      randomFactionIdForYinAscendant?: string;
    } // TE Thunder's Edge Expedition completion — see phases/expedition.ts's own completeThunderEdgeExpedition.
  | {
      type: "PLACE_INGRESS_TOKENS";
      playerId: PlayerId;
      systemIds: SystemId[];
    } // TE The Fracture — see phases/theFracture.ts's own placeIngressTokens.
  | {
      type: "CONVERT_COMMODITIES_VIA_SPACE_STATION";
      playerId: PlayerId;
      spaceStationPlanetId: PlanetId;
    } // TE SPACE STATIONS — see rules/spaceStations.ts's own convertCommoditiesViaSpaceStation.
  | {
      type: "GAIN_FACTION_TECH_VIA_ENTROPIC_SCAR";
      playerId: PlayerId;
      techId: TechId;
    } // TE ENTROPIC SCAR — see phases/entropicScar.ts's own gainFactionTechViaEntropicScar.
  | {
      type: "USE_REMOVE_CUSTODIANS_TOKEN";
      playerId: PlayerId;
      /** RR 27.2: pays exactly 6 influence (falls back to trade goods for any shortfall). */
      exhaustPlanetIdsForInfluence: PlanetId[];
      /** RR 27.2: must total at least 1 ground force — landed on Mecatol Rex as part of this same action. */
      units: { unitType: UnitType; count: number }[];
    }
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
  | { type: "USE_MAGEN_DEFENSE_GRID"; playerId: PlayerId } // base version (base-mode games only): exhausts the tech; the attacker can't roll any combat dice this ground combat round
  | { type: "SKIP_MAGEN_DEFENSE_GRID"; playerId: PlayerId } // declines the block even though eligible
  | {
      type: "ASSIGN_MAGEN_DEFENSE_GRID_HIT";
      playerId: PlayerId;
      /** ΩΩ version (everywhere except base-only games): NOT optional and doesn't exhaust anything — the defender's own choice of WHICH attacker unit absorbs the automatic hit. */
      assignment: { unitType: UnitType; outcome: "destroy" | "flip" };
    }
  | {
      type: "PRODUCE_UNITS";
      playerId: PlayerId;
      /** Optional (rather than the normal required planet) only for Clan of Saar producing from a Floating Factory sitting in the system's own space area — see phases/production.ts's own executeProduction for the full doc comment on this whole mechanic. */
      planetId?: PlanetId;
      units: { unitType: UnitType; count: number }[];
      /** RR "AI Development Algorithm"'s OTHER ability (distinct from its unit-upgrade-research one, but shares the same exhausted state): exhaust to reduce this production's combined cost by the number of unit upgrade technologies this player owns. */
      useAiDevelopmentAlgorithmForCost?: boolean;
      /** Hacan "Harrugh Gefhara — GALACTIC SECURITIES NET" (hero, single-use): reduces this production's own cost to 0 — see phases/production.ts's own executeProduction for the full doc comment. */
      useHarrughGefharaBonus?: boolean;
      /** RR 26: which of this player's own controlled, unexhausted planets to exhaust for this production's own resource cost — same shape as RESEARCH_TECHNOLOGY's own field below, both now backed by the exact same phases/technology.ts's own spendForCost. */
      exhaustPlanetIdsForResources?: PlanetId[];
      /** "Freelancers" (exploration card): "you may spend influence as if it were resources to produce this unit" — validated against this player's own real pending grant for this system, see phases/production.ts's own executeProduction. */
      freelancersActive?: boolean;
      /** "Freelancers": only consulted if reinforcements are empty for the unit type — see phases/production.ts's own executeProduction for the full substitution-rule doc comment. */
      freelancersSubstituteSourceSystemId?: SystemId;
      /** Naalu Collective "M'aban" (commander): "+1 free fighter, doesn't count against the Production limit" — see phases/production.ts's own executeProduction for the full doc comment. */
      useMabanBonusFighter?: boolean;
      /** Clan of Saar "Floating Factory": the player's own choice of where ground forces produced this way land — a specific controlled planet in this system, or omitted for the space area (the default) — see phases/production.ts's own executeProduction for the full doc comment. */
      floatingFactoryGroundForceDestinationPlanetId?: PlanetId;
      /** Yin Brotherhood "Yin Spinner" (faction technology): which controlled planet in this SAME system gets the 1 free infantry — see phases/production.ts's own executeProduction for the full doc comment. */
      useYinSpinnerDestination?: PlanetId;
      /** Yin Brotherhood "Yin Spinner Ω" (faction technology): up to 2 destinations (a controlled planet, or the system's own space area if omitting planetId) — see phases/production.ts's own executeProduction for the full doc comment. */
      useYinSpinnerOmegaDestination?: { planetId?: PlanetId };
      /** Yin Brotherhood "Brother Omar" (commander, base version): opts into the +1 free infantry bonus this batch — see phases/production.ts's own executeProduction for the full doc comment. */
      useBrotherOmarBonusInfantry?: boolean;
      /** The Argent Flight "Trilossa Aun Mirik" (agent): where to relocate this batch's just-produced ground forces — see phases/production.ts's own executeProduction for the full doc comment. */
      useTrilossaAunMirikDestination?: { systemId: SystemId; planetId: PlanetId };
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
      /** Only reached for a card that does NOT yet have its own dedicated PLAY_<CARD_NAME> action below — does the shared mechanical bookkeeping (hand -> discard) without resolving any printed effect. Once a card gets its own action type (see "Action card individual effects" below), clients should submit THAT instead of this. */
      payload?: unknown;
    }
  | {
      type: "DISCARD_ACTION_CARD";
      playerId: PlayerId;
      cardId: ActionCardId;
      /** RR 2.4-adjacent: voluntary discard — hand-limit compliance, or discarding for its own sake (e.g. the "discard N action cards" secret objective). Distinct from PLAY_ACTION_CARD's own discard-after-use, which does NOT count toward that objective's tally (see Player.actionCardsDiscardedCount's own doc comment). */
    }

  // --- Action card individual effects (RR 2) ---
  // Each is fully self-contained (hand removal + discard + effect) rather
  // than composing with PLAY_ACTION_CARD, since a card's own legality
  // checks (e.g. Uprising needing a valid non-home target) must run BEFORE
  // the card leaves the player's hand. See phases/actionCardEffects.ts's
  // own header comment for why this mirrors technologyAbilities.ts's
  // "one GameAction per ability" shape rather than a generic dispatcher.
  | { type: "PLAY_MINING_INITIATIVE"; playerId: PlayerId; planetId: PlanetId }
  | { type: "PLAY_INDUSTRIAL_INITIATIVE"; playerId: PlayerId }
  | { type: "PLAY_ECONOMIC_INITIATIVE"; playerId: PlayerId }
  | { type: "PLAY_UPRISING"; playerId: PlayerId; planetId: PlanetId }
  | { type: "PLAY_FOCUSED_RESEARCH"; playerId: PlayerId; techId: TechId }
  | { type: "PLAY_IMPERSONATION"; playerId: PlayerId; exhaustPlanetIds: PlanetId[] }
  | { type: "PLAY_UNEXPECTED_ACTION"; playerId: PlayerId; systemId: SystemId }
  | { type: "PLAY_REPEAL_LAW"; playerId: PlayerId; agendaId: AgendaId }
  | { type: "PLAY_FRONTLINE_DEPLOYMENT"; playerId: PlayerId; planetId: PlanetId }
  | { type: "PLAY_RISE_OF_A_MESSIAH"; playerId: PlayerId }
  | { type: "PLAY_WAR_EFFORT"; playerId: PlayerId; systemId: SystemId; relocateFromSystemId?: SystemId }
  | { type: "PLAY_GHOST_SHIP"; playerId: PlayerId; systemId: SystemId; relocateFromSystemId?: SystemId }
  | { type: "PLAY_FIGHTER_CONSCRIPTION"; playerId: PlayerId }
  | { type: "PLAY_REFIT_TROOPS"; playerId: PlayerId; planetIds: PlanetId[] }
  | { type: "PLAY_SCUTTLE"; playerId: PlayerId; targets: { systemId: SystemId; unitType: UnitType }[] }
  | { type: "PLAY_INSUBORDINATION"; playerId: PlayerId; targetPlayerId: PlayerId }
  | { type: "PLAY_LUCKY_SHOT"; playerId: PlayerId; systemId: SystemId; targetPlayerId: PlayerId; unitType: "dreadnought" | "cruiser" | "destroyer" }
  | { type: "PLAY_REACTOR_MELTDOWN"; playerId: PlayerId; planetId: PlanetId; targetPlayerId: PlayerId }
  | { type: "PLAY_SIGNAL_JAMMING"; playerId: PlayerId; systemId: SystemId; targetPlayerId: PlayerId }
  | { type: "PLAY_SPY"; playerId: PlayerId; targetPlayerId: PlayerId }
  | { type: "PLAY_TACTICAL_BOMBARDMENT"; playerId: PlayerId; systemId: SystemId }
  | { type: "PLAY_UNSTABLE_PLANET"; playerId: PlayerId; planetId: PlanetId; targetPlayerId?: PlayerId }
  | { type: "PLAY_PLAGIARIZE"; playerId: PlayerId; targetPlayerId: PlayerId; techId: TechId; exhaustPlanetIds: PlanetId[] }
  | { type: "PLAY_ARCHAEOLOGICAL_EXPEDITION"; playerId: PlayerId; planetId: PlanetId; chosenTrait?: "cultural" | "industrial" | "hazardous" }
  | {
      type: "PLAY_DIVERT_FUNDING";
      playerId: PlayerId;
      returnedTechId: TechId;
      researchTechId: TechId;
      cost: number;
      exhaustPlanetIdsForResources: PlanetId[];
    }
  | { type: "PLAY_EXPLORATION_PROBE"; playerId: PlayerId; systemId: SystemId; choice?: import("../phases/exploration").ExplorationCardChoice }
  | { type: "PLAY_SEIZE_ARTIFACT"; playerId: PlayerId; targetPlayerId: PlayerId; fragmentType: "cultural" | "industrial" | "hazardous" | "unknown" }

  // --- RR 8 "after/when an agenda is revealed" reaction cards. Each of
  // the 8 riders below shares the "predict, can't vote, reward if right"
  // shape (see GameState.ts's own AgendaPredictionReward/PendingAgendaVote.
  // predictions doc comments) — resolved later, at agenda resolution, not
  // immediately when played.
  | { type: "PLAY_ASSASSINATE_REPRESENTATIVE"; playerId: PlayerId; targetPlayerId: PlayerId }
  | { type: "PLAY_VETO"; playerId: PlayerId }
  | { type: "PLAY_HACK_ELECTION"; playerId: PlayerId }
  | { type: "PLAY_INSIDER_INFORMATION"; playerId: PlayerId }
  | { type: "PLAY_DIPLOMATIC_PRESSURE"; playerId: PlayerId; targetPlayerId: PlayerId; promissoryNoteId: PromissoryNoteId }
  | { type: "PLAY_IMPERIAL_RIDER"; playerId: PlayerId; predictedOutcome: string }
  | { type: "PLAY_TRADE_RIDER"; playerId: PlayerId; predictedOutcome: string }
  | { type: "PLAY_LEADERSHIP_RIDER"; playerId: PlayerId; predictedOutcome: string; tactic: number; fleet: number; strategy: number }
  | { type: "PLAY_CONSTRUCTION_RIDER"; playerId: PlayerId; predictedOutcome: string; planetId: PlanetId }
  | { type: "PLAY_DIPLOMACY_RIDER"; playerId: PlayerId; predictedOutcome: string; systemId: SystemId }
  | { type: "PLAY_POLITICS_RIDER"; playerId: PlayerId; predictedOutcome: string }
  | { type: "PLAY_TECHNOLOGY_RIDER"; playerId: PlayerId; predictedOutcome: string; techId: TechId; exhaustPlanetIdsForTechSpecialty?: PlanetId[] }
  | { type: "PLAY_WARFARE_RIDER"; playerId: PlayerId; predictedOutcome: string; systemId: SystemId }
  | { type: "PLAY_SANCTION"; playerId: PlayerId; predictedOutcome: string }
  | { type: "PLAY_FLANK_SPEED"; playerId: PlayerId }
  | { type: "PLAY_IN_THE_SILENCE_OF_SPACE"; playerId: PlayerId; systemId: SystemId }
  | { type: "PLAY_LOST_STAR_CHART"; playerId: PlayerId }
  | { type: "PLAY_SOLAR_FLARE"; playerId: PlayerId }
  | { type: "PLAY_NAV_SUITE"; playerId: PlayerId }
  | { type: "PLAY_MORALE_BOOST"; playerId: PlayerId }
  | { type: "PLAY_SKILLED_RETREAT"; playerId: PlayerId; toSystemId: SystemId }
  | { type: "PLAY_BUNKER"; playerId: PlayerId }
  | { type: "PLAY_BLITZ"; playerId: PlayerId }
  /** RR (yjmrobert.com/tirules/rules/r_action_cards + Xxcha Kingdom's own Instinct Training rules): cancel another player's just-ANNOUNCED action card — legal only during the "action_card_announced" window that card's own announcement opened, never once it's already resolved (matches Instinct Training's own explicit "may only be cancelled when it is originally played" rule for riders). */
  | { type: "PLAY_SABOTAGE"; playerId: PlayerId }
  | { type: "PLAY_SUMMIT"; playerId: PlayerId }
  | { type: "PLAY_MANIPULATE_INVESTMENTS"; playerId: PlayerId; distribution: { cardId: StrategyCardId; amount: number }[] }
  | { type: "PLAY_POLITICAL_STABILITY"; playerId: PlayerId }
  | { type: "PLAY_PUBLIC_DISGRACE"; playerId: PlayerId }
  | { type: "PLAY_COUP_DETAT"; playerId: PlayerId }
  | { type: "PLAY_ANCIENT_BURIAL_SITES"; playerId: PlayerId; targetPlayerId: PlayerId }
  | { type: "PLAY_DISTINGUISHED_COUNCILOR"; playerId: PlayerId }
  | { type: "PLAY_BRIBERY"; playerId: PlayerId; tradeGoodsToSpend: number }
  | { type: "PLAY_CONFUSING_LEGAL_TEXT"; playerId: PlayerId; newElectedPlayerId: PlayerId }
  | { type: "PLAY_CONFOUNDING_LEGAL_TEXT"; playerId: PlayerId }
  | { type: "PLAY_DEADLY_PLOT"; playerId: PlayerId }
  | { type: "PLAY_CRIPPLE_DEFENSES"; playerId: PlayerId; planetId: PlanetId }
  | { type: "PLAY_PLAGUE"; playerId: PlayerId; planetId: PlanetId; diceRolls: number[] }
  | { type: "PLAY_DISABLE"; playerId: PlayerId }
  | { type: "PLAY_INFILTRATE"; playerId: PlayerId; planetId: PlanetId; relocateFrom?: { unitType: "pds" | "space_dock"; systemId: SystemId }[] }
  | { type: "PLAY_REPARATIONS"; playerId: PlayerId; exhaustPlanetId?: PlanetId; readyPlanetId?: PlanetId }
  | { type: "PLAY_PARLEY"; playerId: PlayerId; targetPlanetId: PlanetId; committedPlayerId: PlayerId }
  | { type: "PLAY_GHOST_SQUAD"; playerId: PlayerId; moves: { fromPlanetId: PlanetId; toPlanetId: PlanetId; unitType: "infantry" | "mech"; count: number }[] }
  | { type: "PLAY_UPGRADE"; playerId: PlayerId; systemId: SystemId }
  | { type: "PLAY_HARNESS_ENERGY"; playerId: PlayerId; systemId: SystemId }
  | { type: "PLAY_RALLY"; playerId: PlayerId; systemId: SystemId }
  | { type: "PLAY_COUNTERSTROKE"; playerId: PlayerId; systemId: SystemId }
  | { type: "PLAY_FORWARD_SUPPLY_BASE"; playerId: PlayerId; systemId: SystemId; chosenPlayerId: PlayerId }
  | { type: "PLAY_DECOY_OPERATION"; playerId: PlayerId; systemId: SystemId; fromPlanetIds: PlanetId[]; toPlanetId: PlanetId }
  | { type: "PLAY_MASTER_PLAN"; playerId: PlayerId }
  | { type: "PLAY_FIGHTER_PROTOTYPE"; playerId: PlayerId }
  | { type: "PLAY_EMERGENCY_REPAIRS"; playerId: PlayerId }
  | { type: "PLAY_SALVAGE"; playerId: PlayerId; opponentId: PlayerId }
  | { type: "PLAY_SHIELDS_HOLDING"; playerId: PlayerId; hitsToCancel: number }
  | { type: "PLAY_MANEUVERING_JETS"; playerId: PlayerId }
  | { type: "PLAY_WAR_MACHINE"; playerId: PlayerId }
  | { type: "PLAY_REVERSE_ENGINEER"; playerId: PlayerId; targetCardId: ActionCardId }
  | { type: "PLAY_INTERCEPT"; playerId: PlayerId; opponentId: PlayerId }
  | { type: "PLAY_ROUT"; playerId: PlayerId; opponentId: PlayerId; opponentToSystemId: SystemId }
  | { type: "PLAY_WAYLAY"; playerId: PlayerId }
  | { type: "PLAY_COURAGEOUS_TO_THE_END"; playerId: PlayerId; destroyedUnitType: UnitType; diceRolls: number[]; opponentUnitTypeToDestroy: UnitType }
  | { type: "PLAY_DIRECT_HIT"; playerId: PlayerId; opponentId: PlayerId; unitType: UnitType }
  | { type: "PLAY_REFLECTIVE_SHIELDING"; playerId: PlayerId; unitType: UnitType; hitAssignments: { unitType: UnitType; outcome: "destroy" | "flip" }[] }
  | {
      type: "PLAY_EXPERIMENTAL_BATTLESTATION";
      playerId: PlayerId;
      spaceDockSystemId: SystemId;
      targetSystemId: SystemId;
      opponentId: PlayerId;
      diceRolls: number[];
      hitAssignments: { unitType: UnitType; outcome: "destroy" | "flip" }[];
    }
  | { type: "PLAY_FIRE_TEAM"; playerId: PlayerId; rerollUnitType: "infantry" | "mech"; newDiceRolls: number[] }
  | { type: "PLAY_SCRAMBLE_FREQUENCY"; playerId: PlayerId; opponentId: PlayerId; opponentUnitType: UnitType; newDiceRolls: number[] }
  | { type: "PLAY_REVEAL_PROTOTYPE"; playerId: PlayerId; techId: TechId; exhaustPlanetIdsForResources: PlanetId[] }
  | { type: "PLAY_STRATEGIZE"; playerId: PlayerId; cardId: string; payload: unknown } // TE — see phases/actionCardEffects.ts's own playStrategize
  | { type: "PLAY_OVERRULE"; playerId: PlayerId; cardId: string; payload: unknown } // TE — see phases/actionCardEffects.ts's own playOverrule
  | { type: "PLAY_CRISIS"; playerId: PlayerId } // TE — see phases/actionCardEffects.ts's own playCrisis
  | { type: "PLAY_PUPPETS_ON_A_STRING"; playerId: PlayerId } // TE — see phases/actionCardEffects.ts's own playPuppetsOnAString
  | { type: "PLAY_RESCUE"; playerId: PlayerId; fromSystemId: SystemId; unitType: UnitType; gravityRiftDieRoll?: number } // TE — see phases/actionCardEffects.ts's own playRescue
  | { type: "PLAY_LIE_IN_WAIT"; playerId: PlayerId; cardIdFromFirst: string; cardIdFromSecond: string } // TE — see phases/actionCardEffects.ts's own playLieInWait
  | { type: "PLAY_EXCHANGE_PROGRAM"; playerId: PlayerId; otherPlayerId: PlayerId; agreed: boolean; targetPlanetId?: PlanetId } // TE — see phases/actionCardEffects.ts's own playExchangeProgram
  | { type: "PLAY_BRILLIANCE"; playerId: PlayerId; mode: "ready_planet" | "grant_breakthrough"; planetId?: PlanetId; targetPlayerId?: PlayerId; fractureDieRoll?: number; randomFactionIdForYinAscendant?: string } // TE — see phases/actionCardEffects.ts's own playBrilliance
  | { type: "PLAY_MERCENARY_CONTRACT"; playerId: PlayerId; planetId: PlanetId } // TE — see phases/actionCardEffects.ts's own playMercenaryContract
  | { type: "PLAY_PIRATE_CONTRACT"; playerId: PlayerId; systemId: SystemId } // TE — see phases/actionCardEffects.ts's own playPirateContract
  | { type: "PLAY_PIRATE_FLEET"; playerId: PlayerId; systemId: SystemId; exhaustPlanetIdsForResources: PlanetId[] } // TE — see phases/actionCardEffects.ts's own playPirateFleet
  | { type: "PLAY_CRASH_LANDING"; playerId: PlayerId; unitType: UnitType; targetPlanetId: PlanetId } // TE — see phases/actionCardEffects.ts's own playCrashLanding
  | { type: "PLAY_EXTREME_DURESS"; playerId: PlayerId; armedPlayerId: PlayerId } // TE — see phases/actionCardEffects.ts's own playExtremeDuress
  | { type: "USE_CROWN_OF_EMPHIDIA"; playerId: PlayerId; planetId: PlanetId; chosenTrait?: "cultural" | "industrial" | "hazardous" } // RR relic — see rules/relics.ts's own useCrownOfEmphidia
  | { type: "USE_MAW_OF_WORLDS"; playerId: PlayerId; techId: TechId } // RR relic — see rules/relics.ts's own useMawOfWorlds
  | { type: "USE_BOOK_OF_LATVINIA"; playerId: PlayerId } // RR relic — see rules/relics.ts's own useBookOfLatvinia
  | { type: "RESOLVE_BOOK_OF_LATVINIA_ON_GAIN"; playerId: PlayerId; techIds: TechId[] } // RR relic, "when you gain this card" — see rules/relics.ts's own resolveBookOfLatviniaOnGain (distinct from USE_BOOK_OF_LATVINIA above, its own later purge action)
  | { type: "USE_THE_CODEX"; playerId: PlayerId; cardIds: string[] } // RR relic — see rules/relics.ts's own useTheCodex
  | { type: "USE_STELLAR_CONVERTER"; playerId: PlayerId; bombardmentSystemId: SystemId; targetSystemId: SystemId; targetPlanetId: PlanetId } // RR relic — see rules/relics.ts's own useStellarConverter
  | { type: "USE_NANO_FORGE"; playerId: PlayerId; relicId: "nano_forge_attach" | "nano_forge_no_repeat"; planetId: PlanetId } // RR relic — see rules/relics.ts's own useNanoForge
  | { type: "USE_DYNAMIS_CORE"; playerId: PlayerId; relicId: "dynamo_core_exhaust" | "dynamo_core_gain" } // RR relic — see rules/relics.ts's own useDynamisCore
  | { type: "USE_HEART_OF_IXTH"; playerId: PlayerId; adjustment: 1 | -1 } // RR relic — see rules/relics.ts's own useHeartOfIxth. Reads the actual roll from GameState.pendingHeartOfIxthAdjustableRoll, not a caller-supplied value.
  | { type: "USE_SILVER_FLAME"; playerId: PlayerId; dieRoll: number; fractureDieRoll?: number } // RR relic — see rules/relics.ts's own useSilverFlame
  | { type: "USE_JR_XS455_O"; playerId: PlayerId; targetPlayerId: PlayerId; placeStructure?: { planetId: PlanetId; structureType: "space_dock" | "pds"; exhaustPlanetIdsForResources: PlanetId[] } } // RR relic/agent — see rules/relics.ts's own useJrXs455O
  | { type: "USE_NEURALOOP"; playerId: PlayerId; relicIdToPurge: string; discardedObjectiveId: ObjectiveId; replacementObjectiveId: ObjectiveId; replacementDeck: "publicStageI" | "publicStageII" | "secret" } // RR relic — see rules/relics.ts's own useNeuraloop
  | { type: "USE_DOK_N_PICS_SALVAGE_YARD_PLAY"; playerId: PlayerId; cardId: string } // TE Garbozia's own legendary ability — see phases/legendaryPlanets.ts
  | {
      type: "USE_MAXIS_CENTRAL_CONTROL";
      playerId: PlayerId;
      targetPlanetId: PlanetId;
      chosenTrait?: "cultural" | "industrial" | "hazardous";
      explorationChoice?: import("../phases/exploration").ExplorationCardChoice;
    } // Faunus' own legendary ability — see phases/legendaryPlanets.ts
  | { type: "USE_ENIGMATIC_DEVICE"; playerId: PlayerId; techId: TechId; exhaustPlanetIdsForResources: PlanetId[] } // Frontier exploration card, kept in play area — see phases/exploration.ts
  | { type: "RESOLVE_MITOSIS_PLACEMENT"; playerId: PlayerId; targetPlanetId: PlanetId; useDeployMech?: boolean } // Arborec's own faction ability — see rules/arborec.ts
  | { type: "RESOLVE_SCAVENGER_ZETA_DEPLOY"; playerId: PlayerId; planetId: PlanetId; use: boolean } // Clan of Saar's own mech Deploy — see rules/saar.ts
  | {
      type: "USE_CHAOS_MAPPING";
      playerId: PlayerId;
      systemId: SystemId;
      unitType: UnitType;
      groundForceDestinationPlanetId?: PlanetId;
      exhaustPlanetIdsForResources?: PlanetId[];
    } // Clan of Saar's own faction technology — see rules/saar.ts
  | { type: "USE_RAGHS_CALL"; playerId: PlayerId; targetPlanetId: PlanetId; destinationPlanetId: PlanetId } // Clan of Saar's own promissory note — see rules/saar.ts
  | { type: "USE_MENDOSA"; playerId: PlayerId; targetPlayerId: PlayerId; unitType: UnitType; fromSystemId: SystemId } // Clan of Saar's own agent — see rules/saar.ts
  | {
      type: "USE_ROWL_SARRIG";
      playerId: PlayerId;
      sourceSystemId: SystemId;
      sourcePlanetId?: PlanetId;
      unitType: "fighter" | "infantry";
      count: number;
      destinationSystemId: SystemId;
      destinationPlanetId?: PlanetId;
    } // Clan of Saar's own commander — see rules/saar.ts
  | { type: "USE_GURNO_AGGERO"; playerId: PlayerId; targetSystemId: SystemId } // Clan of Saar's own hero — see rules/saar.ts
  | {
      type: "USE_DEORBIT_BARRAGE";
      playerId: PlayerId;
      sourceAsteroidFieldSystemId: SystemId;
      targetPlanetId: PlanetId;
      resourcesSpent: number;
      dieRolls: number[];
      hitAssignments: { unitType: UnitType }[];
      exhaustPlanetIdsForResources?: PlanetId[];
    } // Clan of Saar's own Breakthrough ability — see rules/saar.ts
  | { type: "USE_RECLAMATION"; playerId: PlayerId; placePds: boolean; placeSpaceDock: boolean } // Winnu's own faction ability — see rules/winnu.ts
  | { type: "USE_RECLAIMER_PLACEMENT"; playerId: PlayerId; planetId: PlanetId; placements: ("pds" | "space_dock")[] } // Winnu's own mech — see rules/winnu.ts
  | { type: "USE_PLAY_ACQUIESCENCE"; playerId: PlayerId; ownCardId: StrategyCardId; winnuCardId: StrategyCardId } // Winnu's own promissory note — see rules/winnu.ts
  | { type: "USE_PLAY_ACQUIESCENCE_OMEGA"; playerId: PlayerId; strategyCardId: StrategyCardId } // Winnu's own promissory note (Codex) — see rules/winnu.ts
  | { type: "USE_LAZAX_GATE_FOLDING"; playerId: PlayerId } // Winnu's own faction technology — see rules/winnu.ts
  | { type: "USE_HEGEMONIC_TRADE_POLICY"; playerId: PlayerId; planetId: PlanetId } // Winnu's own faction technology — see rules/winnu.ts
  | { type: "USE_BEREKAR_BEREKON"; playerId: PlayerId } // Winnu's own agent — see rules/winnu.ts
  | { type: "USE_MATHIS_MATHINUS"; playerId: PlayerId; strategyCardId: StrategyCardId; grantedPlayerIds: PlayerId[] } // Winnu's own hero — see rules/winnu.ts
  | { type: "USE_INDOCTRINATION"; playerId: PlayerId; exhaustPlanetIdsForInfluence: PlanetId[]; useMechInstead?: boolean } // Yin Brotherhood's own faction ability (+ Moyin's Ashes' own Deploy) — see rules/yin.ts
  | {
      type: "USE_DEVOTION";
      playerId: PlayerId;
      sacrificeUnitType: "cruiser" | "destroyer";
      targetPlayerId: PlayerId;
      targetUnitType: UnitType;
      targetIsDamaged?: boolean;
    } // Yin Brotherhood's own faction ability — see rules/yin.ts
  | {
      type: "USE_IMPULSE_CORE";
      playerId: PlayerId;
      sacrificeUnitType: "cruiser" | "destroyer";
    } // Yin Brotherhood's own faction technology — see rules/yin.ts
  | { type: "ASSIGN_IMPULSE_CORE_HIT"; playerId: PlayerId; targetUnitType: UnitType; targetIsDamaged?: boolean } // Yin Brotherhood's own faction technology (the OPPONENT's own hit-assignment half) — see rules/yin.ts
  | { type: "USE_PLAY_GREYFIRE_MUTAGEN"; playerId: PlayerId; targetSystemId: SystemId } // Yin Brotherhood's own promissory note — see rules/yin.ts
  | { type: "USE_PLAY_GREYFIRE_MUTAGEN_OMEGA"; playerId: PlayerId } // Yin Brotherhood's own promissory note (Codex) — see rules/yin.ts
  | { type: "USE_BROTHER_MILOR"; playerId: PlayerId; unitType: "fighter" | "infantry"; count: 1 | 2 } // Yin Brotherhood's own agent — see rules/yin.ts
  | { type: "SKIP_BROTHER_MILOR"; playerId: PlayerId } // Yin Brotherhood's own agent — see rules/yin.ts
  | { type: "USE_DANEEL_OF_THE_TENTH"; playerId: PlayerId; choices: { planetId: PlanetId; choice: "ready" | "double" }[] } // Yin Brotherhood's own hero — see rules/yin.ts
  | { type: "USE_DANEEL_OF_THE_TENTH_OMEGA"; playerId: PlayerId; destinations: { planetId: PlanetId; count: number }[] } // Yin Brotherhood's own hero (Codex) — see rules/yin.ts
  | { type: "USE_STYMIE"; playerId: PlayerId } // Arborec's own promissory note — see rules/arborec.ts
  | { type: "USE_STYMIE_OMEGA"; playerId: PlayerId; targetPlayerId: PlayerId; targetSystemId: SystemId; commandTokenPool?: "tactic" | "fleet" | "strategy" } // Arborec's own promissory note (Codex) — see rules/arborec.ts
  | { type: "USE_DUHA_MENAIMON_PRODUCTION"; playerId: PlayerId; units: { unitType: UnitType; count: number }[]; exhaustPlanetIdsForResources: PlanetId[]; groundForceTargetPlanetId?: PlanetId } // Arborec's own flagship — see rules/arborec.ts
  | { type: "USE_BIOPLASMOSIS"; playerId: PlayerId; moves: { fromPlanetId: PlanetId; toPlanetId: PlanetId; count: number }[] } // Arborec's own faction tech — see rules/arborec.ts
  | {
      type: "USE_LETANI_OSPHA";
      ownerId: PlayerId;
      targetPlayerId: PlayerId;
      systemId: SystemId;
      replacedUnitType: UnitType;
      newUnitType: UnitType;
      substituteSourceSystemId?: SystemId;
    } // Arborec's own agent — see rules/arborec.ts
  | { type: "USE_DIRZUGA_ROPHAL"; playerId: PlayerId; systemId: SystemId; unitType: UnitType; count: number; exhaustPlanetIdsForResources: PlanetId[]; groundForceTargetPlanetId?: PlanetId } // Arborec's own commander — see rules/arborec.ts
  | {
      type: "USE_LETANI_MIASMIALA";
      playerId: PlayerId;
      productions: { systemId: SystemId; units: { unitType: UnitType; count: number }[]; exhaustPlanetIdsForResources: PlanetId[]; groundForceTargetPlanetId?: PlanetId }[];
    } // Arborec's own hero — see rules/arborec.ts
  | { type: "USE_PSYCHOSPORE"; playerId: PlayerId; targetSystemId: SystemId } // Arborec's own Breakthrough — see rules/arborec.ts
  | { type: "RESOLVE_ASSIMILATE_SUBSTITUTE"; playerId: PlayerId; planetId: PlanetId; unitType: UnitType; substituteSourceSystemId: SystemId } // L1Z1X's own faction ability — see rules/l1z1x.ts
  | { type: "USE_HARROW"; playerId: PlayerId; diceRolls: number[]; plasmaScoringUnitType?: UnitType } // L1Z1X's own faction ability — hits assigned via the existing ASSIGN_BOMBARDMENT_HITS action — see rules/l1z1x.ts
  | { type: "USE_CYBERNETIC_ENHANCEMENTS"; playerId: PlayerId } // L1Z1X's own promissory note — see rules/l1z1x.ts
  | { type: "USE_CYBERNETIC_ENHANCEMENTS_OMEGA"; playerId: PlayerId; commandTokenPool: "tactic" | "fleet" | "strategy" } // L1Z1X's own promissory note (Codex) — see rules/l1z1x.ts
  | { type: "USE_I48S"; ownerId: PlayerId; targetPlayerId: PlayerId; systemId: SystemId; targetPlanetId?: PlanetId; substituteSourceSystemId?: SystemId } // L1Z1X's own agent — see rules/l1z1x.ts
  | {
      type: "USE_THE_HELMSMAN";
      playerId: PlayerId;
      targetSystemId: SystemId;
      moves: { fromSystemId: SystemId; unitType: "flagship" | "dreadnought"; count: number; transportedUnits?: { unitType: UnitType; count: number }[] }[];
    } // L1Z1X's own hero — see rules/l1z1x.ts
  | { type: "USE_PROMISE_OF_PROTECTION"; playerId: PlayerId } // Mentak Coalition's own promissory note — see rules/mentak.ts
  | { type: "USE_PILLAGE"; playerId: PlayerId; targetPlayerId: PlayerId; take: "trade_good" | "commodity" } // Mentak Coalition's own faction ability — see rules/mentak.ts
  | {
      type: "USE_SALVAGE_OPERATIONS";
      playerId: PlayerId;
      won: boolean;
      systemId: SystemId;
      unitType?: UnitType;
      exhaustPlanetIdsForResources?: PlanetId[];
      substituteSourceSystemId?: SystemId;
    } // Mentak Coalition's own faction tech — see rules/mentak.ts
  | { type: "USE_AMBUSH"; playerId: PlayerId; systemId: SystemId; ships: { unitType: "cruiser" | "destroyer"; diceRolls: number[] }[] } // Mentak Coalition's own faction ability — see rules/mentak.ts
  | { type: "USE_SUFFI_AN"; playerId: PlayerId; pillagedPlayerId: PlayerId } // Mentak Coalition's own agent — see rules/mentak.ts
  | { type: "USE_SULA_MENTARION"; playerId: PlayerId; opponentId: PlayerId; promissoryNoteId: string } // Mentak Coalition's own commander — see rules/mentak.ts
  | { type: "USE_SLEEPER_CELL"; playerId: PlayerId } // Mentak Coalition's own hero — see rules/mentak.ts
  | {
      type: "RESOLVE_SLEEPER_CELL_PLACEMENT";
      playerId: PlayerId;
      destroyedOpponentUnitTypes: UnitType[];
      removals?: { unitType: UnitType; count: number }[];
    } // Mentak Coalition's own hero — see rules/mentak.ts
  | { type: "USE_GIFT_OF_PRESCIENCE"; playerId: PlayerId } // Naalu Collective's own promissory note — see rules/naalu.ts
  | { type: "USE_ZEU_OMEGA"; playerId: PlayerId; targetPlayerId: PlayerId; systemId: SystemId } // Naalu Collective's own agent (Codex) — see rules/naalu.ts
  | { type: "USE_ZEU_OMEGA_OMEGA"; playerId: PlayerId; targetPlayerId: PlayerId; systemId: SystemId } // Naalu Collective's own agent (Thunder's Edge) — see rules/naalu.ts
  | { type: "USE_NEUROGLAIVE"; playerId: PlayerId; activatingPlayerId: PlayerId; systemId: SystemId; removedCommandTokenPool: "tactic" | "fleet" | "strategy" } // Naalu Collective's own faction tech — see rules/naalu.ts
  | { type: "USE_THE_ORACLE"; playerId: PlayerId; choices: { targetPlayerId: PlayerId; promissoryNoteId: string }[] } // Naalu Collective's own hero — see rules/naalu.ts
  | { type: "USE_MINDSIEVE"; playerId: PlayerId; strategyCardOwnerId: PlayerId; promissoryNoteId: string } // Naalu Collective's own Breakthrough — see rules/naalu.ts
  | { type: "USE_FORESIGHT"; playerId: PlayerId; activeSystemId: SystemId; destinationSystemId: SystemId; units: { unitType: UnitType; count: number }[] } // Naalu Collective's own faction ability — see rules/naalu.ts
  | { type: "USE_WORMHOLE_GENERATOR"; playerId: PlayerId; wormholeType: "alpha" | "beta" | "gamma"; toSystemId: SystemId } // Ghosts of Creuss's own faction tech (base) — see rules/creuss.ts
  | { type: "USE_WORMHOLE_GENERATOR_OMEGA"; playerId: PlayerId; wormholeType: "alpha" | "beta" | "gamma"; toSystemId: SystemId } // Ghosts of Creuss's own faction tech (Codex) — see rules/creuss.ts
  | { type: "USE_CREUSS_IFF"; playerId: PlayerId; wormholeType: "alpha" | "beta" | "gamma"; toSystemId: SystemId } // Ghosts of Creuss's own promissory note — see rules/creuss.ts
  | { type: "USE_ICARUS_DRIVE"; playerId: PlayerId; icarusDriveSystemId: SystemId; wormholeType: "alpha" | "beta" | "gamma" } // Ghosts of Creuss's own mech — see rules/creuss.ts
  | { type: "USE_DIMENSIONAL_SPLICER"; playerId: PlayerId } // Ghosts of Creuss's own faction tech — see rules/creuss.ts
  | { type: "USE_EMISSARY_TAIVRA"; playerId: PlayerId; targetSystemId: SystemId } // Ghosts of Creuss's own agent — see rules/creuss.ts
  | { type: "USE_SAI_SERAVUS"; playerId: PlayerId; destinationSystemId: SystemId; shipsMovedThroughWormholes: { unitType: UnitType; count: number }[] } // Ghosts of Creuss's own commander — see rules/creuss.ts
  | { type: "USE_RIFTWALKER_MEIAN"; playerId: PlayerId; systemIdA: SystemId; systemIdB: SystemId } // Ghosts of Creuss's own hero — see rules/creuss.ts
  | { type: "USE_THE_ACROPOLIS"; playerId: PlayerId; target: { kind: "planet"; planetId: PlanetId } | { kind: "relic"; relicId: string } | { kind: "technology"; techId: TechId } | { kind: "leader"; leaderId: string } } // TE Emelpar's own legendary ability, "at the end of your turn" — usable only during the end_of_turn priority window — see phases/legendaryPlanets.ts
  | { type: "USE_THE_GALACTIC_COUNCIL"; playerId: PlayerId; discardedSecretObjectiveId: string } // TE Mecatol Rex's own legendary ability, "at the end of your turn" — same end_of_turn window gating — see phases/legendaryPlanets.ts
  | { type: "USE_JUPITER_BRAIN"; playerId: PlayerId } // TE Thunder's Edge's own legendary ability, "at the end of your turn" — same end_of_turn window gating — see phases/legendaryPlanets.ts
  | { type: "USE_ORBITAL_DROP"; playerId: PlayerId; targetPlanetId: PlanetId } // Sol's own faction ability — see rules/sol.ts
  | { type: "USE_ZS_THUNDERBOLT_M2_DEPLOY"; playerId: PlayerId; targetPlanetId: PlanetId; exhaustPlanetIdsForResources: PlanetId[] } // Sol's own mech's DEPLOY ability — see rules/sol.ts
  | { type: "RESOLVE_GENESIS_CAPACITY_OVERFLOW"; playerId: PlayerId; systemId: SystemId; unitTypeToRemove: "infantry" | "fighter" } // Sol's own Genesis flagship's mandatory capacity fix — see rules/sol.ts
  | { type: "USE_MILITARY_SUPPORT"; playerId: PlayerId; placeInfantry?: { targetPlanetId: PlanetId; count: number } } // Sol's own promissory note — see rules/sol.ts
  | { type: "USE_CLAIRE_GIBSON"; playerId: PlayerId; targetPlanetId: PlanetId } // Sol's own commander — see rules/sol.ts
  | { type: "USE_JACE_X"; playerId: PlayerId } // Sol's own hero — see rules/sol.ts
  | { type: "USE_REAR_ADMIRAL_FARRAN"; playerId: PlayerId } // Letnev's own commander — see rules/letnev.ts
  | { type: "USE_DUNLAIN_REAPER_DEPLOY"; playerId: PlayerId; targetPlanetId: PlanetId; exhaustPlanetIdsForResources: PlanetId[] } // Letnev's own mech's DEPLOY ability — see rules/letnev.ts
  | { type: "USE_DARKTALON_TREILLA"; playerId: PlayerId } // Letnev's own hero — see rules/letnev.ts
  | { type: "USE_MUNITIONS_RESERVES"; playerId: PlayerId; rerolls: { unitType: UnitType; newRolls: number[] }[] } // Letnev's own faction ability — see rules/letnev.ts
  | { type: "RESOLVE_FLEET_CLEANUP"; playerId: PlayerId; systemId: SystemId; removals: { unitType: UnitType; count: number }[] } // Letnev's own Darktalon Treilla end-of-round consequence — see rules/letnev.ts
  | { type: "USE_WAR_FUNDING"; playerId: PlayerId; rerolls: { unitType: UnitType; newRolls: number[] }[] } // Letnev's own promissory note — see rules/letnev.ts
  | {
      type: "USE_WAR_FUNDING_OMEGA";
      playerId: PlayerId;
      opponentId: PlayerId;
      opponentRerolls: { unitType: UnitType; newRolls: number[] }[];
      ownRerolls: { unitType: UnitType; newRolls: number[] }[];
    } // Letnev's own promissory note (Codex) — see rules/letnev.ts
  | { type: "USE_TEKKLAR_LEGION"; playerId: PlayerId } // Sardakk N'orr's own promissory note — see rules/sardakk.ts
  | { type: "USE_EXOTRIREME_II_SELF_DESTRUCT"; playerId: PlayerId; systemId: SystemId; targets: { playerId: PlayerId; unitType: UnitType; count: number }[] } // Sardakk N'orr's own unit ability — see rules/sardakk.ts
  | { type: "USE_TRO"; playerId: PlayerId; targetPlanetId?: PlanetId } // Sardakk N'orr's own agent — see rules/sardakk.ts
  | { type: "USE_NORR_SUPREMACY"; playerId: PlayerId; commandTokenPool: "tactic" | "fleet" | "strategy" } // Sardakk N'orr's own Breakthrough — see rules/sardakk.ts
  | { type: "USE_GHOM_SEKKUS"; playerId: PlayerId; targetPlanetId: PlanetId; sources: { planetId: PlanetId; unitType: "infantry" | "mech" }[] } // Sardakk N'orr's own commander — see rules/sardakk.ts
  | { type: "USE_SHVAL_HARBINGER"; playerId: PlayerId } // Sardakk N'orr's own hero — see rules/sardakk.ts
  | { type: "USE_RESEARCH_AGREEMENT"; playerId: PlayerId; techId: TechId } // Jol-Nar's own promissory note — see rules/jolnar.ts
  | { type: "USE_SPATIAL_CONDUIT_CYLINDER"; playerId: PlayerId } // Jol-Nar's own faction tech — see rules/jolnar.ts
  | { type: "USE_RIN_GENETIC_MEMORY"; playerId: PlayerId; replacements: { oldTechId: TechId; newTechId: TechId }[] } // Jol-Nar's own hero — see rules/jolnar.ts
  | { type: "USE_TRADE_CONVOYS"; playerId: PlayerId } // Hacan's own promissory note — see rules/hacan.ts
  | { type: "USE_CARTH_OF_GOLDEN_SANDS"; playerId: PlayerId; choice: "gain_2_for_self" | "replenish_another"; targetPlayerId?: PlayerId } // Hacan's own agent — see rules/hacan.ts
  | { type: "USE_PRODUCTION_BIOMES"; playerId: PlayerId; targetPlayerId: PlayerId } // Hacan's own faction tech — see rules/hacan.ts
  | { type: "USE_QUANTUM_DATAHUB_NODE"; playerId: PlayerId; targetPlayerId: PlayerId; cardId: string; targetCardId: string } // Hacan's own faction tech — see rules/hacan.ts
  | { type: "USE_PEACE_ACCORDS"; playerId: PlayerId; targetPlanetId: PlanetId; chosenTrait?: "cultural" | "industrial" | "hazardous"; explorationChoice?: import("../phases/exploration").ExplorationCardChoice } // Xxcha's own faction ability — see rules/xxcha.ts
  | { type: "USE_GGRUCOTO_RINN"; playerId: PlayerId; targetPlanetId: PlanetId; removeInfantry?: boolean } // Xxcha's own agent — see rules/xxcha.ts
  | { type: "USE_QUASH"; playerId: PlayerId } // Xxcha's own faction ability — see rules/xxcha.ts
  | { type: "USE_POLITICAL_FAVOR"; playerId: PlayerId } // Xxcha's own promissory note — see rules/xxcha.ts
  | { type: "USE_NULLIFICATION_FIELD"; playerId: PlayerId; targetSystemId: SystemId } // Xxcha's own faction tech — see rules/xxcha.ts
  | { type: "USE_INSTINCT_TRAINING"; playerId: PlayerId } // Xxcha's own faction tech — see rules/xxcha.ts
  | { type: "USE_XXEKIR_GROM_OMEGA_OMEGA"; playerId: PlayerId; placements: { planetId: PlanetId; unitType: "pds" | "mech"; count: number }[] } // Xxcha's own hero (Thunder's Edge version) — see rules/xxcha.ts
  | { type: "USE_STAR_FORGE"; playerId: PlayerId; systemId: SystemId; choice: "fighters" | "destroyer" } // Muaat's own base faction ability — see rules/muaat.ts
  | { type: "USE_THE_NUCLEUS"; playerId: PlayerId; systemId: SystemId; choice: "fighters" | "destroyer" } // Avernus's own legendary ability (Muaat's Breakthrough) — see rules/muaat.ts
  | { type: "USE_MAGMUS_REACTOR_OMEGA_PRODUCTION"; playerId: PlayerId; systemId: SystemId; units: { unitType: UnitType; count: number }[]; exhaustPlanetIdsForResources: PlanetId[] } // Embers of Muaat's own faction tech (Codex) — see rules/muaat.ts
  | { type: "USE_FIRES_OF_THE_GASHLAI"; playerId: PlayerId } // Embers of Muaat's own promissory note — see rules/muaat.ts
  | { type: "USE_FORGE_CRUISER"; playerId: PlayerId; systemId: SystemId } // Embers of Muaat's own flagship — see rules/muaat.ts
  | { type: "USE_EMBER_COLOSSUS_SPAWN"; playerId: PlayerId; emberColossusSystemId: SystemId; starForgeSystemId: SystemId } // Embers of Muaat's own mech — see rules/muaat.ts
  | {
      type: "USE_UMBAT";
      ownerId: PlayerId;
      targetPlayerId: PlayerId;
      systemId: SystemId;
      units: { unitType: UnitType; count: number }[];
      exhaustPlanetIdsForResources: PlanetId[];
      groundForceTargetPlanetId?: PlanetId;
    } // Embers of Muaat's own agent — see rules/muaat.ts
  | { type: "USE_MAGMUS_TRADE_GOOD"; playerId: PlayerId } // Embers of Muaat's own commander — see rules/muaat.ts
  | { type: "USE_NOVA_SEED"; playerId: PlayerId; systemId: SystemId } // Embers of Muaat's own hero — see rules/muaat.ts
  | { type: "USE_STALL_TACTICS"; playerId: PlayerId; cardId: string; deployMechPlanetId?: PlanetId } // Yssaril Tribes' own faction ability (with Blackshade Infiltrator's own optional Deploy) — see rules/yssaril.ts
  | { type: "DISCARD_SCHEMING_CARD"; playerId: PlayerId; cardId: string } // Yssaril Tribes' own faction ability — see rules/yssaril.ts
  | { type: "USE_SPY_NET"; playerId: PlayerId; chosenCardId: string } // Yssaril Tribes' own promissory note — see rules/yssaril.ts
  | { type: "USE_MAGEON_IMPLANTS"; playerId: PlayerId; targetPlayerId: PlayerId; chosenCardId: string } // Yssaril Tribes' own faction tech — see rules/yssaril.ts
  | { type: "USE_SSRUU"; playerId: PlayerId; targetFactionId: string; innerAction: GameAction } // Yssaril Tribes' own agent — duplicates another IN-PLAY player's own agent ability, re-dispatching innerAction (with that agent's own playerId/ownerId field already set to THIS player) — see rules/yssaril.ts's own checkSsruuAndTarget and GameEngine.ts's own USE_SSRUU case
  | { type: "USE_GUILD_OF_SPIES"; playerId: PlayerId; choices: { targetPlayerId: PlayerId; shownCardId: string; take: boolean }[] } // Yssaril Tribes' own hero — see rules/yssaril.ts
  | { type: "APPLY_STELLAR_GENESIS"; playerId: PlayerId; targetSystemId: SystemId } // Muaat's own Breakthrough gain-trigger, placing Avernus — see rules/muaat.ts's own applyStellarGenesisOnGain
  /** RR 1.19/1.20: declines this player's current turn in an open priority window (see types/GameState.ts's own PendingPriorityWindow doc comment) — legal any time it's their turn in ANY open window, whichever kind it is. */
  | { type: "PASS_PRIORITY"; playerId: PlayerId }
  | {
      type: "RESEARCH_TECHNOLOGY";
      playerId: PlayerId;
      techId: TechId;
      /** How this specific research is being paid for — 0/empty for a source that grants it free (e.g. some faction abilities); nonzero needs enough resources from the exhausted planets (falls back to trade goods for any shortfall). RR 90.7 prerequisites are always checked regardless of cost. */
      cost: number;
      exhaustPlanetIdsForResources: PlanetId[];
      /** RR "Research Team" (any color variant): exhaust that SPECIFIC controlled planet's own attachment card to ignore 1 prerequisite of its matching color for this one research. */
      useResearchTeamAttachmentPlanetId?: PlanetId;
      /** RR 90.13-90.15: exhaust any number of controlled tech-specialty planets (a base-game mechanic, not PoK-specific) — each ignores 1 prerequisite of its own matching color, stackable with Research Team above. A planet already exhausted (including via exhaustPlanetIdsForResources above) can't be reused here. */
      exhaustPlanetIdsForTechSpecialty?: PlanetId[];
      /** Jol-Nar "ANALYTICAL" (faction ability, passive): "When you research a technology that is not a unit upgrade technology, you may ignore 1 prerequisite." The player's own choice of which color to ignore. */
      useAnalyticalIgnoreColor?: string;
      /** Jol-Nar "Doctor Sucaban" (agent): reduces this research's own resource cost by 1 per infantry removed this way — see phases/technology.ts's own researchTechnology for the full doc comment. */
      docSucabanRemovedInfantry?: { planetId: PlanetId; count: number }[];
      /** Jol-Nar "Specialized Compounds" (Breakthrough): exhaust this tech-specialty planet instead of paying resources — see phases/technology.ts's own researchTechnology for the full doc comment. */
      specializedCompoundsPlanetId?: PlanetId;
      /** L1Z1X "Inheritance Systems" (faction tech): ignore ALL prerequisites, paying 2 resources separately — see phases/technology.ts's own researchTechnology for the full doc comment. */
      useInheritanceSystemsExhaustPlanetIds?: PlanetId[];
      /** Nekro Virus "PROPAGATION": which of the 3 command-token pools this player's own 3 free tokens go to, replacing the whole research attempt — see phases/technology.ts's own researchTechnology for the full doc comment. Ignored for every other faction. */
      nekroCommandTokenDistribution?: { tactic: number; fleet: number; strategy: number };
      /** Yin Brotherhood "Brother Omar Ω" (commander, codex version): return 1 infantry from this planet to ignore ALL of this technology's prerequisites, for a tech owned by another player's faction — see phases/technology.ts's own researchTechnology for the full doc comment. */
      useBrotherOmarOmegaInfantryPlanetId?: PlanetId;
    } // RR 90
  | {
      type: "RESEARCH_UNIT_UPGRADE";
      playerId: PlayerId;
      upgradeId: UnitUpgradeId;
      cost: number;
      exhaustPlanetIdsForResources: PlanetId[];
      /** RR "AI Development Algorithm": exhaust that tech (if owned and readied) to ignore exactly ONE instance of this one color's prerequisite for this research (e.g. a "2 red" requirement becomes "1 red") — not the whole prerequisite list. */
      aiDevelopmentAlgorithmIgnoreColor?: string;
      /** RR "Research Team" (any color variant): same effect, different source — see RESEARCH_TECHNOLOGY's own note. Stackable alongside AI Development Algorithm and/or tech-specialty planets below. */
      useResearchTeamAttachmentPlanetId?: PlanetId;
      /** RR 90.13-90.15: see RESEARCH_TECHNOLOGY's own note on this same field. */
      exhaustPlanetIdsForTechSpecialty?: PlanetId[];
    } // RR 90/86
  | { type: "EXPLORE_FRONTIER"; playerId: PlayerId; systemId: SystemId; choice?: import("../phases/exploration").ExplorationCardChoice } // RR 35 — PoK only
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
      exhaustPlanetIdsForResources?: PlanetId[];
    } // component action (uses this player's whole turn); exhausts the tech; produce 1 ship in any system with this player's own space dock, paying its normal cost against that dock's Production limit
  | { type: "USE_SCANLINK_DRONE_NETWORK"; playerId: PlayerId; planetId: PlanetId; chosenTrait?: "cultural" | "industrial" | "hazardous"; choice?: import("../phases/exploration").ExplorationCardChoice } // not exhaustable; explores a planet in the just-activated system that has this player's own units on it
  | {
      type: "USE_BIO_STIMS";
      playerId: PlayerId;
      /** Either a controlled planet with a tech specialty, or another of this player's own already-exhausted technologies (not Bio-Stims itself) — see phases/technologyAbilities.ts's own note. */
      target: { kind: "planet"; planetId: PlanetId } | { kind: "technology"; techId: string };
    } // exhausts the tech; readies the chosen target
  | {
      type: "USE_PREDICTIVE_INTELLIGENCE_REDISTRIBUTE";
      playerId: PlayerId;
      tactic: number;
      fleet: number;
      strategy: number;
    } // exhausts the tech; new pool counts must sum to the same total this player already had
  | {
      type: "USE_TRANSIT_DIODES";
      playerId: PlayerId;
      removals: { planetId: PlanetId; unitType: "infantry" | "mech"; count: number }[];
      placements: { planetId: PlanetId; unitType: "infantry" | "mech"; count: number }[];
    } // exhausts the tech; removed and placed totals must match, capped at 4 total

  // --- Legendary planet abilities (RR 53) — see phases/legendaryPlanets.ts's own header note on why these are 4 dedicated actions rather than one generic dispatcher ---
  | { type: "USE_ATRAMENT"; playerId: PlayerId; targetPlanetId: PlanetId } // Primor: exhausts the ability card; +2 free infantry on any planet this player controls
  | {
      type: "USE_IMPERIAL_ARMS_VAULT";
      playerId: PlayerId;
      choice: "mech" | "action_card";
      targetPlanetId?: PlanetId; // required if choice is "mech"
    } // Hope's End: exhausts the ability card
  | { type: "USE_EXTERRIX_HEADQUARTERS"; playerId: PlayerId; choice: "gain_trade_goods" | "convert_commodities" } // Mallice: exhausts the ability card
  | { type: "USE_MIRAGE_FLIGHT_ACADEMY"; playerId: PlayerId; targetSystemId: SystemId; count: number } // Mirage: exhausts the ability card; 1 or 2 free fighters in a system that contains this player's own ships

  // --- Transactions (RR 83) ---
  | {
      type: "PROPOSE_TRANSACTION";
      playerId: PlayerId;
      withPlayerId: PlayerId;
      offer: {
        tradeGoods?: number;
        commodities?: number;
        promissoryNoteId?: PromissoryNoteId;
        relicFragments?: Partial<Record<"cultural" | "industrial" | "hazardous" | "unknown", number>>;
        relicId?: import("./ids").RelicId;
        actionCardId?: string;
        unscoredSecretObjectiveId?: string;
      };
      request: {
        tradeGoods?: number;
        commodities?: number;
        promissoryNoteId?: PromissoryNoteId;
        relicFragments?: Partial<Record<"cultural" | "industrial" | "hazardous" | "unknown", number>>;
        relicId?: import("./ids").RelicId;
        actionCardId?: string;
        unscoredSecretObjectiveId?: string;
      };
      /** TE "Black Market Dealings": true if that card (from the caster's own hand) is being spent as part of this same transaction, unlocking relics/action cards/unscored secret objectives on either offer above. */
      blackMarketDealings?: boolean;
      /** Yssaril Tribes "Deepgloom Executable" (Breakthrough): bypasses BOTH the neighbor requirement and the once-per-turn/agenda transaction limit — see rules/transactions.ts's own canTransact for the full doc comment. */
      deepgloomExecutableActive?: boolean;
    } // RR (yjmrobert.com/tirules/rules/r_transactions) — binding immediately since both sides confirm client-side before submitting; see rules/transactions.ts's own resolveTransaction.

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
      /** Yin Brotherhood "Yin Ascendant" (Breakthrough ability): which faction's alliance ability this player's own random pick landed on, only consulted for a public objective if this player's faction is Yin — see phases/actionPhase.ts's own scoreObjectiveCore for the full doc comment. */
      randomFactionIdForYinAscendant?: string;
    } // RR 52/70.1
  | { type: "FINISH_STATUS_PHASE_SCORING"; playerId: PlayerId } // RR 70.1: player signals done scoring (0, 1, or 2 objectives) for this status phase
  | {
      type: "PLACE_GAINED_COMMAND_TOKENS";
      playerId: PlayerId;
      /** RR 20/70.5: the player's own choice of how to split their newly-gained command tokens (from GameState.pendingCommandTokenGains) across their 3 pools — must sum to exactly that many. See rules/commandTokens.ts. */
      tactic: number;
      fleet: number;
      strategy: number;
    }

  // --- Agenda phase (RR 8) ---
  | {
      type: "CAST_VOTES";
      playerId: PlayerId;
      /** "for" / "against", or an elect-agenda's candidate (player id, planet id, etc.) — NOT validated against the agenda's actual legal candidates yet (see RuleData.agendas' own scope note); trusts the caller/UI to only offer legal options. */
      outcome: string;
      /** Planets to exhaust for influence — votes cast = sum of their influence (RR 8.3). Empty array = abstain. Doesn't support paying with trade goods (RR 82) yet. */
      exhaustPlanetIds: PlanetId[];
      /** RR "Predictive Intelligence": exhaust that tech (if owned and readied) to cast 3 additional votes for this outcome — the actual exhaustion only takes effect once the agenda resolves, and only if this outcome doesn't win (see phases/agendaPhase.ts's own note on PendingAgendaVote.predictiveIntelligenceBonusUsedBy). */
      usePredictiveIntelligenceBonus?: boolean;
      /** Hacan "Gila the Silvertongue" (commander, passive): spend any number of trade goods, cast 2 additional votes each for THIS outcome — see phases/agendaPhase.ts's own castVotes for the full ruling. */
      useGilaTradeGoodsSpent?: number;
    }
  | { type: "REVEAL_AGENDA" } // RR 8.2: engine-driven (no playerId) — pops the agenda deck and opens voting; wired into autoAdvancePhase so nothing needs to remember to call it, but kept as a real action for direct/manual triggering too.

  // --- Agenda EFFECTS (RR 7) — see phases/agendaEffects.ts's own header note on why these are per-agenda dedicated actions rather than one generic dispatcher ---
  | {
      type: "DESTROY_SHIP_FOR_ANTI_INTELLECTUAL_REVOLUTION";
      playerId: PlayerId;
      systemId: SystemId;
      /** RR "Anti-Intellectual Revolution" ("for"): mandatory (no skip) — the player's own choice of WHICH non-fighter ship to destroy, only offered right after they've researched a technology while this law's "for" side is active. */
      unitType: UnitType;
    }
  | {
      type: "EXHAUST_PLANETS_FOR_ANTI_INTELLECTUAL_REVOLUTION";
      playerId: PlayerId;
      /** RR "Anti-Intellectual Revolution" ("against"): must be exactly 1 planet per technology this player currently owns — the one-time effect at the start of the strategy phase this agenda's resolution led into. */
      planetIds: PlanetId[];
    }
  | {
      type: "USE_COMMITTEE_FORMATION";
      playerId: PlayerId;
      /** RR "Committee Formation": the owner's own choice of who to directly elect (skipping the vote entirely) for the pending Player-elect agenda — only offered while PendingCommitteeFormationDecision names them as the owner. */
      chosenPlayerId: PlayerId;
    }
  | { type: "SKIP_COMMITTEE_FORMATION"; playerId: PlayerId } // declines to use it this time; the normal vote opens instead
  | {
      type: "DESTROY_PDS_FOR_HOMELAND_DEFENSE_ACT";
      playerId: PlayerId;
      /** RR "Homeland Defense Act" ("against"): mandatory (no skip) — the player's own choice of WHICH planet's PDS to destroy, since they may have PDS on more than one. */
      planetId: PlanetId;
    }
  | {
      type: "RANDOM_DISCARD_FOR_EXECUTIVE_SANCTIONS";
      playerId: PlayerId;
      /** RR "Executive Sanctions" ("against"): the trusted context's own random pick of which card this player discards — not a genuine player choice, same convention as pre-rolled dice. */
      cardId: ActionCardId;
    }
  | {
      type: "USE_IMPERIAL_ARBITER";
      playerId: PlayerId;
      /** RR "Imperial Arbiter": the owner's own choice, offered once the strategy phase ends — discard this card to swap one of THEIR strategy cards for one of another player's. */
      ownCardId: StrategyCardId;
      otherPlayerId: PlayerId;
      otherCardId: StrategyCardId;
    }
  | { type: "USE_MINISTER_OF_PEACE"; playerId: PlayerId } // RR "Minister of Peace": discard to immediately end the active player's turn, right after they activate a system with another player's units in it
  | { type: "USE_MINISTER_OF_WAR"; playerId: PlayerId; systemId: SystemId } // RR "Minister of War": discard to return 1 of this player's own on-board command tokens to their tactic pool, then take 1 additional action
  | {
      type: "USE_CROWN_OF_THALNOS_REROLL";
      playerId: PlayerId;
      /** RR "The Crown of Thalnos": per unit type this player owns in the current combat round, how many of THEIR OWN missed dice (never more than actually missed) to reroll, and the new values — whichever still miss destroys that many units of that type, mandatory. */
      rerolls: { unitType: UnitType; newRolls: number[] }[];
    }
  | { type: "SKIP_CROWN_OF_THALNOS_REROLL"; playerId: PlayerId } // declines to reroll anything this round

  // --- Directive EFFECTS (RR 7) — see phases/directiveEffects.ts's own header note ---
  | {
      type: "USE_COLONIAL_REDISTRIBUTION_CHOICE";
      playerId: PlayerId;
      /** RR "Colonial Redistribution": the controller's own choice of which tied fewest-VP player gets the infantry offer. */
      chosenPlayerId: PlayerId;
    }
  | { type: "PLACE_COLONIAL_REDISTRIBUTION_INFANTRY"; playerId: PlayerId }
  | { type: "SKIP_COLONIAL_REDISTRIBUTION_INFANTRY"; playerId: PlayerId }
  | { type: "USE_RESEARCH_GRANT_REALLOCATION"; playerId: PlayerId; techId: TechId } // RR "Research Grant Reallocation": the elected player's own choice of which technology to gain
  | { type: "USE_IXTHIAN_ARTIFACT_DIE_ROLL"; playerId: PlayerId; roll: number } // RR "Ixthian Artifact": the speaker's own pre-rolled die (1-10) — stores it in GameState.pendingHeartOfIxthAdjustableRoll rather than resolving its consequences immediately, giving Heart of Ixth a real window first
  | { type: "RESOLVE_IXTHIAN_ARTIFACT_ROLL"; playerId: PlayerId } // RR "Ixthian Artifact": actually resolves the roll's own consequences (research grant vs. Mecatol wipe), reading the final value from GameState.pendingHeartOfIxthAdjustableRoll — see phases/directiveEffects.ts's own resolveIxthianArtifactRoll
  | { type: "USE_IXTHIAN_ARTIFACT_RESEARCH"; playerId: PlayerId; techId: TechId }
  | { type: "SKIP_IXTHIAN_ARTIFACT_RESEARCH"; playerId: PlayerId }
  | { type: "USE_WORMHOLE_RESEARCH"; playerId: PlayerId; techId: TechId }
  | { type: "SKIP_WORMHOLE_RESEARCH"; playerId: PlayerId }
  | { type: "USE_GALACTIC_CRISIS_PACT"; playerId: PlayerId; payload: unknown } // RR "Galactic Crisis Pact": free use of the elected strategy card's secondary — same payload shape as RESOLVE_STRATEGY_SECONDARY's own per-card union
  | { type: "SKIP_GALACTIC_CRISIS_PACT"; playerId: PlayerId }

  // --- RR 45.4/61.21: over the 3-total-secret-objectives limit ---
  | { type: "RETURN_SECRET_OBJECTIVE"; playerId: PlayerId; objectiveId: ObjectiveId }

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
  | { type: "COEXISTENCE_STARTED"; systemId: SystemId; planetId: PlanetId; coexistingPlayerId: PlayerId }
  | { type: "COEXISTENCE_ENDED_BY_ATTACK"; systemId: SystemId; planetId: PlanetId; attackingPlayerId: PlayerId; targetPlayerId: PlayerId }
  | { type: "BREAKTHROUGH_GAINED"; playerId: PlayerId }
  | { type: "FRACTURE_ENTERED_PLAY"; triggeredByPlayerId: PlayerId }
  | { type: "FRACTURE_NEUTRAL_UNITS_PLACED" }
  | { type: "INGRESS_TOKENS_PLACED"; playerId: PlayerId; systemIds: SystemId[] }
  | { type: "COMMODITIES_CONVERTED_VIA_SPACE_STATION"; playerId: PlayerId; amount: number }
  | { type: "TRANSACTION_RESOLVED"; playerId: PlayerId; otherPlayerId: PlayerId }
  | { type: "EXTREME_DURESS_TRIGGERED"; armedPlayerId: PlayerId; casterId: PlayerId; secretObjectiveIds: string[] }
  | { type: "EXPEDITION_SLICE_CLAIMED"; playerId: PlayerId; slice: import("./enums").ThunderEdgeExpeditionSliceCost }
  | { type: "THUNDER_EDGE_EXPEDITION_COMPLETED"; systemId: SystemId; infantryPlacingPlayerId: PlayerId; infantryCount: number }
  | { type: "BOMBARDMENT_RESOLVED"; playerId: PlayerId; systemId: SystemId; planetId: PlanetId; hits: number; targetPlayerId?: PlayerId }
  | { type: "GROUND_COMBAT_ENDED"; systemId: SystemId; planetId: PlanetId; survivingPlayerId: PlayerId | null }
  | { type: "PLANET_CONTROL_ESTABLISHED"; systemId: SystemId; planetId: PlanetId; playerId: PlayerId }
  | { type: "UNITS_PRODUCED"; playerId: PlayerId; systemId: SystemId; planetId?: PlanetId; unitType: UnitType; count: number; totalCost: number }
  | { type: "OBJECTIVE_SCORED"; playerId: PlayerId; objectiveId: ObjectiveId; points: number }
  | { type: "PUBLIC_OBJECTIVE_REVEALED"; objectiveId: ObjectiveId; kind: ObjectiveKind }
  | { type: "ACTION_CARD_DRAWN"; playerId: PlayerId; cardId: ActionCardId }
  | { type: "ACTION_CARD_PLAYED"; playerId: PlayerId; cardId: ActionCardId }
  | { type: "ACTION_CARD_DISCARDED"; playerId: PlayerId; cardId: ActionCardId }
  | { type: "TRADE_GOODS_GAINED"; playerId: PlayerId; amount: number }
  | { type: "PLANET_READIED"; playerId: PlayerId; planetId: PlanetId }
  | { type: "PLANET_EXHAUSTED"; playerId: PlayerId; planetId: PlanetId }
  | { type: "LAW_REPEALED"; agendaId: AgendaId }
  | { type: "AGENDA_PREDICTION_MADE"; playerId: PlayerId; predictedOutcome: string }
  | { type: "AGENDA_PREDICTION_RESOLVED"; playerId: PlayerId; correct: boolean }
  | { type: "VICTORY_POINT_GAINED"; playerId: PlayerId; amount: number }
  | { type: "SPEAKER_CHANGED"; playerId: PlayerId }
  | { type: "COMMAND_TOKENS_GAINED"; playerId: PlayerId; tactic: number; fleet: number; strategy: number }
  | { type: "PROMISSORY_NOTE_TRANSFERRED"; fromPlayerId: PlayerId; toPlayerId: PlayerId; promissoryNoteId: PromissoryNoteId }
  | {
      type: "PRIORITY_WINDOW_CLOSED";
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
    }
  | { type: "ACTION_CARD_ANNOUNCED"; playerId: PlayerId; cardId: ActionCardId }
  | { type: "ACTION_CARD_CANCELLED"; playerId: PlayerId; cardId: ActionCardId; cancelledBy: PlayerId }
  | { type: "ELECTED_PLAYER_CHANGED"; agendaId: AgendaId; fromPlayerId: PlayerId; toPlayerId: PlayerId }
  | { type: "AGENDA_REVEALED"; agendaId: AgendaId }
  | { type: "VOTES_CAST"; playerId: PlayerId; outcome: string; votes: number }
  | { type: "AGENDA_RESOLVED"; agendaId: AgendaId; outcome: string; becameLaw: boolean }
  | { type: "PHASE_CHANGED"; from: string; to: string; round: number }
  | { type: "ROUND_STARTED"; round: number }
  | { type: "EXPLORATION_CARD_DRAWN"; playerId: PlayerId; cardId: string; deck: "cultural" | "industrial" | "hazardous" | "frontier" }
  | { type: "RELIC_FRAGMENT_GAINED"; playerId: PlayerId; fragmentType: "cultural" | "industrial" | "hazardous" | "any" }
  | { type: "RELIC_GAINED"; playerId: PlayerId; relicId: string }
  | { type: "RELIC_PURGED"; playerId: PlayerId; relicId: string }
  | { type: "PLANET_DESTROYED"; systemId: SystemId; planetId: PlanetId }
  | { type: "HEART_OF_IXTH_ADJUSTED_ROLL"; playerId: PlayerId; originalRoll: number; adjustedRoll: number }
  | { type: "COMMAND_TOKENS_RETURNED_TO_REINFORCEMENTS"; playerId: PlayerId; count: number }
  | { type: "HARROW_HITS_SCORED"; playerId: PlayerId; targetPlayerId: PlayerId; hits: number }
  | { type: "PILLAGE_USED"; playerId: PlayerId; targetPlayerId: PlayerId; took: "trade_good" | "commodity" }
  | { type: "GAME_ENDED"; winnerId: PlayerId }
  | { type: "PLAYER_ELIMINATED"; playerId: PlayerId };

export type ActionResult =
  | { ok: true; state: import("./GameState").GameState; events: GameEvent[] }
  | { ok: false; error: string };
