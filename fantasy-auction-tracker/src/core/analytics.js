/**
 * Live auction analytics.
 *
 * Everything here is a pure function of (state, valuationIndex). The numbers
 * that matter in a live auction, roughly in order of how much edge they carry:
 *
 *   1. inflation      -- what a dollar of "par value" actually costs right now
 *   2. maxBid per team -- who can physically outbid you, and by how much
 *   3. scarcity        -- how many startable players remain vs. how many are needed
 *   4. surplus         -- your value minus the price on the board
 *
 * None of it is worth anything if the underlying draft log is wrong, so
 * consumers should check `state.warnings` and `state.needsReview` too.
 */

import { allTeamSummaries } from './reducer.js';
import { startersByPosition, slotAccepts, rosterSize } from './config.js';
import { POSITIONS, playerKey } from './players.js';
import {
  targetFor, effectivePrice, tierPressure, planFeasibility, targetStatus,
} from './targets.js';

/**
 * playerKey -> valuation, cached per valuation array.
 *
 * Every analytic needs to look a sale up by key. Doing that with a linear
 * find turns each snapshot into O(sales x players), which is fine in a test
 * and not fine when it runs on every frame of a live auction.
 */
const keyIndexCache = new WeakMap();

function valuationIndex(valuations) {
  let index = keyIndexCache.get(valuations);
  if (!index) {
    index = new Map(valuations.map((p) => [playerKey(p.name, p.position), p]));
    keyIndexCache.set(valuations, index);
  }
  return index;
}

/** Look up the par valuation for a drafted player, or null. */
export function valuationFor(valuations, key) {
  return valuationIndex(valuations).get(key) ?? null;
}

/** Players from the valuation set that have not been sold. */
export function availablePlayers(state, valuations) {
  return valuations.filter((p) => !state.drafted.has(playerKey(p.name, p.position)));
}

/**
 * Market inflation.
 *
 * Naive form is remainingMoney / remainingValue. That overstates things,
 * because every open roster spot has $1 pinned to it that can never chase
 * value. The discretionary form removes that floor from both sides and is the
 * number to actually bid off.
 *
 * >1 means players are going for more than par (you must overpay or lose out);
 * <1 means bargains are ahead and you should sit on your money.
 */
export function inflation(state, valuations) {
  const teams = allTeamSummaries(state);
  const config = state.config;
  const size = rosterSize(config);

  // Teams that have not appeared in the log yet still hold a full budget.
  const knownSpent = teams.reduce((s, t) => s + t.spent, 0);
  const knownFilled = teams.reduce((s, t) => s + t.roster.length, 0);
  const totalMoney = config.numTeams * config.budget;
  const remainingMoney = totalMoney - knownSpent;
  const openSpots = config.numTeams * size - knownFilled;

  const avail = availablePlayers(state, valuations)
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(0, openSpots));
  const remainingValue = avail.reduce((s, p) => s + p.value, 0);

  const floor = openSpots * config.minBid;
  const discMoney = remainingMoney - floor;
  const discValue = remainingValue - floor;

  const raw = remainingValue > 0 ? remainingMoney / remainingValue : 1;
  const discretionary = discValue > 0 ? discMoney / discValue : 1;

  return {
    raw,
    discretionary,
    remainingMoney,
    remainingValue,
    openSpots,
    /** Dollars spent above/below par so far -- the cause of the inflation. */
    surplusSpent: state.history.reduce((s, sale) => {
      const v = valuationFor(valuations, sale.playerKey);
      return s + (v ? sale.price - v.value : 0);
    }, 0),
  };
}

/** Same computation restricted to one position, over the teams that still need it. */
export function positionalInflation(state, valuations, position) {
  const config = state.config;
  const teams = allTeamSummaries(state);

  const needyTeams = teams.filter((t) =>
    t.slots.some((s) => !s.filled && slotAccepts(s.type, position)),
  );
  if (!needyTeams.length) return { rate: 1, demand: 0, supply: 0 };

  const demand = needyTeams.reduce(
    (s, t) => s + t.slots.filter((x) => !x.filled && slotAccepts(x.type, position)).length,
    0,
  );
  const money = needyTeams.reduce((s, t) => s + t.maxBid, 0);

  const pool = availablePlayers(state, valuations)
    .filter((p) => p.position === position)
    .sort((a, b) => b.value - a.value)
    .slice(0, demand);
  const value = pool.reduce((s, p) => s + p.value, 0);

  return {
    rate: value > 0 ? money / value : 1,
    demand,
    supply: pool.length,
    money,
    value,
  };
}

