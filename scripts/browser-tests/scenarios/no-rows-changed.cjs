// An update whose filter matches nothing returns no error: the screen must not report success.
const assert = require('assert/strict');
module.exports = async ({ run, open }) => {
  await open('admin.html');
  await run(`(() => {
    window.__t = []; window.showToast = (m) => __t.push(m); window.confirm = () => true;
    SubShared.dialog = async () => ({ value: true });
    window.loadInvoicesList = async () => {}; window.loadQuotes = async () => {};
    window.__rows = [];
    const chain = { eq() { return chain; }, in() { return chain; }, select() { return Promise.resolve({ data: __rows, error: null }); } };
    db.from = () => ({ update() { return chain; } });
    invoicesListCache = [{ id: 'i1', invoice_number: 'INV-1' }];
    return 1;
  })()`);
  const go = async (call, rows) => { await run(`(async () => { __rows = ${JSON.stringify(rows)}; __t = []; await ${call}; })()`); return run(`__t.at(-1)`); };
  const hit = [{ id: 'x' }];
  assert.match(await go(`markInvoiceAsSent('i1')`, hit), /marked as Sent/);
  assert.match(await go(`markInvoiceAsSent('i1')`, []), /no longer a draft/);
  assert.match(await go(`cancelInvoice('i1')`, hit), /cancelled ✓/);
  assert.match(await go(`cancelInvoice('i1')`, []), /can no longer be cancelled/);
  assert.match(await go(`acceptQuote('q1')`, hit), /accepted ✓/);
  assert.match(await go(`acceptQuote('q1')`, []), /already changed/);
  assert.match(await go(`declineQuote('q1')`, hit), /declined ✓/);
  assert.match(await go(`declineQuote('q1')`, []), /already changed/);
};
