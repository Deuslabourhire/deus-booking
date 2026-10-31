// Phone sizes: no zoom on focus, finger-sized buttons, nothing wider than the screen.
const assert = require('assert/strict');
const font = (sel) => `parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(sel)})).fontSize)`;
const columns = (sel) => `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).gridTemplateColumns.split(' ').length`;
const overflow = `document.documentElement.scrollWidth - innerWidth`;
module.exports = async ({ run, open }) => {
  await open('booking.html', 360);
  assert.equal(await run(font('#name')), 16);
  assert.equal(await run(columns('.field-row')), 1);
  assert.ok((await run(overflow)) <= 0, 'booking overflow');

  await open('subcontractor.html', 360);
  await run(`(() => { document.getElementById('app').style.display = 'block'; })()`);
  assert.equal(await run(font('#pName')), 16);
  assert.equal(await run(columns('.row')), 1);
  assert.ok((await run(overflow)) <= 0, 'subcontractor overflow');

  await open('invoice.html', 320);
  assert.equal(await run(font('#clientName')), 16);
  await run(`(() => { const $ = (i) => document.getElementById(i);
    $('clientName').value = 'Ana Lee'; $('startTime').value = '09:00'; $('finishTime').value = '17:30'; $('jobDesc').value = 'Removal service from Croydon to Bondi'; $('gstToggle').checked = true;
    $('genBtn').click(); })()`);
  assert.ok((await run(overflow)) <= 0, 'invoice overflow: ' + await run(overflow));
  const box = await run(`(() => { const r = document.querySelector('.inv-totals').getBoundingClientRect(); return { right: r.right, width: innerWidth }; })()`);
  assert.ok(box.right <= box.width, JSON.stringify(box));

  await open('admin.html', 320);
  assert.equal(await run(font('#emailInput')), 16);
  const r = await run(`(async () => {
    const chain = () => { const c = { select() { return c; }, order() { return c; }, is() { return c; }, not() { return c; }, eq() { return c; },
      limit() { return Promise.resolve({ data: [], error: null }); }, then(f) { return Promise.resolve({ data: [], error: null }).then(f); } }; return c; };
    db.from = chain;
    $('loginScreen').style.display = 'none'; $('app').style.display = 'block';
    switchTab('Subs', document.querySelectorAll('.tab')[0]);
    await SubAdmin.init(db, $('tabSubs'));
    const bar = [...$('tabSubs').querySelectorAll('div')].find((d) => d.style.position === 'sticky');
    const btn = $('tabSubs').querySelector('button');
    return { bar: getComputedStyle(bar).position, btn: btn.getBoundingClientRect().height };
  })()`);
  assert.equal(r.bar, 'static'); assert.ok(r.btn >= 44, 'button ' + r.btn);

  // the invoice preview's table must fit, because the preview box cuts off what is wider
  const t = await run(`(() => {
    switchTab('Invoice', document.querySelectorAll('.tab')[0]);
    window.showToast = () => {};
    $('inv_client').value = 'Ana Lee'; $('inv_start').value = '09:00'; $('inv_finish').value = '17:30'; $('inv_desc').value = 'Removal service from Croydon to Bondi';
    generateAdminInvoice();
    const table = document.querySelector('#inv_preview table'), box = document.getElementById('inv_preview').getBoundingClientRect();
    const totals = $('inv_p_totals').getBoundingClientRect();
    return { table: table.getBoundingClientRect().right, totals: totals.right, box: box.right };
  })()`);
  assert.ok(t.table <= t.box + 1 && t.totals <= t.box + 1, JSON.stringify(t));
};