/**
 * Scarcity per position: how many startable players are left against how many
 * starting slots the league still has to fill. Below 1.0 means a run is coming.
 */
export function scarcity(state, valuations) {
  const starters = startersByPosition(state.config);
  const teams = allTeamSummaries(state);
  const out = {};

  for (const pos of POSITIONS) {
    const avail = availablePlayers(state, valuations)
      .filter((p) => p.position === pos)
      .sort((a, b) => b.value - a.value);

    // Replacement level: the (numTeams * startersAtPos)-th best at the position.
    const replacementRank = Math.max(1, Math.round(starters[pos] ?? 0));
    const all = valuations.filter((p) => p.position === pos)
      .sort((a, b) => b.value - a.value);
    const replacementValue = all[replacementRank - 1]?.value ?? state.config.minBid;

    const startable = avail.filter((p) => p.value > replacementValue).length;
    const openStarterSlots = teams.reduce(
      (s, t) => s + t.slots.filter(
        (x) => !x.filled && x.type !== 'BN' && slotAccepts(x.type, pos),
      ).length,
      0,
    );

    out[pos] = {
      available: avail.length,
      startable,
      openStarterSlots,
      replacementValue,
      /** <1 means more demand than startable supply. */
      ratio: openStarterSlots > 0 ? startable / openStarterSlots : Infinity,
      topAvailable: avail.slice(0, 5),
    };
  }
  return out;
}

/**
 * Gap between the best available at a position and the next one down.
 * A large cliff justifies paying above par -- losing this player costs you the
 * whole gap, not a dollar.
 */
export function tierCliff(state, valuations, position) {
  const avail = availablePlayers(state, valuations)
    .filter((p) => p.position === position)
    .sort((a, b) => b.value - a.value);
  if (avail.length < 2) return { cliff: avail[0]?.value ?? 0, next: null, best: avail[0] ?? null };
  return { cliff: avail[0].value - avail[1].value, best: avail[0], next: avail[1] };
}

/**
 * Which rival teams can still bid on the player currently on the block, and
 * what the highest bid any of them can make is.
 */
export function liveBidders(state, position, { excludeTeamId = null } = {}) {
  return allTeamSummaries(state)
    .filter((t) => t.teamId !== excludeTeamId)
    .filter((t) => t.slots.some((s) => !s.filled && slotAccepts(s.type, position)))
    .map((t) => ({ teamId: t.teamId, teamName: t.teamName, maxBid: t.maxBid, remaining: t.remaining }))
    .sort((a, b) => b.maxBid - a.maxBid);
}

/**
 * The recommendation for the player on the block.
 *
 * walkAway is the disciplined number: par value moved by inflation, so it
 * tracks the market you are actually in rather than the one the CSV assumed.
 * ceiling adds a slice of the tier cliff, because in a thin position the
 * alternative to overpaying is a materially worse roster. Both are hard-capped
 * by what you can legally bid.
 */
