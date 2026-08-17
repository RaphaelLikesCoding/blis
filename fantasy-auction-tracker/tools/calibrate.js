/**
 * Selector calibration helper.
 *
 * The site profiles in src/adapters/profiles.js are guesses. This finds the
 * real selectors. Open your draft room (a MOCK draft -- never calibrate during
 * the real thing), paste this whole file into the browser console, and run:
 *
 *   __auctionCalibrate()                  // survey the page
 *   __auctionCalibrate('Bijan Robinson')  // find where a known name lives
 *   __auctionWatch()                      // log DOM changes for 30s
 *
 * Copy the reported selectors into the profile for your platform, or paste
 * them into the sidebar's Advanced panel.
 */

(() => {
  /** Shortest reasonably stable CSS path to a node. */
  function pathFor(node) {
    const parts = [];
    let el = node;
    while (el && el.nodeType === 1 && parts.length < 5) {
      let part = el.tagName.toLowerCase();
      const classes = [...el.classList]
        // Skip hashed/utility classes -- they change on every deploy.
        .filter((c) => !/^(css-|sc-|jsx-|_)/.test(c) && !/\d{4,}/.test(c))
        .slice(0, 2);
      if (el.id && !/\d{4,}/.test(el.id)) { parts.unshift(`#${el.id}`); break; }
      if (classes.length) part += `.${classes.join('.')}`;
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function textNodes(root = document.body) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const out = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text && node.parentElement) out.push({ text, el: node.parentElement });
    }
    return out;
  }

  window.__auctionCalibrate = (knownName = null) => {
    const nodes = textNodes();

    const report = (label, matches) => {
      const grouped = new Map();
      for (const m of matches) {
        const path = pathFor(m.el);
        if (!grouped.has(path)) grouped.set(path, []);
        grouped.get(path).push(m.text);
      }
      const rows = [...grouped.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 5)
        .map(([selector, samples]) => ({
          selector,
          count: samples.length,
          samples: samples.slice(0, 3).join(' | '),
        }));
      console.group(`%c${label} (${matches.length} candidates)`, 'font-weight:bold');
      if (rows.length) console.table(rows); else console.log('none found');
      console.groupEnd();
      return rows[0]?.selector ?? null;
    };

    const found = {};

    if (knownName) {
      found.player = report(
        `nodes containing "${knownName}"`,
        nodes.filter((n) => n.text.includes(knownName)),
      );
    }

    found.playerName = report(
      'player-name shaped text ("First Last")',
      nodes.filter((n) => /^[A-Z][a-z'’.-]+ [A-Z][a-zA-Z'’.-]+/.test(n.text) && n.text.length < 40),
    );

    found.position = report(
      'position labels (QB/RB/WR/TE/K/DST)',
      nodes.filter((n) => /^(QB|RB|WR|TE|K|DEF|DST|D\/ST)$/i.test(n.text)),
    );

    found.money = report(
      'dollar amounts',
      nodes.filter((n) => /^\$\s?\d{1,3}$/.test(n.text)),
    );

    console.group('%cWebSocket / fetch endpoints seen', 'font-weight:bold');
    console.log('Reload the page with the extension installed, then use');
    console.log('  Setup -> Export WS capture');
    console.log('to get the real frames. That beats every selector below.');
    console.groupEnd();

    console.log('%cSuggested profile fragment:', 'font-weight:bold');
    console.log(JSON.stringify({
      selectors: {
        nomName: found.playerName,
        nomPosition: found.position,
        highBid: found.money,
      },
    }, null, 2));

    return found;
  };

  window.__auctionWatch = (seconds = 30) => {
    const seen = new Map();
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        const target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        if (!target) continue;
        const path = pathFor(target);
        seen.set(path, (seen.get(path) ?? 0) + 1);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    console.log(`watching for ${seconds}s -- run a few bids now`);
    setTimeout(() => {
      observer.disconnect();
      const rows = [...seen.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([selector, changes]) => ({ selector, changes }));
      console.log('%cMost-mutated nodes (the live bid area is usually near the top):', 'font-weight:bold');
      console.table(rows);
    }, seconds * 1000);
  };

  console.log('calibration loaded: __auctionCalibrate() / __auctionWatch()');
})();
