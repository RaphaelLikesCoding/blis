import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EventType, makeEvent } from '../src/core/events.js';
import { reduce } from '../src/core/reducer.js';
import { DEFAULT_CONFIG, expandSlots } from '../src/core/config.js';
import { bidAdvice, snapshot } from '../src/core/analytics.js';
import {
  makeTarget, buildTargets, seedFromValuations, effectivePrice,
  targetStatus, tierSummary, tierPressure, planFeasibility, findByName,
} from '../src/core/targets.js';

const config = {
  ...DEFAULT_CONFIG,
  numTeams: 2,
  budget: 100,
  minBid: 1,
  myTeamId: 'me',
  rosterSlots: expandSlots({ RB: 2, WR: 2 }),
};

const valuations = [
  { name: 'RB A', position: 'RB', value: 40 },
  { name: 'RB B', position: 'RB', value: 30 },
  { name: 'RB C', position: 'RB', value: 20 },
  { name: 'RB D', position: 'RB', value: 10 },
  { name: 'WR A', position: 'WR', value: 40 },
  { name: 'WR B', position: 'WR', value: 30 },
  { name: 'WR C', position: 'WR', value: 20 },
  { name: 'WR D', position: 'WR', value: 10 },
];

const sold = (name, pos, teamId, price, id) =>
  makeEvent(EventType.SOLD, {
    playerName: name, position: pos, teamId, teamName: teamId, price,
  }, { id, source: 'ws' });

const register = (teamId) =>
  makeEvent(EventType.TEAM_REGISTERED, { teamId, teamName: teamId }, { id: `r-${teamId}` });

const nominate = (name, pos, bid) => makeEvent(EventType.NOMINATION, {
  playerName: name, position: pos, openingBid: bid,
}, { id: `n-${name}` });

// --- construction -----------------------------------------------------------

test('a target normalizes its name, position and key', () => {
  const t = makeTarget({ name: 'Marvin Harrison Jr.', position: 'wr', tier: 2, maxPrice: 35 });
  assert.equal(t.key, 'marvin harrison|WR');
  assert.equal(t.position, 'WR');
  assert.equal(t.tier, 2);
  assert.equal(t.maxPrice, 35);
});

test('tier defaults to 1 and is clamped to a positive integer', () => {
  assert.equal(makeTarget({ name: 'A B', position: 'RB' }).tier, 1);
  assert.equal(makeTarget({ name: 'A B', position: 'RB', tier: 0 }).tier, 1);
  assert.equal(makeTarget({ name: 'A B', position: 'RB', tier: 2.6 }).tier, 3);
});

test('a missing price stays null rather than becoming zero', () => {
  assert.equal(makeTarget({ name: 'A B', position: 'RB' }).maxPrice, null);
});

test('building sorts by tier then price, and later edits replace earlier ones', () => {
  const list = buildTargets([
    { name: 'Cheap Guy', position: 'RB', tier: 2, maxPrice: 5 },
    { name: 'RB A', position: 'RB', tier: 1, maxPrice: 20 },
    { name: 'RB A', position: 'RB', tier: 1, maxPrice: 45 }, // edited
    { name: 'Pricey Guy', position: 'WR', tier: 1, maxPrice: 50 },
  ]);

  assert.deepEqual(list.map((t) => t.name), ['Pricey Guy', 'RB A', 'Cheap Guy']);
  assert.equal(list.find((t) => t.name === 'RB A').maxPrice, 45, 'the later edit wins');
});

test('seeding uses the CSV tier column when it exists', () => {
  const withTiers = [
    { name: 'RB A', position: 'RB', value: 40, tier: 1 },
    { name: 'WR A', position: 'WR', value: 30, tier: 3 },
  ];
  const seeded = seedFromValuations(withTiers);
  assert.equal(seeded.find((t) => t.name === 'RB A').tier, 1);
  assert.equal(seeded.find((t) => t.name === 'WR A').tier, 3);
});

test('seeding bands by value when the CSV has no tiers', () => {
  const seeded = seedFromValuations(valuations, { topN: 8, tierCount: 4 });
  assert.equal(seeded.length, 8);
  assert.equal(new Set(seeded.map((t) => t.tier)).size, 4, 'four bands of two');
  assert.equal(seeded[0].tier, 1, 'the most valuable player lands in tier 1');
  assert.equal(seeded[0].maxPrice, 40, 'price target seeded from par value');
});

