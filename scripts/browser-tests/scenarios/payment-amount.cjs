// The real payment form with the database stubbed: what would be inserted for each typed value?
const assert = require('assert/strict');
module.exports = async ({ run, open, sleep }) => {
  await open('admin.html');
  await run(`(() => {
    window.__ins = []; window.__toasts = []; window.showToast = (m) => window.__toasts.push(m);
    const row = { data: { status: 'sent', paid_date: null }, error: null };
    const chain = { select() { return chain; }, eq() { return chain; }, order() { return Promise.resolve({ data: [], error: null }); }, single() { return Promise.resolve(row); } };
    db.from = () => ({ select: () => chain, insert(p) { window.__ins.push(p); return chain; } });
    window.__pay = async (typed) => {
      currentInvoiceId = '11111111-1111-4111-8111-111111111111'; currentInvoiceStatus = 'sent';
      lastInvoiceCalc = { totalAmount: 5000 };
      showAddPaymentForm();
      $('pay_amount').value = typed; $('pay_method').value = 'cash';
      window.__ins = []; window.__toasts = [];
      await submitAddPayment();
      return { inserted: window.__ins.map((p) => p.amount), toast: window.__toasts.at(-1) };
    };
    return 1;
  })()`);
  for (const [typed, want] of [['1,500', [1500]], ['1,500.50', [1500.5]], ['1500', [1500]], ['150.50', [150.5]],
    ['1,50', []], ['150,50', []], ['1.500', []], ['1.500,50', []], ['1,50,000', []], ['0', []]]) {
    const r = await run(`__pay(${JSON.stringify(typed)})`);
    
    assert.deepEqual(r.inserted, want, typed);
    assert.match(r.toast, want.length ? /Payment recorded/ : /comma only separates thousands/);
  }

};
