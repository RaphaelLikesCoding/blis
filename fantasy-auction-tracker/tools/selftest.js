/**
 * In-room profile self-test.
 *
 * The selectors shipped in src/adapters/profiles.js are guesses. This tells you
 * -- in about ten seconds, inside the actual draft room -- which ones resolve,
 * which are wrong, and what the adapter would emit if the draft ran right now.
 *
 * Run it in a CBS **Salary Cap Mock Draft** (not your real league):
 *
 *   1. open the mock draft room
 *   2. paste this whole file into the browser console
 *   3. __auctionSelfTest()
 *   4. nominate a player, put a bid on him, let one sale complete
 *   5. __auctionSelfTest() again -- rows that were EMPTY should now be OK
 *
 * Anything still FAIL/EMPTY after a completed sale is a selector to fix. Feed
 * the printed fragment back into the profile, or paste it into the sidebar's
 * Advanced panel.
 *
 * This is read-only. It queries the page and prints; it never clicks, bids, or
 * sends anything anywhere.
 */

(() => {
  // Kept in sync with src/adapters/profiles.js by hand -- this file has to be
  // standalone so it can be pasted into a console with no extension loaded.
  const PROFILES = {
    cbs: {
      label: 'CBS Sports Fantasy (Salary Cap)',
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
    },
    nfl: {
      label: 'NFL.com Fantasy',
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
    },
  };

  /** Which selectors live inside the nomination container vs. the document. */
  const SCOPED = {
    nomName: 'nomination', nomPosition: 'nomination', nomTeam: 'nomination',
    highBid: 'nomination', highBidder: 'nomination',
    rowPlayer: 'resultRow', rowPosition: 'resultRow', rowPrice: 'resultRow', rowTeam: 'resultRow',
    teamName: 'teamRow', teamBudget: 'teamRow',
  };

  /** Selectors that cannot resolve until a draft action has happened. */
  const NEEDS_ACTION = new Set(['nomination', 'nomName', 'nomPosition', 'nomTeam', 'highBid', 'highBidder']);
  const NEEDS_SALE = new Set(['resultRow', 'rowPlayer', 'rowPosition', 'rowPrice', 'rowTeam']);

  const clean = (node) => (node ? node.textContent.trim().replace(/\s+/g, ' ') : null);
  const money = (text) => {
    if (text == null) return null;
    const m = /-?\d+(?:\.\d+)?/.exec(String(text).replace(/,/g, ''));
    return m ? Number(m[0]) : null;
  };

  function detect() {
    const host = location.hostname;
    if (/cbssports\.com$/.test(host)) return 'cbs';
    if (/fantasy\.nfl\.com$/.test(host)) return 'nfl';
    return null;
  }

  window.__auctionSelfTest = (profileId = detect(), overrides = {}) => {
    if (!profileId || !PROFILES[profileId]) {
      console.warn(`No profile for ${location.hostname}. Try __auctionSelfTest('cbs').`);
      return null;
    }

    const profile = PROFILES[profileId];
    const sel = { ...profile.selectors, ...overrides };
    console.log(`%cProfile self-test: ${profile.label}`, 'font-weight:bold;font-size:13px');
    console.log(`%c${location.href}`, 'color:#888');

    // Every page query is guarded: an invalid selector must be reported, not
    // thrown, or one bad override kills the whole report.
    const queryAll = (scope, selector) => {
      try { return { ok: true, nodes: [...scope.querySelectorAll(selector)] }; }
      catch { return { ok: false, nodes: [] }; }
    };

    const nomRoot = sel.nomination ? queryAll(document, sel.nomination).nodes[0] ?? null : null;
    // Scope row fields across EVERY matching row, not just the first. The first
    // `tr` in a results table is usually the header, which resolves none of
    // them -- scoping to it would report correct selectors as broken.
    const rowRoots = sel.resultRow ? queryAll(document, sel.resultRow).nodes : [];
    const teamRoots = sel.teamRow ? queryAll(document, sel.teamRow).nodes : [];
    const scopeFor = {
      nomination: nomRoot ? [nomRoot] : [],
      resultRow: rowRoots,
      teamRow: teamRoots,
    };

    const rows = [];
    const broken = {};

    for (const [field, selector] of Object.entries(sel)) {
      if (!selector) { rows.push({ field, selector: '(unset)', status: 'SKIP', found: '' }); continue; }

      const scopeKey = SCOPED[field];

      if (scopeKey) {
        const scopes = scopeFor[scopeKey];
        // A scoped field whose container is missing is not itself broken -- it
        // simply had nowhere to look. Reporting it as FAIL would send you
        // chasing a selector that is actually fine.
        if (!scopes.length) {
          rows.push({ field, selector, status: 'NO-SCOPE', found: `needs ${scopeKey}` });
          continue;
        }

        const matched = [];
        let invalid = false;
        for (const scope of scopes) {
          const result = queryAll(scope, selector);
          if (!result.ok) { invalid = true; break; }
          matched.push(...result.nodes);
        }

        if (invalid) {
          rows.push({ field, selector, status: 'INVALID', found: 'not valid CSS' });
          broken[field] = selector;
        } else if (!matched.length) {
          // The container exists, so there is no "wait for the draft" excuse:
          // this selector is genuinely wrong.
          rows.push({ field, selector, status: 'FAIL', found: `no match in ${scopes.length} ${scopeKey}` });
          broken[field] = selector;
        } else {
          rows.push({
            field, selector, status: 'OK', count: matched.length,
            found: matched.slice(0, 3).map(clean).filter(Boolean).join(' | ') || '(matched, no text)',
          });
        }
        continue;
      }

      const result = queryAll(document, selector);
      if (!result.ok) {
        rows.push({ field, selector, status: 'INVALID', found: 'not valid CSS' });
        broken[field] = selector;
      } else if (!result.nodes.length) {
        const expected = NEEDS_ACTION.has(field) ? 'nominate a player'
          : NEEDS_SALE.has(field) ? 'let a sale complete' : null;
        rows.push({ field, selector, status: 'EMPTY', found: expected ? `(${expected}, then re-run)` : '' });
        if (!expected) broken[field] = selector;
      } else {
        rows.push({
          field, selector, status: 'OK', count: result.nodes.length,
          found: result.nodes.slice(0, 3).map(clean).filter(Boolean).join(' | ') || '(matched, no text)',
        });
      }
    }

    console.table(rows);

    // --- what the adapter would actually emit --------------------------------
    console.group('%cEvents the adapter would emit right now', 'font-weight:bold');

    if (nomRoot) {
      const name = clean(nomRoot.querySelector(sel.nomName));
      const pos = clean(nomRoot.querySelector(sel.nomPosition));
      const bid = money(clean(nomRoot.querySelector(sel.highBid)));
      const bidder = clean(nomRoot.querySelector(sel.highBidder));
      if (name && pos) {
        console.log('NOMINATION', { playerName: name, position: pos, openingBid: bid, bidder });
      } else {
        console.warn('nomination container found but name/position did not resolve',
          { name, position: pos });
      }
    } else {
      console.log('no live nomination visible');
    }

    const sales = [];
    for (const row of rowRoots) {
      const name = clean(row.querySelector(sel.rowPlayer));
      const price = money(clean(row.querySelector(sel.rowPrice)));
      const team = clean(row.querySelector(sel.rowTeam));
      const pos = clean(row.querySelector(sel.rowPosition));
      if (name && price != null && team) sales.push({ player: name, position: pos ?? 'UNK', price, team });
    }
    if (sales.length) {
      console.log(`SOLD x${sales.length}`);
      console.table(sales.slice(0, 10));
      const noPos = sales.filter((s) => s.position === 'UNK').length;
      if (noPos) {
        console.warn(`${noPos} sale(s) parsed without a position -- these land in the review `
          + 'queue instead of applying. Fix rowPosition to clear that.');
      }
    } else {
      console.log('no completed sales parsed yet');
    }

    const teams = teamRoots
      .map((r) => ({ team: clean(r.querySelector(sel.teamName)), budget: clean(r.querySelector(sel.teamBudget)) }))
      .filter((t) => t.team);
    if (teams.length) { console.log(`TEAM_REGISTERED x${teams.length}`); console.table(teams); }
    console.groupEnd();

    // --- verdict -------------------------------------------------------------
    const brokenFields = Object.keys(broken);
    const critical = brokenFields.filter((f) => ['resultRow', 'rowPlayer', 'rowPrice', 'rowTeam'].includes(f));

    if (!brokenFields.length) {
      console.log('%c✓ every selector resolved. The DOM layer will track this room.',
        'color:#0a0;font-weight:bold');
    } else {
      console.log(`%c✗ ${brokenFields.length} selector(s) need fixing: ${brokenFields.join(', ')}`,
        'color:#c00;font-weight:bold');
      if (critical.length) {
        console.log('%cThese are the ones that matter -- without them no sale is ever recorded.',
          'color:#c00');
      }
      console.log('Run __auctionCalibrate() (tools/calibrate.js) to find replacements.');
    }

    console.log('%cPaste into the sidebar Advanced panel to override:', 'font-weight:bold');
    console.log(JSON.stringify({ selectors: sel }, null, 2));

    return { rows, broken, sales, teams };
  };

  /**
   * Watch a live nomination and report whether bid changes are actually
   * observable -- a room that repaints via canvas or a shadow root will look
   * fine on a static scan and then track nothing.
   */
  window.__auctionSelfTestLive = (seconds = 45, profileId = detect()) => {
    const sel = PROFILES[profileId]?.selectors;
    if (!sel) return console.warn('no profile');

    const seen = [];
    const observer = new MutationObserver(() => {
      const root = document.querySelector(sel.nomination);
      if (!root) return;
      const snap = [
        clean(root.querySelector(sel.nomName)),
        money(clean(root.querySelector(sel.highBid))),
        clean(root.querySelector(sel.highBidder)),
      ].join('|');
      if (seen.at(-1) !== snap) seen.push(snap);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    console.log(`%cWatching ${seconds}s -- nominate a player and run the bidding up.`,
      'font-weight:bold');
    setTimeout(() => {
      observer.disconnect();
      if (seen.length < 2) {
        console.warn('Saw fewer than 2 distinct states. Either nothing happened, or the '
          + 'draft room is not rendering through the DOM (shadow DOM / canvas). '
          + 'If the latter, the WebSocket layer is the only viable path -- '
          + 'export the capture from the sidebar.');
      } else {
        console.log(`%c✓ observed ${seen.length} distinct bid states -- the DOM layer tracks live changes.`,
          'color:#0a0;font-weight:bold');
      }
      console.table(seen.map((s, i) => {
        const [player, bid, bidder] = s.split('|');
        return { step: i + 1, player, bid, bidder };
      }));
    }, seconds * 1000);
  };

  console.log('%cself-test loaded.', 'font-weight:bold');
  console.log('  __auctionSelfTest()      -- check every selector now');
  console.log('  __auctionSelfTestLive()  -- verify live bid changes are observable');
})();
