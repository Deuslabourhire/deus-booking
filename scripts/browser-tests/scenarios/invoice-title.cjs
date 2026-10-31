// "TAX INVOICE" only when GST is on, also for invoices opened from the database and in the e-mail.
const assert = require('assert/strict');
module.exports = async ({ run, open }) => {
  await open('admin.html');
  const gen = (gst) => run(`(() => { window.showToast = () => {}; resetAdminInvoice();
    $('inv_client').value = 'Ana'; $('inv_start').value = '09:00'; $('inv_finish').value = '10:00'; $('inv_gst').checked = ${gst};
    generateAdminInvoice(); return $('inv_p_title').textContent; })()`);
  assert.equal(await gen(false), 'INVOICE');
  assert.equal(await gen(true), 'TAX INVOICE');
  assert.equal(await gen(false), 'INVOICE');

  const opened = (gst) => run(`(async () => {
    const one = { select() { return one; }, eq() { return one; }, order() { return Promise.resolve({ data: [], error: null }); },
      single() { return Promise.resolve({ data: { id: 'i', invoice_number: 'INV-7', status: 'draft', pricing_type: 'fixed', fixed_amount: 10, total_amount: 10, gst_included: ${gst}, customer_snapshot: {}, service_snapshot: {} }, error: null }); } };
    db.from = () => one; HTMLElement.prototype.scrollIntoView = () => {};
    await openInvoice('i'); return $('inv_p_title').textContent; })()`);
  assert.equal(await opened(false), 'INVOICE');
  assert.equal(await opened(true), 'TAX INVOICE');

  const emailed = await run(`(async () => { let body;
    db.auth.getSession = async () => ({ data: { session: { access_token: 't' } } });
    window.fetch = async (u, o) => { body = JSON.parse(o.body); return { ok: true, json: async () => ({ id: 'e' }) }; };
    $('inv_email').value = 'a@x.au'; await sendInvoiceEmail(); return body.invoiceHtml; })()`);
  assert.match(emailed, />TAX INVOICE</);
};