test('seeding can be restricted to positions you care about', () => {
  const seeded = seedFromValuations(valuations, { positions: ['RB'] });
  assert.ok(seeded.every((t) => t.position === 'RB'));
});

// --- pricing ----------------------------------------------------------------

test('an explicit price is used as written when auto-adjust is off', () => {
  const t = makeTarget({ name: 'RB A', position: 'RB', maxPrice: 40 });
  assert.equal(effectivePrice(t, { inflation: 1.5, autoAdjust: false }), 40);
});

test('auto-adjust scales the price by market inflation', () => {
  const t = makeTarget({ name: 'RB A', position: 'RB', maxPrice: 40 });
  assert.equal(effectivePrice(t, { inflation: 1.2, autoAdjust: true }), 48);
  assert.equal(effectivePrice(t, { inflation: 0.5, autoAdjust: true }), 20);
});

test('a target with no price falls back to par value', () => {
  const t = makeTarget({ name: 'RB A', position: 'RB' });
  assert.equal(effectivePrice(t, { parValue: 33 }), 33);
  assert.equal(effectivePrice(t, { parValue: null }), null);
});

// --- status and tiers -------------------------------------------------------

test('target status tracks won, lost and open', () => {
  const targets = buildTargets([
    { name: 'RB A', position: 'RB', tier: 1, maxPrice: 40 },
    { name: 'RB B', position: 'RB', tier: 1, maxPrice: 30 },
    { name: 'WR A', position: 'WR', tier: 2, maxPrice: 40 },
  ]);
  const state = reduce([
    register('me'), register('you'),
    sold('RB A', 'RB', 'me', 38, 'e1'),
    sold('RB B', 'RB', 'you', 44, 'e2'),
  ], { config });

  const status = targetStatus(state, targets);
  const byName = Object.fromEntries(status.map((t) => [t.name, t]));

  assert.equal(byName['RB A'].status, 'won');
  assert.equal(byName['RB A'].soldFor, 38);
  assert.equal(byName['RB B'].status, 'lost');
  assert.equal(byName['RB B'].wonBy, 'you');
  assert.equal(byName['RB B'].overshoot, 14, 'went $14 past your target');
  assert.equal(byName['WR A'].status, 'open');
});

test('tier summary rolls up counts and money per tier', () => {
  const targets = buildTargets([
    { name: 'RB A', position: 'RB', tier: 1, maxPrice: 40 },
    { name: 'RB B', position: 'RB', tier: 1, maxPrice: 30 },
    { name: 'WR A', position: 'WR', tier: 2, maxPrice: 25 },
  ]);
  const state = reduce([register('me'), register('you'), sold('RB A', 'RB', 'me', 38, 'e1')], { config });

  const [tier1, tier2] = tierSummary(state, targets);
  assert.equal(tier1.tier, 1);
  assert.equal(tier1.total, 2);
  assert.equal(tier1.won, 1);
  assert.equal(tier1.open, 1);
  assert.equal(tier1.spent, 38);
  assert.equal(tier1.plannedCost, 30, 'only the still-open target counts as planned');
  assert.equal(tier2.open, 1);
});

test('tier pressure flags a tier that is nearly or fully gone', () => {
  const targets = buildTargets([
    { name: 'RB A', position: 'RB', tier: 1, maxPrice: 40 },
    { name: 'RB B', position: 'RB', tier: 1, maxPrice: 30 },
    { name: 'WR A', position: 'WR', tier: 2, maxPrice: 25 },
  ]);
  const state = reduce([
    register('me'), register('you'),
    sold('RB A', 'RB', 'you', 38, 'e1'),
    sold('WR A', 'WR', 'you', 25, 'e2'),
  ], { config });

  const [tier1, tier2] = tierPressure(state, targets);
  assert.equal(tier1.depletion, 0.5);
  assert.equal(tier1.critical, true, 'one name left is critical');
  assert.equal(tier2.exhausted, true);
  assert.equal(tier2.critical, false, 'exhausted is not critical, it is over');
});

// --- plan feasibility -------------------------------------------------------

