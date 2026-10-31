// Saving, printing or e-mailing must not use totals or a number that are out of date.
const assert = require('assert/strict');
module.exports = async ({ run, open }) => {
  await open('admin.html');
  await run(`(() => {
    window.__t = []; window.showToast = (m) => __t.push(m); window.__printed = 0;
    db.auth.getSession = async () => ({ data: { session: { access_token: 't' } } });
    window.__sent = []; window.fetch = async (u, o) => { __sent.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ id: 'e1' }) }; };
    window.__inserts = [];
    const chain = { select() { return chain; }, single() { return Promise.resolve({ data: { id: 'new', invoice_number: 'INV-9' }, error: null }); } };
    db.from = () => ({ insert(p) { __inserts.push(p); return chain; } });
    window.open = () => { __printed++; return { document: { write() {}, close() {} }, print() {} }; };
    window.__type = (id, v) => { const e = $(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    resetAdminInvoice();
    $('inv_client').value = 'Ana'; $('inv_start').value = '09:00'; $('inv_finish').value = '10:00'; $('inv_email').value = 'a@x.au';
    generateAdminInvoice();
    return 1;
  })()`);
  const last = () => run(`__t.at(-1)`);

  // an e-mail before saving would go out numbered PENDING
  await run(`sendInvoiceEmail()`);
  assert.match(await last(), /Save the invoice first/);
  assert.equal(await run(`__sent.length`), 0);

  // a form change blocks save, print and e-mail until Generate runs again
  await run(`__type('inv_rate', '200')`);
  await run(`saveAdminInvoice()`); assert.match(await last(), /Generate Invoice again/);
  assert.equal(await run(`__inserts.length`), 0);
  await run(`printAdminInvoice()`); assert.match(await last(), /Generate Invoice again/);
  assert.equal(await run(`__printed`), 0);
  await run(`sendInvoiceEmail()`); assert.match(await last(), /Generate Invoice again/);

  // after Generate and Save, the new values go out with the real number
  await run(`generateAdminInvoice()`);
  await run(`saveAdminInvoice()`);
  assert.equal(await run(`__inserts[0].hourly_rate`), 200);
  await run(`printAdminInvoice()`); assert.equal(await run(`__printed`), 1);
  await run(`sendInvoiceEmail()`);
  assert.equal(await run(`__sent.length`), 1);
  assert.match(await run(`__sent[0].subject`), /INV-9/);

  // typing in the payment form or the search box is not a change to the invoice
  await run(`resetAdminInvoice(); $('inv_client').value = 'Ana'; $('inv_start').value = '09:00'; $('inv_finish').value = '10:00'; generateAdminInvoice();
    $('pay_amount').value = '1'; $('pay_amount').dispatchEvent(new Event('input', { bubbles: true }));
    $('invSearchInput').dispatchEvent(new Event('input', { bubbles: true }));`);
  assert.equal(await run(`invoiceFormDirty`), false);
};
