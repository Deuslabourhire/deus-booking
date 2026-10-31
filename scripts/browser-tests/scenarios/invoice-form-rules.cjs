// Invoice rules in admin.html and invoice.html, with the database stubbed.
const assert = require('assert/strict');
const fill = `
  window.__t = []; window.showToast = (m) => window.__t.push(m); window.alert = (m) => window.__t.push(m);
  resetAdminInvoice();
  $('inv_client').value = 'Ana'; $('inv_start').value = '09:00'; $('inv_finish').value = '10:00'; $('inv_email').value = 'a@x.au';
`;
module.exports = async ({ run, open }) => {
  await open('admin.html');

  // extra amount without a description must stop the invoice instead of vanishing
  let r = await run(`(() => { ${fill}
    addInvExtra(); const row = $('inv_extras').lastElementChild; row.querySelector('[id$="a"]').value = '80';
    generateAdminInvoice(); return { t: __t.at(-1), calc: lastInvoiceCalc };
  })()`);
  assert.match(r.t, /no description/); assert.equal(r.calc, null);
  r = await run(`(() => { ${fill}
    addInvExtra(); const row = $('inv_extras').lastElementChild; row.querySelector('[id$="a"]').value = '80'; row.querySelector('[id$="d"]').value = 'Piano';
    generateAdminInvoice(); return lastInvoiceCalc.subtotal;
  })()`);
  assert.equal(r, 230);

  // an invalid rate is refused, never replaced by 150
  for (const v of ['0', '', '-5']) {
    r = await run(`(() => { ${fill} $('inv_rate').value = ${JSON.stringify(v)}; generateAdminInvoice(); return { t: __t.at(-1), calc: lastInvoiceCalc }; })()`);
    assert.match(r.t, /hourly rate/, v); assert.equal(r.calc, null, v);
  }
  r = await run(`(() => { ${fill} $('inv_rate').value = ''; $('inv_fixed').checked = true; $('inv_fixed_amt').value = '500'; generateAdminInvoice(); return lastInvoiceCalc.totalAmount; })()`);
  assert.equal(r, 500);
  r = await run(`(() => { window.showToast = (m) => (window.__c = m); $('cStart').value = '09:00'; $('cFinish').value = '10:00'; $('cRate').value = '0'; $('calcTotal').textContent = 'x'; calcJob(); return [window.__c, $('calcTotal').textContent]; })()`);
  assert.match(r[0], /hourly rate/); assert.equal(r[1], 'x');

  await open('invoice.html');
  const inv = `document.getElementById('clientName').value = 'Ana'; document.getElementById('startTime').value = '09:00'; document.getElementById('finishTime').value = '10:00';`;
  r = await run(`(() => { window.__t = []; window.alert = (m) => __t.push(m); ${inv}
    document.getElementById('addExtraBtn').click(); document.querySelector('.extra-item [id$="a"]').value = '80';
    document.getElementById('genBtn').click(); return [__t.at(-1), document.getElementById('invoicePreview').style.display]; })()`);
  assert.match(r[0], /no description/); assert.notEqual(r[1], 'block');
  r = await run(`(() => { window.__t = []; document.getElementById('extrasList').innerHTML = ''; document.getElementById('rate').value = '0';
    document.getElementById('genBtn').click(); return [__t.at(-1), document.getElementById('invoicePreview').style.display]; })()`);
  assert.match(r[0], /hourly rate/); assert.notEqual(r[1], 'block');
};