test('an affordable plan reports headroom', () => {
  // 4 slots, $100. Targets cost $60, leaving $40 of room.
  const targets = buildTargets([
    { name: 'RB A', position: 'RB', tier: 1, maxPrice: 30 },
    { name: 'WR A', position: 'WR', tier: 1, maxPrice: 30 },
  ]);
  const state = reduce([register('me')], { config });
  const plan = planFeasibility(state, targets, { valuations });

  assert.equal(plan.feasible, true);
  assert.equal(plan.plannedCost, 60);
  assert.equal(plan.reserve, 2, '$1 each for the two slots the plan does not cover');
  assert.equal(plan.required, 62);
  assert.equal(plan.headroom, 38);
  assert.equal(plan.shortfall, 0);
});

test('an unaffordable plan reports the exact shortfall', () => {
  const targets = buildTargets([
    { name: 'RB A', position: 'RB', tier: 1, maxPrice: 60 },
    { name: 'WR A', position: 'WR', tier: 1, maxPrice: 60 },
  ]);
  const state = reduce([register('me')], { config });
  const plan = planFeasibility(state, targets, { valuations });

  assert.equal(plan.feasible, false);
  assert.equal(plan.required, 122, '$120 of targets plus $2 reserve');
  assert.equal(plan.shortfall, 22);
});

test('the plan only counts targets that fit a remaining roster slot', () => {
  // Three RB targets but only two RB slots and no flex.
  const targets = buildTargets([
    { name: 'RB A', position: 'RB', tier: 1, maxPrice: 20 },
    { name: 'RB B', position: 'RB', tier: 1, maxPrice: 20 },
    { name: 'RB C', position: 'RB', tier: 2, maxPrice: 20 },
  ]);
  const state = reduce([register('me')], { config });
  const plan = planFeasibility(state, targets, { valuations });

  assert.equal(plan.plan.length, 2);
  assert.equal(plan.unslotted.length, 1);
  assert.equal(plan.unslotted[0].name, 'RB C', 'the lowest tier is the one that does not fit');
  assert.equal(plan.plannedCost, 40);
});

test('the plan shrinks as slots fill and money is spent', () => {
  const targets = buildTargets([
    { name: 'RB A', position: 'RB', tier: 1, maxPrice: 30 },
    { name: 'RB B', position: 'RB', tier: 1, maxPrice: 30 },
    { name: 'WR A', position: 'WR', tier: 1, maxPrice: 30 },
  ]);
  const state = reduce([register('me'), sold('RB A', 'RB', 'me', 30, 'e1')], { config });
  const plan = planFeasibility(state, targets, { valuations });

  assert.equal(plan.budget, 70, 'spent money is gone');
  assert.equal(plan.openSlots, 3);
  assert.deepEqual(plan.plan.map((p) => p.name), ['RB B', 'WR A'], 'the won target drops out');
  assert.equal(plan.plannedCost, 60);
});

test('plan prices follow auto-adjust', () => {
  const targets = buildTargets([{ name: 'RB A', position: 'RB', tier: 1, maxPrice: 30 }]);
  const state = reduce([register('me')], { config });

  const flat = planFeasibility(state, targets, { valuations, inflation: 1.5, autoAdjust: false });
  const scaled = planFeasibility(state, targets, { valuations, inflation: 1.5, autoAdjust: true });

  assert.equal(flat.plannedCost, 30);
  assert.equal(scaled.plannedCost, 45);
});

test('a full roster yields an empty but feasible plan', () => {
  const targets = buildTargets([{ name: 'RB C', position: 'RB', tier: 1, maxPrice: 20 }]);
  const state = reduce([
    register('me'),
    sold('RB A', 'RB', 'me', 25, 'e1'), sold('RB B', 'RB', 'me', 25, 'e2'),
    sold('WR A', 'WR', 'me', 25, 'e3'), sold('WR B', 'WR', 'me', 25, 'e4'),
  ], { config });
  const plan = planFeasibility(state, targets, { valuations });

  assert.equal(plan.openSlots, 0);
  assert.equal(plan.plan.length, 0);
  assert.equal(plan.feasible, true);
});

// --- integration with bid advice --------------------------------------------

