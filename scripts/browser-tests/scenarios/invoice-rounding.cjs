// Each invoice line is rounded to cents and the total is their sum.
const assert = require('assert/strict');
const form = (extra) => `(() => { window.showToast = () => {}; resetAdminInvoice();
  $('inv_client').value = 'Ana'; $('inv_start').value = '09:00'; $('inv_finish').value = '10:20'; $('inv_rate').value = '155'; ${extra || ''}
  generateAdminInvoice(); return lastInvoiceCalc; })()`;
module.exports = async ({ run, open }) => {
  await open('admin.html');
  let c = await run(form(`$('inv_gst').checked = true;`));
  assert.deepEqual([c.labourAmount, c.subtotal, c.gstAmount, c.totalAmount], [206.67, 206.67, 20.67, 227.34]);
  assert.match(await run(`$('inv_p_totals').textContent`), /AUD \$227\.34/);

  c = await run(form(`$('inv_callout').value = '10.1'; $('inv_gst').checked = true; $('inv_discount_type').value = 'percent'; $('inv_discount_value').value = '12.5';
    addInvExtra(); const x = $('inv_extras').lastElementChild; x.querySelector('[id$="d"]').value = 'Piano'; x.querySelector('[id$="a"]').value = '0.205';`));
  assert.equal(c.subtotal, 216.98);                   // 206.67 + 10.10 + 0.21, rounded line by line
  assert.equal(c.discountAmount, 27.12);              // 12.5% of 216.98 = 27.1225
  assert.equal(c.taxableSubtotal, 189.86);
  assert.equal(c.gstAmount, 18.99);                   // 18.986
  assert.equal(c.totalAmount, 208.85);
  for (const k of ['subtotal', 'discountAmount', 'taxableSubtotal', 'gstAmount', 'totalAmount']) {
    assert.equal(Math.round(c[k] * 100) / 100, c[k], k);
  }
  assert.equal(await run(`roundMoney(1.005)`), 1.01);
  assert.equal(await run(`roundMoney(0.1 + 0.2)`), 0.3);

  // the calculator follows the same rule
  const calc = await run(`(() => { $('cStart').value = '09:00'; $('cFinish').value = '10:20'; $('cRate').value = '155'; $('cCallout').value = '0'; $('cExtras').value = '0'; $('cGST').checked = true;
    HTMLElement.prototype.scrollIntoView = () => {}; calcJob(); return $('calcTotal').textContent; })()`);
  assert.equal(calc, '$227.34');
};
