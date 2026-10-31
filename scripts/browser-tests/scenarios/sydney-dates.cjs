// Date call sites in the real page. The script sets a fixed device clock of 9 am in Sydney.
const assert = require('assert/strict');
module.exports = async ({ run, open, sleep }) => {
  await open('admin.html');
  const r = await run(`(async () => {
    const Real = Date; const now = Real.parse('2026-10-30T22:00:00Z');
    window.Date = class extends Real { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
    const out = {};
    window.showToast = () => {};
    const eq = { eq() { return this; }, select() { return this; }, single() { return Promise.resolve({ data: null, error: null }); }, then(f) { return Promise.resolve({ error: null }).then(f); } };
    db.from = () => ({ update(row) { out.sent = row.sent_date; return eq; } });
    SubShared.dialog = async () => ({ value: true }); window.loadInvoicesList = async () => {};
    await markInvoiceAsSent('i1');
    window.saveToSupabase = async (d) => { out.signed = d.signed_date; return { id: 'n', ...d }; };
    bookings = []; openAddModal();
    Object.entries({ mName: 'B', mPhone: '1', mEmail: 'b@x.au', mDate: '2026-11-02', mTime: '10:00', mPickup: 'p', mDropoff: 'd' }).forEach(([k, v]) => { $(k).value = v; });
    await saveJob();
    bookings = [{ id: 'b1', name: 'A', date: '2026-10-31', start_time: '09:00' }];
    createInvoice('b1'); out.due = $('inv_due').value;
    quotesListCache = [{ id: 'q', contact_name: 'n', contact_email: 'e', status: 'draft', created_at: '2026-10-30T22:00:00+00:00' }];
    renderQuotesList(); out.quote = document.querySelector('[data-label="Created"]').textContent;
    out.payment = renderInvoicePaymentsBody([{ amount: 1, status: 'completed', paid_at: '2026-10-30T22:00:00+00:00' }], 1).includes('>2026-10-31<');
    bookings = [{ id: 'b1', name: 'A', date: '2026-10-31', start_time: '09:00', status: 'upcoming', signature_name: 'A', signed_date: '2026-10-30T22:00:00+00:00' }];
    renderClients(); out.signedShown = $('clientList').textContent.includes('2026-10-31');
    window.Date = Real;
    return out;
  })()`);
  
  assert.deepEqual(r, { sent: '2026-10-31', signed: '2026-10-31', due: '2026-11-07', quote: '2026-10-31', payment: true, signedShown: true });

};