test('a price target overrides the market-derived ceiling', () => {
  const targets = buildTargets([{ name: 'RB A', position: 'RB', tier: 1, maxPrice: 25 }]);
  const state = reduce([register('me'), register('you'), nominate('RB A', 'RB', 30)], { config });

  const withTarget = bidAdvice(state, valuations, { targets, aggressiveness: 1 });
  const without = bidAdvice(state, valuations, { targets: [], aggressiveness: 1 });

  assert.equal(withTarget.isTarget, true);
  assert.equal(withTarget.targetTier, 1);
  assert.equal(withTarget.ceiling, 25, 'your number, not the market cliff');
  assert.equal(withTarget.verdict, 'pass', '$30 is past your $25 target');
  assert.ok(without.ceiling > withTarget.ceiling, 'the cliff allowance is disabled by an explicit target');
});

test('a target above the market read still advises bidding', () => {
  const targets = buildTargets([{ name: 'RB A', position: 'RB', tier: 1, maxPrice: 55 }]);
  const state = reduce([register('me'), register('you'), nominate('RB A', 'RB', 45)], { config });
  const a = bidAdvice(state, valuations, { targets });

  assert.equal(a.verdict, 'bid');
  assert.equal(a.walkAway, 55);
  assert.ok(a.targetVsMarket > 0, 'you value him above par and it is shown');
});

test('a targeted player with no valuation is still actionable', () => {
  const targets = buildTargets([{ name: 'Deep Sleeper', position: 'RB', tier: 3, maxPrice: 8 }]);
  const state = reduce([register('me'), nominate('Deep Sleeper', 'RB', 3)], { config });
  const a = bidAdvice(state, valuations, { targets });

  assert.notEqual(a.verdict, 'unvalued', 'your own target is a valuation');
  assert.equal(a.verdict, 'bid');
  assert.equal(a.ceiling, 8);
});

test('your max bid still caps an over-ambitious target', () => {
  const targets = buildTargets([{ name: 'RB A', position: 'RB', tier: 1, maxPrice: 90 }]);
  const state = reduce([
    register('me'), register('you'),
    sold('WR A', 'WR', 'me', 97, 'e1'),
    nominate('RB A', 'RB', 1),
  ], { config });

  const a = bidAdvice(state, valuations, { targets });
  assert.equal(a.myMaxBid, 1);
  assert.equal(a.ceiling, 1, 'never advise a bid you cannot make, target or not');
});

test('auto-adjust moves the target with the market', () => {
  const targets = buildTargets([{ name: 'RB A', position: 'RB', tier: 1, maxPrice: 30 }]);
  // Big overpays early push inflation down for what remains.
  const state = reduce([
    register('me'), register('you'),
    sold('WR A', 'WR', 'you', 60, 'e1'),
    nominate('RB A', 'RB', 20),
  ], { config });

  const flat = bidAdvice(state, valuations, { targets, autoAdjustTargets: false });
  const scaled = bidAdvice(state, valuations, { targets, autoAdjustTargets: true });

  assert.equal(flat.targetPrice, 30);
  assert.notEqual(scaled.targetPrice, 30, 'the target tracks the market when asked to');
});

test('snapshot exposes the board, tiers and plan for the sidebar', () => {
  const targets = buildTargets([
    { name: 'RB A', position: 'RB', tier: 1, maxPrice: 30 },
    { name: 'WR A', position: 'WR', tier: 2, maxPrice: 20 },
  ]);
  const state = reduce([register('me'), register('you'), sold('RB A', 'RB', 'you', 40, 'e1')], { config });
  const snap = snapshot(state, valuations, { targets });

  assert.equal(snap.targetBoard.length, 2);
  assert.equal(snap.targetBoard.find((t) => t.name === 'RB A').status, 'lost');
  assert.equal(snap.tiers.length, 2);
  assert.ok(snap.plan.plannedCost > 0);
  assert.equal(snap.autoAdjustTargets, false);
});

test('findByName tolerates suffix and punctuation differences', () => {
  const targets = buildTargets([{ name: 'Marvin Harrison Jr.', position: 'WR', maxPrice: 30 }]);
  assert.ok(findByName(targets, 'Marvin Harrison', 'WR'));
  assert.equal(findByName(targets, 'Somebody Else', 'WR'), null);
});

test('an empty board changes nothing', () => {
  const state = reduce([register('me'), nominate('RB A', 'RB', 10)], { config });
  const a = bidAdvice(state, valuations, { targets: [] });
  assert.equal(a.isTarget, false);
  assert.equal(a.targetPrice, null);

  const plan = planFeasibility(state, [], { valuations });
  assert.equal(plan.feasible, true);
  assert.equal(plan.plannedCost, 0);
});
