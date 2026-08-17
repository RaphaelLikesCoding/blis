import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EventType, makeEvent, validate } from '../src/core/events.js';
import { reduce, teamSummary, allTeamSummaries } from '../src/core/reducer.js';
import { DraftStore } from '../src/core/store.js';
import { DEFAULT_CONFIG, expandSlots, startersByPosition } from '../src/core/config.js';
import { normalizeName, playerKey, resolvePlayer, buildIndex } from '../src/core/players.js';

const config = {
  ...DEFAULT_CONFIG,
  numTeams: 4,
  budget: 100,
  rosterSlots: expandSlots({ QB: 1, RB: 2, WR: 2, FLEX: 1, BN: 2 }),
};

const sold = (name, pos, teamId, price, id) =>
  makeEvent(EventType.SOLD, {
    playerName: name, position: pos, teamId, teamName: teamId, price,
  }, { id, source: 'ws' });

test('sale updates budget, roster and drafted set', () => {
  const state = reduce([sold('Bijan Robinson', 'RB', 'alpha', 55)], { config });
  const alpha = teamSummary(state.teams.get('alpha'), config);

  assert.equal(alpha.spent, 55);
  assert.equal(alpha.remaining, 45);
  assert.equal(alpha.roster.length, 1);
  assert.ok(state.drafted.has(playerKey('Bijan Robinson', 'RB')));
});

test('max bid reserves $1 for every other open slot', () => {
  // 8 slots, $100 budget, nothing spent -> 7 slots must keep $1 each.
  const state = reduce([makeEvent(EventType.TEAM_REGISTERED, {
    teamId: 'alpha', teamName: 'alpha',
  })], { config });
  const alpha = teamSummary(state.teams.get('alpha'), config);

  assert.equal(alpha.openSlots, 8);
  assert.equal(alpha.maxBid, 93);
});

test('max bid is zero when the roster is full', () => {
  const log = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n, i) =>
    sold(`Player ${n}`, i < 3 ? 'RB' : 'WR', 'alpha', 1, `e${i}`));
  const state = reduce(log, { config });
  const alpha = teamSummary(state.teams.get('alpha'), config);

  assert.equal(alpha.openSlots, 0);
  assert.equal(alpha.maxBid, 0);
});

test('players fill dedicated slots before flex, and flex before bench', () => {
  const state = reduce([
    sold('RB One', 'RB', 'alpha', 10, 'e1'),
    sold('RB Two', 'RB', 'alpha', 10, 'e2'),
    sold('RB Three', 'RB', 'alpha', 10, 'e3'),
  ], { config });

  const slots = state.teams.get('alpha').roster.map((r) => r.slot);
  assert.deepEqual(slots, ['RB', 'RB', 'FLEX']);
});

test('a duplicate sale is ignored and warned about, not double-counted', () => {
  const state = reduce([
    sold('Bijan Robinson', 'RB', 'alpha', 55, 'e1'),
    sold('Bijan Robinson', 'RB', 'beta', 55, 'e2'),
  ], { config });

  assert.equal(state.drafted.get(playerKey('Bijan Robinson', 'RB')).teamId, 'alpha');
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0].message, /duplicate/);
});

test('retraction removes a sale and restores the budget', () => {
  const log = [
    sold('Bijan Robinson', 'RB', 'alpha', 55, 'e1'),
    makeEvent(EventType.RETRACTION, { targetId: 'e1' }, { id: 'e2' }),
  ];
  const state = reduce(log, { config });

  assert.equal(state.drafted.size, 0);
  assert.equal(teamSummary(state.teams.get('alpha') ?? {
    spent: 0, roster: [], slots: config.rosterSlots.map((t) => ({ type: t, filled: null })),
  }, config).spent, 0);
});

test('correction patches an earlier payload in place', () => {
  const log = [
    sold('Bijan Robinson', 'RB', 'alpha', 5, 'e1'),
    makeEvent(EventType.CORRECTION, { targetId: 'e1', patch: { price: 55 } }, { id: 'e2' }),
  ];
  const state = reduce(log, { config });
  assert.equal(state.teams.get('alpha').spent, 55);
});

test('low-confidence events are quarantined rather than applied', () => {
  const shaky = makeEvent(EventType.SOLD, {
    playerName: 'Blurry Name', position: 'WR', teamId: 'alpha', price: 30,
  }, { id: 'e1', source: 'ocr', confidence: 0.4 });

  const state = reduce([shaky], { config });
  assert.equal(state.drafted.size, 0);
  assert.equal(state.needsReview.length, 1);
});

test('confirming a quarantined event applies it', () => {
  const shaky = makeEvent(EventType.SOLD, {
    playerName: 'Blurry Name', position: 'WR', teamId: 'alpha', price: 30,
  }, { id: 'e1', source: 'ocr', confidence: 0.4 });

  const state = reduce([
    shaky,
    makeEvent(EventType.CORRECTION, { targetId: 'e1', patch: {} }, { id: 'e2' }),
  ], { config });

  assert.equal(state.drafted.size, 1);
  assert.equal(state.needsReview.length, 0);
});

