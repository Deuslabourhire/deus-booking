// Long lists must say they are cut, and the expenses CSV must include every record.
const assert = require('assert/strict');
module.exports = async ({ run, open, sleep }) => {
  await open('admin.html');
  await run(`(() => {
    window.__limits = [];
    const invoices = Array.from({ length: 120 }, (_, i) => ({ id: 'i' + i, invoice_number: 'INV-' + i, customer_snapshot: { name: 'C' + i }, total_amount: 1, status: 'sent', effective_status: 'sent' }));
    const list = { select() { return list; }, order() { return list; }, in() { return Promise.resolve({ data: [], error: null }); }, limit(n) { __limits.push(n); return Promise.resolve({ data: invoices.slice(0, n), error: null }); } };
    db.from = () => list;
    return loadInvoicesList();
  })()`);
  assert.equal(await run(`document.querySelectorAll('#invoicesListBody .inv-row').length`), 50);
  assert.match(await run(`$('invoicesListBody').textContent`), /Search only covers the latest 50/);
  await run(`(() => { $('invSearchInput').value = 'INV-110'; renderInvoicesList(); })()`);
  assert.match(await run(`$('invoicesListBody').textContent`), /No invoices match[\s\S]*Load 50 more/);
  await run(`loadMoreInvoices()`); await run(`loadMoreInvoices()`);
  assert.equal(await run(`document.querySelectorAll('#invoicesListBody .inv-row').length`), 1); // INV-110 found now
  await run(`loadMoreInvoices()`);
  await run(`(() => { $('invSearchInput').value = ''; renderInvoicesList(); })()`);
  assert.doesNotMatch(await run(`$('invoicesListBody').textContent`), /Search only covers/);   // 120 < 200: nothing left

  // the Records tab shows 200 but the CSV must carry all 2500
  const rec = await run(`(async () => {
    const all = Array.from({ length: 2500 }, (_, i) => ({ id: 'r' + i, invoice_number: 'SUB-' + i, status: 'pending', subcontractor_id: 's', total: 1, submitted_at: '2026-01-01',
      worker_snapshot: { full_name: i === 2499 ? '=SUM(1)' : i === 2498 ? '\\tTab' : 'W' }, payment_id: i === 2400 ? 'p1' : null }));
    const pays = [{ id: 'p1', payment_number: 'PAY-1' }];
    const chain = (table) => {
      const rows = table === 'sub_invoices' ? all : table === 'sub_payments' ? pays : [];
      const c = { select() { return c; }, order() { return c; }, is() { return c; }, not() { return c; }, eq() { return c; },
        limit(n) { return Promise.resolve({ data: rows.slice(0, n), error: null }); },
        range(a, b) { return Promise.resolve({ data: rows.slice(a, b + 1), error: null }); },
        then(f) { return Promise.resolve({ data: rows, error: null }).then(f); } };
      return c;
    };
    db.from = chain;
    window.__blob = null; URL.createObjectURL = (b) => { window.__blob = b; return 'blob:x'; };
    HTMLAnchorElement.prototype.click = function () {};
    await SubAdmin.init(db, $('tabSubs'));
    const notice = $('tabSubs').textContent.includes('Showing the latest 200 records');
    [...$('tabSubs').querySelectorAll('button')].find((x) => x.textContent.includes('CSV')).click();
    for (let i = 0; i < 40 && !window.__blob; i++) await new Promise((r) => setTimeout(r, 50));
    const lines = (await __blob.text()).split('\\n');
    return { notice, n: lines.length - 1, pay: lines[2401].includes('PAY-1'), formula: lines[2500].includes("\\"'=SUM(1)\\""), tab: lines[2499].includes("\\"'\\tTab\\"") };
  })()`);
  assert.deepEqual([rec.notice, rec.n, rec.pay, rec.formula], [true, 2500, true, true]);
  // load failure: no partial report
  const failed = await run(`(async () => {
    const c = { select() { return c; }, order() { return c; }, eq() { return c; }, range() { return Promise.resolve({ data: null, error: { message: 'x' } }); } };
    const real = db.from; db.from = () => c; window.__t = []; window.showToast = (m) => __t.push(m); window.__blob = null;
    [...$('tabSubs').querySelectorAll('button')].find((x) => x.textContent.includes('CSV')).click();
    await new Promise((r) => setTimeout(r, 150)); db.from = real;
    return { blob: window.__blob, t: __t.at(-1) };
  })()`);
  assert.equal(failed.blob, null); assert.match(failed.t, /no CSV/);
};
