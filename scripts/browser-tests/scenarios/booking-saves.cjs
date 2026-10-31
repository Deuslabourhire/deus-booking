// markDone / saveJob with saveToSupabase stubbed: failures must not look like success.
const assert = require('assert/strict');
module.exports = async ({ run, open, sleep }) => {
  await open('admin.html');
  await run(`(() => {
    window.__toasts = []; window.showToast = (m) => window.__toasts.push(m);
    window.__saveOk = true;
    window.saveToSupabase = async (d, id) => window.__saveOk ? { id: id || 'new1', ...d, fromDb: true } : null;
    window.__reset = (ok) => { window.__saveOk = ok; window.__toasts = [];
      bookings = [{ id: 'b1', name: 'Ana', email: 'a@x.au', phone: '1', date: '2026-10-01', start_time: '09:00', pickup_address: 'p', dropoff_address: 'd', status: 'upcoming' }]; };
    window.__form = (editId) => { openAddModal(); $('editId').value = editId;
      const v = { mName: 'Bea', mPhone: '2', mEmail: 'b@x.au', mDate: '2026-11-02', mTime: '10:00', mPickup: 'pp', mDropoff: 'dd' };
      Object.keys(v).forEach((k) => { $(k).value = v[k]; }); };
    return 1;
  })()`);
  const st = () => run(`({ n: bookings.length, first: bookings[0].name, status: bookings[0].status, db: !!bookings[0].fromDb, last: window.__toasts.at(-1), open: $('modalOverlay').classList.contains('open') })`);
  const go = async (code) => { await run(`(async () => { ${code} })()`); return st(); };

  let s = await go(`__reset(true); await markDone('b1');`);
  assert.equal(s.status, 'completed'); assert.match(s.last, /completed/);
  s = await go(`__reset(false); await markDone('b1');`);
  assert.equal(s.status, 'upcoming'); assert.match(s.last, /Could not save/);

  s = await go(`__reset(true); __form('b1'); await saveJob();`);
  assert.deepEqual([s.first, s.open, s.db], ['Bea', false, true]);
  s = await go(`__reset(false); __form('b1'); await saveJob();`);
  assert.deepEqual([s.first, s.open], ['Ana', true]); assert.match(s.last, /Could not save/);

  s = await go(`__reset(true); __form(''); await saveJob();`);
  assert.deepEqual([s.n, s.first, s.open, s.db], [2, 'Bea', false, true]);
  s = await go(`__reset(false); __form(''); await saveJob();`);
  assert.deepEqual([s.n, s.first, s.open], [1, 'Ana', true]); assert.match(s.last, /Could not save/);
  const typed = await run(`$('mName').value`); assert.equal(typed, 'Bea');

};
