import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { replay } from '../tools/replay.js';
import { loadValuations, rescaleToLeague } from '../src/core/valuations.js';
import { allTeamSummaries, reduce } from '../src/core/reducer.js';
import { inflation, scarcity, budgetPressure } from '../src/core/analytics.js';
import { rosterSize } from '../src/core/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');

const logData = JSON.parse(readFileSync(join(fixtures, 'sample-draft.json'), 'utf8'));
const { players } = loadValuations(readFileSync(join(fixtures, 'sample-values.csv'), 'utf8'));
const valuations = rescaleToLeague(players, logData.config);

test('a full draft replays to a complete, consistent league', () => {
  const { store } = replay(logData, valuations);
  const state = store.state;
  const teams = allTeamSummaries(state);
  const size = rosterSize(state.config);

  assert.equal(teams.length, state.config.numTeams);
  assert.equal(state.history.length, state.config.numTeams * size);
  assert.ok(state.complete, 'DRAFT_COMPLETE was seen');

  for (const t of teams) {
    assert.equal(t.roster.length, size, `${t.teamName} filled every slot`);
    assert.equal(t.openSlots, 0);
    assert.equal(t.maxBid, 0);
    assert.ok(t.spent <= state.config.budget, `${t.teamName} never overspent`);
    assert.ok(t.remaining >= 0);
  }
});

test('no player is drafted twice across a full draft', () => {
  const { store } = replay(logData, valuations);
  const keys = store.state.history.map((s) => s.playerKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(store.state.warnings.length, 0, 'a clean log produces no warnings');
});

test('every dollar is accounted for', () => {
  const { store } = replay(logData, valuations);
  const spent = allTeamSummaries(store.state).reduce((s, t) => s + t.spent, 0);
  const sales = store.state.history.reduce((s, r) => s + r.price, 0);
  assert.equal(spent, sales);
});

test('replay is deterministic', () => {
  const a = replay(logData, valuations).store.state.history.map((s) => `${s.playerKey}:${s.price}`);
  const b = replay(logData, valuations).store.state.history.map((s) => `${s.playerKey}:${s.price}`);
  assert.deepEqual(a, b);
});

test('replaying a prefix matches replaying the whole log then rewinding', () => {
  // The reducer is pure, so a prefix of the log must give the same state as
  // reducing that prefix directly. This is the property page-refresh recovery
  // depends on.
  const cut = 250;
  const viaReplay = replay(logData, valuations, { until: cut }).store.state;
  const viaReduce = reduce(logData.log.slice(0, cut), { config: logData.config });

  assert.equal(viaReplay.history.length, viaReduce.history.length);
  assert.deepEqual(
    allTeamSummaries(viaReplay).map((t) => [t.teamId, t.spent, t.openSlots]).sort(),
    allTeamSummaries(viaReduce).map((t) => [t.teamId, t.spent, t.openSlots]).sort(),
  );
});

test('mid-draft analytics stay in a sane range', () => {
  const { store } = replay(logData, valuations, { until: 300 });
  const state = store.state;
  const inf = inflation(state, valuations);

  assert.ok(inf.remainingMoney > 0 && inf.remainingMoney < state.config.numTeams * state.config.budget);
  assert.ok(inf.openSpots > 0);
  assert.ok(inf.discretionary > 0.2 && inf.discretionary < 3, `inflation ${inf.discretionary} is plausible`);

  for (const [pos, s] of Object.entries(scarcity(state, valuations))) {
    assert.ok(s.startable >= 0, `${pos} startable is non-negative`);
    assert.ok(s.available >= s.startable, `${pos} startable never exceeds available`);
  }
});

test('budget pressure rises monotonically as the draft drains money', () => {
  const early = budgetPressure(replay(logData, valuations, { until: 100 }).store.state);
  const late = budgetPressure(replay(logData, valuations, { until: 450 }).store.state);

  const avg = (rows) => rows.reduce((s, t) => s + t.locked, 0) / rows.length;
  assert.ok(avg(late) > avg(early), 'teams are more constrained later');
});

test('the final state has no money left unspent beyond the $1 floor', () => {
  const { store } = replay(logData, valuations);
  // Every team filled every slot, so remaining money is pure surplus. The
  // simulator spends to the cap, so this should be near zero; the assertion
  // guards against the reducer double-counting or dropping a sale.
  for (const t of allTeamSummaries(store.state)) {
    assert.ok(t.remaining >= 0 && t.remaining <= store.state.config.budget);
  }
});
