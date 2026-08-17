import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EventType, makeEvent } from '../src/core/events.js';
import { reduce } from '../src/core/reducer.js';
import { DEFAULT_CONFIG, expandSlots } from '../src/core/config.js';
import {
  inflation, positionalInflation, scarcity, tierCliff,
  liveBidders, bidAdvice, budgetPressure, availablePlayers,
} from '../src/core/analytics.js';

const config = {
  ...DEFAULT_CONFIG,
  numTeams: 2,
  budget: 100,
  minBid: 1,
  myTeamId: 'me',
  rosterSlots: expandSlots({ RB: 2, WR: 2 }),
};

/** 8 players at $25 par each: 2 teams x 4 slots, $200 total, exactly at par. */
const valuations = [
  { name: 'RB A', position: 'RB', value: 25 },
  { name: 'RB B', position: 'RB', value: 25 },
  { name: 'RB C', position: 'RB', value: 25 },
  { name: 'RB D', position: 'RB', value: 25 },
  { name: 'WR A', position: 'WR', value: 25 },
  { name: 'WR B', position: 'WR', value: 25 },
  { name: 'WR C', position: 'WR', value: 25 },
  { name: 'WR D', position: 'WR', value: 25 },
];

const sold = (name, pos, teamId, price, id) =>
  makeEvent(EventType.SOLD, {
    playerName: name, position: pos, teamId, teamName: teamId, price,
  }, { id, source: 'ws' });

const register = (teamId) =>
  makeEvent(EventType.TEAM_REGISTERED, { teamId, teamName: teamId }, { id: `r-${teamId}` });

const nominate = (name, pos, bid, bidder) => makeEvent(EventType.NOMINATION, {
  playerName: name, position: pos, openingBid: bid, nominatingTeamId: bidder,
}, { id: `n-${name}` });

test('a perfectly par market has inflation 1.0', () => {
  const state = reduce([register('me'), register('you')], { config });
  const inf = inflation(state, valuations);

  assert.equal(inf.remainingMoney, 200);
  assert.equal(inf.remainingValue, 200);
  assert.equal(inf.raw, 1);
  assert.equal(inf.discretionary, 1);
});

test('overpaying early inflates the remaining market', () => {
  // $25 player goes for $45: $20 of value left the pool but $45 of money did.
  const state = reduce([register('me'), register('you'), sold('RB A', 'RB', 'you', 45, 'e1')], { config });
  const inf = inflation(state, valuations);

  assert.equal(inf.remainingMoney, 155);
  assert.equal(inf.remainingValue, 175);
  assert.equal(inf.surplusSpent, 20);
  assert.ok(inf.discretionary < 1, 'money left the pool faster than value');
});

test('bargains early deflate the remaining market', () => {
  const state = reduce([register('me'), register('you'), sold('RB A', 'RB', 'you', 5, 'e1')], { config });
  const inf = inflation(state, valuations);

  assert.equal(inf.surplusSpent, -20);
  assert.ok(inf.discretionary > 1, 'money outlasted value, so prices rise');
});

test('discretionary inflation strips the $1-per-slot floor from both sides', () => {
  const state = reduce([register('me'), register('you')], { config });
  const inf = inflation(state, valuations);

  // 4 open spots per team x 2 = 8 spots, so $8 is pinned and cannot chase value.
  assert.equal(inf.openSpots, 8);
  // Raw and discretionary agree only because this market is exactly at par.
  assert.equal(inf.raw, inf.discretionary);
});

test('max bid caps what a rival can actually pay', () => {
  const state = reduce([
    register('me'), register('you'),
    sold('RB A', 'RB', 'you', 97, 'e1'),
  ], { config });

  const rivals = liveBidders(state, 'WR', { excludeTeamId: 'me' });
  // $3 left, 3 open slots -> can bid $1 and still fill the rest at $1.
  assert.equal(rivals[0].maxBid, 1);
});

test('a team with no eligible open slot is not a live bidder', () => {
  const state = reduce([
    register('me'), register('you'),
    sold('RB A', 'RB', 'you', 10, 'e1'),
    sold('RB B', 'RB', 'you', 10, 'e2'),
  ], { config });

  const rivals = liveBidders(state, 'RB', { excludeTeamId: 'me' });
  assert.equal(rivals.length, 0, 'both RB slots are full and there is no flex');
});

test('scarcity counts startable players against unfilled starting slots', () => {
  const state = reduce([register('me'), register('you')], { config });
  const s = scarcity(state, valuations);

  assert.equal(s.RB.available, 4);
  assert.equal(s.RB.openStarterSlots, 4);
  assert.ok(Number.isFinite(s.RB.ratio));
});

