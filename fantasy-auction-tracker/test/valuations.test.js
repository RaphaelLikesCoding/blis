import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, loadValuations, rescaleToLeague } from '../src/core/valuations.js';
import { DEFAULT_CONFIG, expandSlots } from '../src/core/config.js';

test('csv parser handles quotes, embedded commas and CRLF', () => {
  const rows = parseCsv('a,b\r\n"Smith, John",7\r\n"say ""hi""",8\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['Smith, John', '7'], ['say "hi"', '8']]);
});

test('csv parser skips blank lines', () => {
  assert.equal(parseCsv('a,b\n\n1,2\n\n').length, 2);
});

test('loads a FantasyPros-shaped export', () => {
  const csv = [
    'Rank,Player,Team,Position,Auction Value,Tier,Bye',
    '1,Ja\'Marr Chase,CIN,WR1,$62,1,10',
    '2,Bijan Robinson,ATL,RB1,"$58",1,5',
    '3,Justin Jefferson,MIN,WR2,$55,1,6',
  ].join('\n');

  const { players, problems } = loadValuations(csv);

  assert.equal(players.length, 3);
  assert.equal(problems.length, 0);
  assert.deepEqual(
    players[0],
    {
      name: "Ja'Marr Chase",
      position: 'WR',
      nflTeam: 'CIN',
      value: 62,
      hasValue: true,
      rank: 1,
      posRank: 1,
      tier: 1,
      projection: null,
      bye: 10,
      source: 'csv',
    },
  );
  assert.equal(players[1].value, 58, 'quoted dollar amounts parse');
  assert.equal(players[1].posRank, 1, 'RB1 splits into position + positional rank');
});

test('alternative header names are recognized', () => {
  const { players } = loadValuations('Name,Pos,$\nJosh Allen,QB,40');
  assert.equal(players[0].name, 'Josh Allen');
  assert.equal(players[0].position, 'QB');
  assert.equal(players[0].value, 40);
});

test('defense position aliases normalize to DST', () => {
  const { players } = loadValuations('Player,Position,Value\n49ers,D/ST,4\nRavens,DEF,3');
  assert.deepEqual(players.map((p) => p.position), ['DST', 'DST']);
});

test('missing values are reported rather than silently zeroed', () => {
  const { players, problems } = loadValuations('Player,Position,Value\nA B,RB,\nC D,WR,10');
  assert.equal(players[0].value, 0);
  assert.equal(players[0].hasValue, false);
  assert.ok(problems.some((p) => /no auction value/.test(p)));
});

test('a CSV with no value column is flagged, not accepted quietly', () => {
  const { problems } = loadValuations('Player,Position\nA B,RB');
  assert.ok(problems.some((p) => /auction-value column/.test(p)));
});

test('an empty CSV degrades to an empty set with a problem', () => {
  const { players, problems } = loadValuations('Player,Position,Value');
  assert.equal(players.length, 0);
  assert.equal(problems[0], 'CSV has no data rows');
});

test('rescaling makes values sum to the league total money', () => {
  const config = {
    ...DEFAULT_CONFIG,
    numTeams: 2,
    budget: 100,
    minBid: 1,
    rosterSlots: expandSlots({ RB: 2, WR: 2 }),
  };

  // Values from a different-sized league: total $100, not $200.
  const players = [
    { name: 'A B', position: 'RB', value: 40 },
    { name: 'C D', position: 'RB', value: 30 },
    { name: 'E F', position: 'WR', value: 20 },
    { name: 'G H', position: 'WR', value: 10 },
  ];

  const scaled = rescaleToLeague(players, config);
  const total = scaled.reduce((s, p) => s + p.value, 0);

  assert.ok(Math.abs(total - 200) < 0.5, `expected ~200, got ${total}`);
  assert.ok(scaled.every((p) => p.value >= config.minBid));
  assert.equal(scaled[0].rawValue, 40, 'the original value is preserved');
  assert.ok(scaled[0].value > scaled[1].value, 'ordering is preserved');
});

test('players beyond the rosterable pool are zeroed and marked', () => {
  const config = {
    ...DEFAULT_CONFIG,
    numTeams: 1,
    budget: 100,
    rosterSlots: expandSlots({ RB: 2 }),
  };
  const players = [
    { name: 'A B', position: 'RB', value: 50 },
    { name: 'C D', position: 'RB', value: 40 },
    { name: 'E F', position: 'RB', value: 1 },
  ];

  const scaled = rescaleToLeague(players, config);
  assert.equal(scaled[2].rosterable, false);
  assert.equal(scaled[2].value, 0);
  assert.equal(scaled[0].rosterable, true);
});

test('rescaling is a no-op when there is no surplus to distribute', () => {
  const config = { ...DEFAULT_CONFIG, numTeams: 1, budget: 10, rosterSlots: ['RB'] };
  const players = [{ name: 'A B', position: 'RB', value: 0 }];
  assert.deepEqual(rescaleToLeague(players, config), players);
});
