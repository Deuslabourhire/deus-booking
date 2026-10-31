// The invoice table is e-mailed to clients, so its HTML must stay exactly as it is.
const assert = require('assert/strict');
const S = '<td style="padding:10px 12px;font-size:12px;border-bottom:1px solid #f0f0eb">';
const E = '<td style="padding:10px 12px;font-size:12px;border-bottom:1px solid #f0f0eb;text-align:right;font-weight:600">';
const row = (a, b, c, d) => `<tr>${S}${a}</td>${S}${b}</td>${S}${c}</td>${E}${d}</td></tr>`;
module.exports = async ({ run, open }) => {
  await open('admin.html');
  const html = await run(`(() => {
    window.showToast = () => {}; resetAdminInvoice();
    $('inv_client').value = 'Ana'; $('inv_start').value = '13:05'; $('inv_finish').value = '15:35'; $('inv_desc').value = 'Move <1>'; $('inv_callout').value = '40';
    addInvExtra(); const x = $('inv_extras').lastElementChild; x.querySelector('[id$="d"]').value = 'Piano'; x.querySelector('[id$="a"]').value = '80';
    generateAdminInvoice();
    return document.createElement('tbody').outerHTML && lastRows();
    function lastRows() { const t = document.createElement('table'); t.innerHTML = $('inv_p_items').innerHTML; return t.tBodies[0].innerHTML; }
  })()`);
  const want = row('Move &lt;1&gt;<br><small style="color:#888">1:05 PM – 3:35 PM</small>', '2.50h', '$150.00/hr', '$375.00')
    + row('Call Out Fee', '1', '—', '$40.00') + row('Piano', '1', '—', '$80.00');
  assert.equal(html, want);

  const fixed = await run(`(() => { resetAdminInvoice(); $('inv_client').value = 'Ana'; $('inv_fixed').checked = true; $('inv_fixed_amt').value = '500'; $('inv_fixed_desc').value = 'Flat';
    generateAdminInvoice(); return $('inv_p_items').innerHTML; })()`);
  assert.equal(fixed, row('Flat', '1', 'Fixed', '$500.00'));
  assert.equal(await run(`fmtT(0, 5) + '|' + fmtT(12, 0) + '|' + fmtT(23, 59)`), '12:05 AM|12:00 PM|11:59 PM');
};