test('tier cliff measures the drop to the next player at the position', () => {
  const uneven = [
    { name: 'Elite RB', position: 'RB', value: 60 },
    { name: 'Meh RB', position: 'RB', value: 12 },
  ];
  const state = reduce([register('me')], { config });
  const cliff = tierCliff(state, uneven, 'RB');

  assert.equal(cliff.cliff, 48);
  assert.equal(cliff.next.name, 'Meh RB');
});

test('drafted players leave the available pool', () => {
  const state = reduce([sold('RB A', 'RB', 'you', 25, 'e1')], { config });
  const avail = availablePlayers(state, valuations);

  assert.equal(avail.length, 7);
  assert.ok(!avail.some((p) => p.name === 'RB A'));
});

test('advice says bid when the board is under your adjusted value', () => {
  const state = reduce([register('me'), register('you'), nominate('RB A', 'RB', 10, 'you')], { config });
  const a = bidAdvice(state, valuations, { aggressiveness: 0 });

  assert.equal(a.verdict, 'bid');
  assert.equal(a.parValue, 25);
  assert.equal(a.currentBid, 10);
  assert.ok(a.surplus > 0);
});

test('advice says pass once the board passes your ceiling', () => {
  const state = reduce([
    register('me'), register('you'),
    makeEvent(EventType.NOMINATION, { playerName: 'RB A', position: 'RB', openingBid: 40 }, { id: 'n1' }),
  ], { config });

  const a = bidAdvice(state, valuations, { aggressiveness: 0 });
  assert.equal(a.verdict, 'pass');
});

test('aggressiveness raises the ceiling by a share of the tier cliff', () => {
  // Scaled to the league (8 players, $200 total) so inflation is exactly 1.0
  // and the only thing separating the two ceilings is the cliff allowance.
  const cliffy = [
    { name: 'Elite RB', position: 'RB', value: 60 },
    { name: 'Meh RB', position: 'RB', value: 12 },
    { name: 'RB C', position: 'RB', value: 12 },
    { name: 'RB D', position: 'RB', value: 12 },
    { name: 'WR A', position: 'WR', value: 30 },
    { name: 'WR B', position: 'WR', value: 26 },
    { name: 'WR C', position: 'WR', value: 26 },
    { name: 'WR D', position: 'WR', value: 22 },
  ];
  const log = [register('me'), register('you'), nominate('Elite RB', 'RB', 60)];
  const state = reduce(log, { config });

  const timid = bidAdvice(state, cliffy, { aggressiveness: 0 });
  const bold = bidAdvice(state, cliffy, { aggressiveness: 1 });

  assert.ok(bold.ceiling > timid.ceiling);
  assert.equal(bold.verdict, 'stretch');
  assert.equal(timid.verdict, 'pass');
});

test('your own max bid hard-caps the ceiling', () => {
  const state = reduce([
    register('me'), register('you'),
    sold('WR A', 'WR', 'me', 97, 'e1'),   // me: $3 left, 3 slots open
    nominate('RB A', 'RB', 1),
  ], { config });

  const a = bidAdvice(state, valuations, { aggressiveness: 1 });
  assert.equal(a.myMaxBid, 1);
  assert.ok(a.ceiling <= 1, 'never advise a bid you cannot legally make');
});

test('advice flags a player with no open slot on your roster', () => {
  const state = reduce([
    register('me'), register('you'),
    sold('RB A', 'RB', 'me', 10, 'e1'),
    sold('RB B', 'RB', 'me', 10, 'e2'),
    nominate('RB C', 'RB', 5),
  ], { config });

  assert.equal(bidAdvice(state, valuations).verdict, 'no-slot');
});

test('advice flags a player missing from your valuations', () => {
  const state = reduce([register('me'), nominate('Undrafted Guy', 'RB', 3)], { config });
  assert.equal(bidAdvice(state, valuations).verdict, 'unvalued');
});

test('no nomination means no advice', () => {
  const state = reduce([register('me')], { config });
  assert.equal(bidAdvice(state, valuations), null);
});

test('positional inflation reflects money chasing one position', () => {
  const state = reduce([register('me'), register('you')], { config });
  const rb = positionalInflation(state, valuations, 'RB');

  assert.equal(rb.demand, 4, 'two teams x two RB slots');
  assert.ok(rb.rate > 0);
});

test('budget pressure ranks teams closest to forced $1 bids', () => {
  const state = reduce([
    register('me'), register('you'),
    sold('RB A', 'RB', 'you', 97, 'e1'),
  ], { config });

  const pressure = budgetPressure(state);
  assert.equal(pressure[0].teamId, 'you');
  assert.ok(pressure[0].locked > pressure[1].locked);
});

test('analytics tolerate an empty valuation set', () => {
  const state = reduce([register('me'), nominate('Whoever', 'RB', 5)], { config });

  assert.doesNotThrow(() => inflation(state, []));
  assert.doesNotThrow(() => scarcity(state, []));
  assert.equal(bidAdvice(state, []).verdict, 'unvalued');
});
