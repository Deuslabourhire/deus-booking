// A changed contact e-mail asks for its warning, and its alert does not block anything in the Admin.
const assert = require('assert/strict');
const SENT = 'Your details were saved. Because your e-mail changed, the office was notified and a warning was sent to your previous e-mail address.';
const FAILED = 'Your details were saved and the office can see the change. The warning e-mail could not be sent yet.';
const SAVED = 'Your details were saved.';
module.exports = async ({ run, open, sleep }) => {
  await open('subcontractor.html#t=' + 'a'.repeat(43));
  await run(`(() => { window.__calls = 0; window.fetch = async (u) => {
      if (u.includes('/rest/v1/rpc/')) return { ok: true, json: async () => window.__saved };
      window.__calls++;
      return window.__mail;
    };
    return 1; })()`);
  const save = async (saved, mail) => {
    await run(`(() => { window.__saved = ${JSON.stringify(saved)}; window.__calls = 0;
      window.__mail = { ok: ${mail.ok}, json: async () => (${JSON.stringify(mail.body)}) };
      document.getElementById('msg').textContent = ''; document.getElementById('saveProfileBtn').click(); })()`);
    await sleep(120);
    return { msg: await run(`document.getElementById('msg').textContent`), calls: await run(`window.__calls`) };
  };
  const emailOnly = { bank_alert: false, email_alert: true };
  assert.deepEqual(await save(emailOnly, { ok: true, body: { ok: true, alerts: 1, email: [{ admin: 'sent', worker: 'sent' }] } }), { msg: SENT, calls: 1 });
  assert.deepEqual(await save(emailOnly, { ok: true, body: { ok: true, alerts: 1, email: [{ admin: 'sent', worker: 'failed_500' }] } }), { msg: FAILED, calls: 1 });
  assert.deepEqual(await save(emailOnly, { ok: false, body: { ok: false } }), { msg: FAILED, calls: 1 });
  // Nothing changed that needs a warning: no call. The response of the database before this change has no email_alert.
  assert.deepEqual(await save({ bank_alert: false, email_alert: false }, { ok: true, body: {} }), { msg: SAVED, calls: 0 });
  assert.deepEqual(await save({ ok: true, bank_alert: false }, { ok: true, body: {} }), { msg: SAVED, calls: 0 });

  // Admin: only a bank alert blocks; an e-mail alert has its own text.
  await open('admin.html');
  const records = async (alert) => run(`(async () => {
    const data = {
      subcontractors: [{ id: 's1', display_name: 'Ana', full_name: 'Ana', hourly_rate: 30, active: true }],
      sub_invoices: [{ id: 'i1', invoice_number: 'SUB-1', subcontractor_id: 's1', status: 'pending', total: 10, subtotal: 10, submitted_at: '2026-11-01', worker_snapshot: { full_name: 'Ana' } }],
      sub_notifications: [${JSON.stringify(alert)}],
    };
    const chain = (table) => {
      const rows = data[table] || [];
      const c = { select() { return c; }, order() { return c; }, is() { return c; }, not() { return c; }, eq() { return c; },
        limit() { return Promise.resolve({ data: rows, error: null }); },
        then(f) { return Promise.resolve({ data: rows, error: null }).then(f); } };
      return c;
    };
    db.from = chain;
    await SubAdmin.init(db, $('tabSubs'));
    [...$('tabSubs').querySelectorAll('button')].find((x) => x.textContent === 'Records').click();
    await new Promise((r) => setTimeout(r, 100));
    // ticking the record opens the payment bar, which is where a block shows
    const tick = $('tabSubs').querySelector('input[type=checkbox]');
    if (!tick.checked) tick.click();
    await new Promise((r) => setTimeout(r, 100));
    return $('tabSubs').textContent;
  })()`);
  const common = { id: 1, subcontractor_id: 's1', created_at: '2026-11-01T00:00:00Z', email_status: 'sent', worker_email_status: 'sent', delivery_state: 'done', attempts: 1, gave_up_reason: null };
  const email = await records({ ...common, kind: 'email_changed_by_worker', details: { old_email: 'o•••@x.test', new_email: 'n•••@y.test' } });
  assert.match(email, /Contact e-mail changed by Ana/);
  assert.match(email, /o•••@x\.test/);
  assert.match(email, /n•••@y\.test/);
  assert.doesNotMatch(email, /undefined|BLOCKED|Payment blocked|Bank details changed/);
  const bank = await records({ ...common, kind: 'bank_changed_by_worker', details: { old: { account_name: 'A•••', bsb: '•••111', account_number: '•••222' }, new: { account_name: 'B•••', bsb: '•••333', account_number: '•••444' } } });
  assert.match(bank, /Bank details changed by Ana/);
  assert.match(bank, /BLOCKED/);
  assert.match(bank, /Payment blocked/);
};
