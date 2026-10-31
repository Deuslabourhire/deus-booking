// invoice.html never had a working e-mail (no admin session): the button is gone and the page still works.
const assert = require('assert/strict');
module.exports = async ({ run, open }) => {
  await open('invoice.html');
  const r = await run(`(() => { const $ = (i) => document.getElementById(i);
    $('clientName').value = 'Ana'; $('startTime').value = '09:00'; $('finishTime').value = '10:00'; $('genBtn').click();
    return { btn: !!$('emailBtn'), modal: !!$('emailModal'), shown: $('invoicePreview').style.display, total: $('previewTotals').textContent, print: !!document.querySelector('.btn-print'), back: !!$('backBtn') };
  })()`);
  assert.deepEqual(r, { btn: false, modal: false, shown: 'block', total: 'Subtotal$150.00TOTAL DUEAUD $150.00', print: true, back: true });
};
