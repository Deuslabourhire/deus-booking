// A payment above the balance needs a confirmation; long messages stay inside a phone screen.
const assert = require('assert/strict');
const fits = (page) => `(() => {
  showToast('A long message that used to run off both sides of a phone screen, so only part of it could be read at all.', 60000);
  const r = document.getElementById('toast').getBoundingClientRect();
  return { left: r.left, right: r.right, width: innerWidth, height: r.height };
})()`;
module.exports = async ({ run, open }) => {
  await open('admin.html');
  await run(`(() => {
    window.__ins = []; window.__t = []; window.showToast = (m) => __t.push(m);
    window.__answer = null; window.__asked = []; SubShared.dialog = async (o) => { __asked.push(o.title); return __answer; };
    const row = { data: { status: 'partially_paid', paid_date: null }, error: null };
    const chain = { select() { return chain; }, eq() { return chain; }, order() { return Promise.resolve({ data: [{ amount: 100, status: 'completed' }], error: null }); }, single() { return Promise.resolve(row); } };
    db.from = () => ({ select: () => chain, insert(p) { __ins.push(p); return chain; } });
    window.__pay = async (typed) => {
      currentInvoiceId = '11111111-1111-4111-8111-111111111111'; currentInvoiceStatus = 'sent'; lastInvoiceCalc = { totalAmount: 500 };
      lastLoadedPaymentsRows = [{ amount: 100, status: 'completed' }];
      showAddPaymentForm(); $('pay_amount').value = typed; $('pay_method').value = 'cash'; __ins = []; __t = [];
      await submitAddPayment(); return { n: __ins.length, t: __t.at(-1) };
    };
    return 1;
  })()`);
  // above the balance and cancelled: nothing recorded, and the form can be used again
  let r = await run(`__pay('400.01')`); assert.equal(r.n, 0);
  assert.deepEqual(await run(`__asked`), ['This payment is more than the balance. Record it anyway?']);
  assert.equal(await run(`$('btnConfirmPayment').disabled`), false);
  // confirmed: recorded
  await run(`(() => { __answer = { value: true }; __asked = []; })()`);
  r = await run(`__pay('1,500')`); assert.equal(r.n, 1); assert.match(r.t, /Payment recorded/);
  assert.equal((await run(`__asked`)).length, 1);
  // up to the balance: no question
  await run(`(() => { __answer = null; __asked = []; })()`);
  r = await run(`__pay('400')`); assert.equal(r.n, 1);
  assert.equal((await run(`__asked`)).length, 0);

  for (const page of ['admin.html', 'booking.html']) {
    await open(page, 360);
    r = await run(fits(page));
    assert.ok(r.left >= 0 && r.right <= r.width, `${page}: ${JSON.stringify(r)}`);
    assert.ok(r.height > 40, `${page} wraps: ${r.height}`);
  }
};
