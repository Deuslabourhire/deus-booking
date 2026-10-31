// Dialogs, roles, the draw list and the other small admin fixes.
const assert = require('assert/strict');
module.exports = async ({ run, open }) => {
  // damaged saved data must not stop the page from starting
  await open('admin.html');
  await run(`localStorage.setItem('deus_draw_p', '{broken'); localStorage.setItem('deus_draw_h', '"text"');`);
  await open('admin.html');
  assert.deepEqual(await run(`[drawParticipants, drawHistory]`), [[], []]);
  await run(`localStorage.clear()`);

  // the history shows every entry, with no "undefined" and closed tags
  const hist = await run(`(() => { drawHistory = [1, 2, 3, 4].map((n) => ({ name: 'N' + n, date: 'D' })); renderDrawHistory(); return $('drawHistList').innerHTML; })()`);
  assert.ok(!hist.includes('undefined') && hist.includes('🎖️') && (hist.match(/<span>/g) || []).length === 4, hist.slice(0, 200));

  // the variable the "today" cell depends on exists
  assert.equal(await run(`getComputedStyle(document.documentElement).getPropertyValue('--green-light').trim()`), '#e8f7e8');

  // in-page dialog instead of confirm(): cancel changes nothing, confirm goes ahead
  await run(`(() => {
    window.confirm = () => { throw new Error('browser confirm used'); }; window.alert = () => { throw new Error('browser alert used'); };
    window.__t = []; window.showToast = (m) => __t.push(m); window.__deleted = 0;
    const del = { eq() { __deleted++; return Promise.resolve({ error: null }); } };
    const sel = { select() { return sel; }, eq() { return Promise.resolve({ data: [], error: null }); } };
    db.from = () => ({ select: () => sel, delete: () => del });
    bookings = [{ id: 'b1', name: 'A', date: '2026-10-01', status: 'upcoming' }];
    return 1;
  })()`);
  const click = (label) => run(`(async () => { for (let i = 0; i < 40 && !$('subDialog'); i++) await new Promise((r) => setTimeout(r, 25));
    [...$('subDialog').querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)}).click(); })()`);
  await run(`void (window.__p = deleteJob('b1'))`); await click('Go back'); await run(`window.__p`);
  assert.equal(await run(`__deleted + ':' + bookings.length`), '0:1');
  await run(`void (window.__p = deleteJob('b1'))`); await click('Delete booking'); await run(`window.__p`);
  assert.equal(await run(`__deleted + ':' + bookings.length`), '1:0');
  await run(`(() => { drawHistory = [{ name: 'N', date: 'D' }]; })()`);
  await run(`void (window.__p = clearDrawHistory())`); await click('Delete history'); await run(`window.__p`);
  assert.equal(await run(`drawHistory.length`), 0);
  await run(`(() => { $('cStart').value = ''; calcJob(); downloadDoc('missing'); })()`);
  assert.match(await run(`__t.join('|')`), /start and finish[\s\S]*Client not found/);

  // several role rows: one admin row is enough
  const roles = await run(`(async () => {
    const out = []; let filtered = null;
    const c = { select() { return c; }, eq(k, v) { if (k === 'role') filtered = v; return c; }, limit() { return Promise.resolve({ data: window.__roles, error: null }); } };
    db.from = () => c; db.auth.getSession = async () => ({ data: { session: { user: { id: 'u' } } } });
    let out2 = 0; db.auth.signOut = async () => { out2++; };
    window.__roles = [{ role: 'admin' }]; out.push(await requireAdmin());
    window.__roles = []; out.push(await requireAdmin());
    return { out, filtered, signedOut: out2 };
  })()`);
  assert.deepEqual(roles, { out: [true, false], filtered: 'admin', signedOut: 1 });

  // the download link stays valid after the click
  await run(`(() => { window.__rev = 0; URL.revokeObjectURL = () => { __rev++; }; HTMLAnchorElement.prototype.click = function () {};
    bookings = [{ id: 'b1', name: 'A', date: '2026-10-01' }]; downloadDoc('b1'); })()`);
  assert.equal(await run(`__rev`), 0);
};