export function bidAdvice(state, valuations, {
  aggressiveness = 0.5,
  targets = [],
  autoAdjustTargets = false,
} = {}) {
  const nom = state.nomination;
  if (!nom) return null;

  const config = state.config;
  const me = allTeamSummaries(state).find((t) => t.teamId === config.myTeamId) ?? null;
  const val = valuationFor(valuations, nom.playerKey);
  const inf = inflation(state, valuations);
  const posInf = positionalInflation(state, valuations, nom.position);
  const cliff = tierCliff(state, valuations, nom.position);
  const rivals = liveBidders(state, nom.position, { excludeTeamId: config.myTeamId });

  const parValue = val?.value ?? 0;
  const marketValue = parValue * inf.discretionary;

  // An explicit price target is the user's own number and outranks anything
  // derived from the CSV -- that is the whole point of setting one. The market
  // figure is still reported alongside so divergence is visible rather than
  // silently overridden.
  const target = targetFor(targets, nom.playerKey);
  const targetPrice = target
    ? effectivePrice(target, {
      parValue, inflation: inf.discretionary, autoAdjust: autoAdjustTargets,
    })
    : null;

  const basis = targetPrice != null ? targetPrice : marketValue;
  const walkAway = Math.round(basis);

  // A target's price is a ceiling you chose, so the cliff allowance does not
  // get to push past it. Without a target, the cliff is what justifies going
  // over par on a thin position.
  const rawCeiling = targetPrice != null
    ? targetPrice
    : basis + aggressiveness * Math.max(0, cliff.cliff);

  const iCanFit = me
    ? me.slots.some((s) => !s.filled && slotAccepts(s.type, nom.position))
    : true;
  const myMax = me ? me.maxBid : Infinity;
  const ceiling = Math.max(0, Math.min(Math.round(rawCeiling), myMax));

  let verdict;
  if (!val && !target) verdict = 'unvalued';
  else if (!iCanFit) verdict = 'no-slot';
  else if (nom.highBid >= ceiling) verdict = 'pass';
  else if (nom.highBid < walkAway) verdict = 'bid';
  else verdict = 'stretch';

  return {
    player: nom.name,
    position: nom.position,
    currentBid: nom.highBid,
    highBidder: nom.highBidder,
    parValue,
    adjustedValue: Math.round(marketValue * 10) / 10,
    walkAway,
    ceiling,
    surplus: Math.round((basis - nom.highBid) * 10) / 10,
    tierCliff: Math.round(cliff.cliff * 10) / 10,
    nextBest: cliff.next?.name ?? null,
    inflation: Math.round(inf.discretionary * 100) / 100,
    positionalInflation: Math.round(posInf.rate * 100) / 100,
    myMaxBid: Number.isFinite(myMax) ? myMax : null,
    topRival: rivals[0] ?? null,
    /** Rivals who could still take this player away from you at `ceiling`. */
    threats: rivals.filter((r) => r.maxBid > nom.highBid).length,
    /** Set when the player is on your board. */
    isTarget: Boolean(target),
    targetTier: target?.tier ?? null,
    targetPrice,
    targetNote: target?.note || null,
    /** How far your target sits from the market read, in dollars. */
    targetVsMarket: targetPrice != null ? Math.round(targetPrice - marketValue) : null,
    verdict,
  };
}

/**
 * Teams about to be forced into $1 bids. These are the teams that can no
 * longer compete on price -- nominate expensive players you do not want while
 * the field can still afford them.
 */
export function budgetPressure(state) {
  return allTeamSummaries(state)
    .map((t) => ({
      teamId: t.teamId,
      teamName: t.teamName,
      remaining: t.remaining,
      openSlots: t.openSlots,
      maxBid: t.maxBid,
      /** 1.0 = every remaining dollar is committed to $1 bids. */
      locked: t.openSlots > 0 ? (t.openSlots * state.config.minBid) / Math.max(1, t.remaining) : 1,
    }))
    .sort((a, b) => b.locked - a.locked);
}

/** One call for the whole sidebar, so the UI never assembles analytics itself. */
export function snapshot(state, valuations, opts = {}) {
  const targets = opts.targets ?? [];
  const inf = inflation(state, valuations);
  return {
    tiers: tierPressure(state, targets),
    plan: planFeasibility(state, targets, {
      valuations,
      inflation: inf.discretionary,
      autoAdjust: opts.autoAdjustTargets ?? false,
    }),
    // The board with live status plus the price actually in force, so the
    // Targets tab shows what auto-adjust is doing rather than the raw input.
    targetBoard: targetStatus(state, targets).map((t) => ({
      ...t,
      parValue: valuationFor(valuations, t.key)?.value ?? null,
      effective: effectivePrice(t, {
        parValue: valuationFor(valuations, t.key)?.value ?? null,
        inflation: inf.discretionary,
        autoAdjust: opts.autoAdjustTargets ?? false,
      }),
    })),
    autoAdjustTargets: opts.autoAdjustTargets ?? false,
    teams: allTeamSummaries(state).map((t) => ({
      teamId: t.teamId,
      teamName: t.teamName,
      spent: t.spent,
      remaining: t.remaining,
      openSlots: t.openSlots,
      maxBid: t.maxBid,
      needs: t.needs,
      roster: t.roster,
    })),
    inflation: inf,
    scarcity: scarcity(state, valuations),
    pressure: budgetPressure(state),
    advice: bidAdvice(state, valuations, opts),
    nomination: state.nomination,
    // Attach par value so the ticker can show over/under-pay without the UI
    // reaching into the valuation set itself.
    history: state.history.slice(-25).reverse().map((sale) => ({
      ...sale,
      parValue: valuationFor(valuations, sale.playerKey)?.value ?? null,
    })),
    warnings: state.warnings,
    needsReview: state.needsReview,
    complete: state.complete,
  };
}
