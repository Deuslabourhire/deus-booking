// sendReminder with the network and the database stubbed out.
const assert = require('assert/strict');
module.exports = async ({ run, open, sleep }) => {
  await open('admin.html');
  await run(`(() => {
    window.__calls = []; window.__saves = []; window.__toasts = []; window.__reply = null; window.__saveOk = true;
    window.showToast = (m) => window.__toasts.push(m);
    db.auth.getSession = async () => ({ data: { session: { access_token: 'tok' } } });
    window.fetch = async (u, o) => { window.__calls.push({ u, body: JSON.parse(o.body) }); await new Promise((r) => setTimeout(r, 20)); return window.__reply; };
    window.saveToSupabase = async (d, id) => { window.__saves.push(d); return window.__saveOk ? { id } : null; };
    window.__set = (status, body) => { window.__reply = { ok: status < 300, status, json: async () => body }; };
    window.__reset = (over) => { window.__calls = []; window.__saves = []; window.__toasts = [];
      bookings = [Object.assign({ id: 'b1', name: 'Ana <b>Lee', email: 'a@x.au', date: '2025-10-01', status: 'completed', reminder_sent: false }, over || {})]; };
    return 1;
  })()`);
  const state = () => run(`({ calls: window.__calls.length, saves: window.__saves.length, flag: bookings[0].reminder_sent, last: window.__toasts.at(-1), html: window.__calls[0] && window.__calls[0].body.invoiceHtml, to: window.__calls[0] && window.__calls[0].body.to })`);
  const go = async (setup) => { await run(`(async () => { ${setup}; await sendReminder('b1'); })()`); return state(); };

  let s = await go(`__reset(); __set(200, { ok: true, id: 'em1' })`);
  
  assert.deepEqual([s.calls, s.saves, s.flag, s.to], [1, 1, true, 'a@x.au']);
  assert.ok(s.html.includes('Ana') && !s.html.includes('<b>') && s.html.includes('10% off'));

  s = await go(`__reset(); __set(502, { ok: false, message: 'provider refused' })`);
  
  assert.deepEqual([s.saves, s.flag], [0, false]); assert.match(s.last, /provider refused/);

  s = await go(`__reset(); __set(200, { ok: true, dry_run: true, id: 'dryrun_1' })`);
  
  assert.deepEqual([s.saves, s.flag], [0, false]); assert.match(s.last, /NOT sent/);

  s = await go(`__reset({ email: '' }); __set(200, { ok: true, id: 'x' })`);
  
  assert.deepEqual([s.calls, s.flag], [0, false]);

  s = await go(`__reset(); window.__saveOk = false; __set(200, { ok: true, id: 'em1' })`);
  
  assert.equal(s.flag, true); assert.match(s.last, /could not be recorded/);

  await run(`(async () => { window.__saveOk = true; __reset(); __set(200, { ok: true, id: 'em1' }); await Promise.all([sendReminder('b1'), sendReminder('b1')]); })()`);
  s = await state();
  
  assert.equal(s.calls, 1);

};
