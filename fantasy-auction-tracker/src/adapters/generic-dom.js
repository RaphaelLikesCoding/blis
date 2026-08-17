/**
 * Configuration-driven DOM adapter.
 *
 * Rather than hand-writing a class per site, most draft rooms can be described
 * by a selector map. That means retargeting to a new platform -- or repairing
 * one after a site redesign -- is a data change, not a code change, which
 * matters when the site can change the week before your draft.
 *
 * A profile looks like:
 *
 *   {
 *     id: 'example',
 *     match: /example\.com\/draft/,
 *     selectors: {
 *       nomination:  '.auction-player',        // container for the live player
 *       nomName:     '.player-name',
 *       nomPosition: '.player-pos',
 *       nomTeam:     '.player-nfl-team',
 *       highBid:     '.current-bid',
 *       highBidder:  '.high-bidder',
 *       resultRow:   '.draft-results tr',      // one row per completed sale
 *       rowPlayer:   '.name',
 *       rowPosition: '.pos',
 *       rowPrice:    '.price',
 *       rowTeam:     '.owner',
 *       teamRow:     '.team-budgets .team',
 *       teamName:    '.team-name',
 *       teamBudget:  '.budget-left',
 *     },
 *   }
 */

import { EventType, makeEvent } from '../core/events.js';
import { Adapter, Strategy, parseMoney, debounce, observe, waitFor } from './base.js';

const text = (root, selector) => {
  if (!selector) return null;
  const node = root.querySelector(selector);
  return node ? node.textContent.trim().replace(/\s+/g, ' ') : null;
};

export class GenericDomAdapter extends Adapter {
  constructor(emit, options = {}) {
    super(emit, options);
    this.profile = options.profile;
    this.strategy = Strategy.DOM;
    this.lastNomination = null;
    this.lastBid = null;
    this.seenRows = new Set();
  }

  static get id() { return 'generic-dom'; }

  async start() {
    const { selectors } = this.profile;
    const anchor = await waitFor(selectors.root ?? 'body');
    if (!anchor) {
      this.emit(makeEvent(EventType.CORRECTION, {
        targetId: 'n/a',
        patch: {},
        note: 'draft room never mounted; adapter idle',
      }, { source: 'dom' }));
      return;
    }

    const scan = debounce(() => this.scan(), this.options.debounceMs ?? 120);
    this.track(observe(document.body, scan));
    this.track(() => scan.cancel());
    this.scan();
  }

  scan() {
    try {
      this.scanNomination();
      this.scanResults();
      this.scanTeams();
    } catch (err) {
      // A selector drift must not kill the observer -- degrade, don't die.
      console.warn('[auction-tracker] scan failed', err);
    }
  }

  scanNomination() {
    const s = this.profile.selectors;
    const root = s.nomination ? document.querySelector(s.nomination) : null;
    if (!root) {
      if (this.lastNomination) {
        this.lastNomination = null;
        this.lastBid = null;
      }
      return;
    }

    const name = text(root, s.nomName);
    const position = text(root, s.nomPosition);
    if (!name || !position) return;

    const signature = `${name}|${position}`;
    if (signature !== this.lastNomination) {
      this.lastNomination = signature;
      this.lastBid = null;
      this.emit(makeEvent(EventType.NOMINATION, {
        playerName: name,
        position,
        nflTeam: text(root, s.nomTeam),
        openingBid: parseMoney(text(root, s.highBid)) ?? undefined,
        nominatingTeamId: text(root, s.highBidder) ?? undefined,
      }, { source: 'dom', confidence: this.confidenceFor(Strategy.DOM) }));
    }

    const amount = parseMoney(text(root, s.highBid));
    const bidder = text(root, s.highBidder);
    if (amount != null && bidder && `${amount}|${bidder}` !== this.lastBid) {
      this.lastBid = `${amount}|${bidder}`;
      this.emit(makeEvent(EventType.BID, {
        amount, teamId: bidder,
      }, { source: 'dom', confidence: this.confidenceFor(Strategy.DOM) }));
    }
  }

  scanResults() {
    const s = this.profile.selectors;
    if (!s.resultRow) return;

    for (const row of document.querySelectorAll(s.resultRow)) {
      const name = text(row, s.rowPlayer);
      const price = parseMoney(text(row, s.rowPrice));
      const teamId = text(row, s.rowTeam);
      if (!name || price == null || !teamId) continue;

      const signature = `${name}|${teamId}|${price}`;
      if (this.seenRows.has(signature)) continue;
      this.seenRows.add(signature);

      // A results row lacking a position is still a sale worth recording, but
      // it cannot be matched to a valuation, so drop confidence to flag it.
      const position = text(row, s.rowPosition);
      this.emit(makeEvent(EventType.SOLD, {
        playerName: name,
        position: position ?? 'UNK',
        nflTeam: text(row, s.rowNflTeam),
        teamId,
        teamName: teamId,
        price,
      }, {
        source: 'dom',
        confidence: this.confidenceFor(Strategy.DOM, position ? 0 : 0.2),
      }));
    }
  }

  scanTeams() {
    const s = this.profile.selectors;
    if (!s.teamRow) return;
    for (const row of document.querySelectorAll(s.teamRow)) {
      const name = text(row, s.teamName);
      if (!name) continue;
      this.emit(makeEvent(EventType.TEAM_REGISTERED, {
        teamId: name,
        teamName: name,
      }, { source: 'dom', confidence: this.confidenceFor(Strategy.DOM) }));
    }
  }
}
