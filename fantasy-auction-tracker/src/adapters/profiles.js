/**
 * Site profiles for the generic DOM adapter.
 *
 * IMPORTANT -- these selectors are PROVISIONAL. They were written without
 * access to a live auction draft room, and every fantasy platform reskins its
 * draft app between seasons. Do not trust them on draft day.
 *
 * Calibrate before you rely on any of this:
 *   1. open the draft room (a mock draft is fine, and is the only safe way to
 *      test this)
 *   2. run `tools/calibrate.js` in the page console -- it dumps candidate
 *      selectors for player names, prices and team rows
 *   3. paste the corrected selectors here, or set them at runtime from the
 *      sidebar's Advanced panel, which writes an override to storage
 *
 * `wsHints` lists substrings that identify the draft WebSocket, and the JSON
 * paths the tap should look for. Getting these right is worth far more than
 * perfecting the selectors -- the WS layer is exact.
 */

export const PROFILES = [
  {
    id: 'nfl',
    label: 'NFL.com Fantasy',
    match: /(^|\.)fantasy\.nfl\.com$/,
    urlHint: /draft/i,
    selectors: {
      root: '#draftBoard, .draftContainer, body',
      nomination: '.currentPlayer, .nominatedPlayer, .auctionNomination',
      nomName: '.playerName, .playerNameFull, a.playerName',
      nomPosition: '.playerPosition, em',
      nomTeam: '.playerTeam',
      highBid: '.currentBid, .bidAmount, .auctionCurrentBid',
      highBidder: '.highBidder, .currentBidder, .bidTeam',
      resultRow: '#draftResults tr, .draftResultsTable tr',
      rowPlayer: '.playerName, td.player a',
      rowPosition: '.playerPosition, em',
      rowPrice: '.auctionPrice, td.price',
      rowTeam: '.teamName, td.team',
      teamRow: '.auctionBudgets tr, .teamBudgetRow',
      teamName: '.teamName',
      teamBudget: '.budgetRemaining, .remaining',
    },
    wsHints: {
      urlContains: ['fantasy.nfl.com', '/draft', 'socket'],
      messageKeys: ['playerId', 'auctionAmount', 'teamId', 'eventType'],
    },
  },
  {
    id: 'cbs',
    label: 'CBS Sports Fantasy',
    match: /(^|\.)cbssports\.com$/,
    urlHint: /draft|auction/i,
    selectors: {
      root: '.draft-room, #draftRoom, body',
      nomination: '.auction-nomination, .nominated-player, .current-player',
      nomName: '.player-name, .playerLink',
      nomPosition: '.player-position, .position',
      nomTeam: '.player-team, .proTeam',
      highBid: '.current-bid, .high-bid, .bid-amount',
      highBidder: '.high-bidder, .bidding-team',
      resultRow: '.draft-results tr, .results-row',
      rowPlayer: '.player-name',
      rowPosition: '.player-position, .position',
      rowPrice: '.bid-amount, .price, .salary',
      rowTeam: '.team-name, .owner',
      teamRow: '.team-budgets .team-row, .budget-row',
      teamName: '.team-name',
      teamBudget: '.budget-remaining, .remaining-salary',
    },
    wsHints: {
      urlContains: ['cbssports.com', 'draft', 'socket', 'stream'],
      messageKeys: ['playerId', 'amount', 'teamId', 'type'],
    },
  },
  {
    // Fallback: matches nothing automatically. Point it at any site by setting
    // selectors from the sidebar's Advanced panel.
    id: 'custom',
    label: 'Custom (user-configured)',
    match: /$^/,
    selectors: {},
    wsHints: { urlContains: [], messageKeys: [] },
  },
];

export function profileFor(url, overrides = {}) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }

  const base = PROFILES.find((p) => p.match.test(host));
  if (!base) return overrides.selectors ? { ...PROFILES.at(-1), ...overrides } : null;

  return {
    ...base,
    selectors: { ...base.selectors, ...(overrides.selectors ?? {}) },
    wsHints: { ...base.wsHints, ...(overrides.wsHints ?? {}) },
  };
}