test('bids never move the high bid backwards', () => {
  const state = reduce([
    makeEvent(EventType.NOMINATION, { playerName: 'CeeDee Lamb', position: 'WR' }, { id: 'e1' }),
    makeEvent(EventType.BID, { amount: 40, teamId: 'alpha' }, { id: 'e2' }),
    makeEvent(EventType.BID, { amount: 12, teamId: 'beta' }, { id: 'e3' }), // stale frame
  ], { config });

  assert.equal(state.nomination.highBid, 40);
  assert.equal(state.nomination.highBidder, 'alpha');
});

test('a sale clears the matching nomination', () => {
  const state = reduce([
    makeEvent(EventType.NOMINATION, { playerName: 'CeeDee Lamb', position: 'WR' }, { id: 'e1' }),
    sold('CeeDee Lamb', 'WR', 'alpha', 52, 'e2'),
  ], { config });

  assert.equal(state.nomination, null);
});

test('reduce is deterministic and side-effect free', () => {
  const log = [sold('A B', 'RB', 'alpha', 10, 'e1'), sold('C D', 'WR', 'beta', 20, 'e2')];
  const a = JSON.stringify(allTeamSummaries(reduce(log, { config })));
  const b = JSON.stringify(allTeamSummaries(reduce(log, { config })));
  assert.equal(a, b);
});

test('store rejects malformed events instead of logging them', () => {
  const store = new DraftStore({ config });
  const bad = makeEvent(EventType.SOLD, {
    playerName: 'No Price', position: 'RB', teamId: 'alpha',
  });

  const result = store.append(bad);
  assert.equal(result.ok, false);
  assert.equal(store.log.length, 0);
  assert.match(result.problems[0], /price/);
});

test('store suppresses a repeated sale from a re-rendering DOM', () => {
  const store = new DraftStore({ config });
  assert.equal(store.append(sold('Bijan Robinson', 'RB', 'alpha', 55, 'e1')).ok, true);
  assert.equal(store.append(sold('Bijan Robinson', 'RB', 'alpha', 55, 'e2')).ok, false);
  assert.equal(store.log.length, 1);
});

test('store round-trips through serialize/deserialize', () => {
  const store = new DraftStore({ config });
  store.append(sold('Bijan Robinson', 'RB', 'alpha', 55, 'e1'));
  const restored = DraftStore.deserialize(store.serialize());

  assert.equal(restored.log.length, 1);
  assert.equal(restored.state.teams.get('alpha').spent, 55);
});

test('name normalization collapses suffixes, punctuation and inversion', () => {
  assert.equal(normalizeName('Marvin Harrison Jr.'), 'marvin harrison');
  assert.equal(normalizeName('Harrison Jr., Marvin'), 'marvin harrison');
  assert.equal(normalizeName("Ja'Marr Chase"), 'jamarr chase');
  assert.equal(normalizeName('Amon-Ra St. Brown'), 'amon-ra st brown');
});

test('player resolution falls back through name and last-name tiers', () => {
  const index = buildIndex([
    { name: 'Marvin Harrison Jr.', position: 'WR', nflTeam: 'ARI', value: 30 },
    { name: 'Josh Allen', position: 'QB', nflTeam: 'BUF', value: 25 },
  ]);

  assert.equal(
    resolvePlayer(index, { name: 'Marvin Harrison', position: 'WR' }).tier,
    'name+pos',
  );
  assert.equal(
    resolvePlayer(index, { name: 'Josh Allen', position: 'RB' }).confidence,
    0.9,
  );
  assert.equal(resolvePlayer(index, { name: 'Nobody Here', position: 'TE' }), null);
});

test('starter counts split flex demand across eligible positions', () => {
  const starters = startersByPosition(config);
  // 4 teams: 2 dedicated RB each = 8, plus a third of each team's FLEX.
  assert.equal(starters.RB, 8 + (4 * (1 / 3)));
  assert.equal(starters.QB, 4);
});

test('event validation catches every required field', () => {
  assert.deepEqual(validate(makeEvent(EventType.SOLD, {
    playerName: 'A B', position: 'RB', teamId: 'alpha', price: 10,
  })), []);

  const problems = validate(makeEvent(EventType.SOLD, { price: -1 }));
  assert.ok(problems.length >= 4);
});

test('a league config event does not erase your own team identity', () => {
  // Draft rooms emit league settings that know nothing about which team is
  // yours. A null in that payload must not clobber a value you set.
  const state = reduce([
    makeEvent(EventType.LEAGUE_CONFIGURED, {
      numTeams: 12, budget: 200, rosterSlots: config.rosterSlots, myTeamId: null,
    }, { id: 'e1' }),
  ], { config: { ...config, myTeamId: 'me' } });

  assert.equal(state.config.myTeamId, 'me');
  assert.equal(state.config.numTeams, 12, 'real values still apply');
});

test('a league config event can still change a setting to a real value', () => {
  const state = reduce([
    makeEvent(EventType.LEAGUE_CONFIGURED, { myTeamId: 'someone-else' }, { id: 'e1' }),
  ], { config: { ...config, myTeamId: 'me' } });

  assert.equal(state.config.myTeamId, 'someone-else');
});
