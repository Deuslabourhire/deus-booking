// The text on screen, the admin copy and both signed documents all come from terms.js.
const assert = require('assert/strict');
const capture = `window.__doc = null; URL.createObjectURL = (b) => { window.__doc = b; return 'blob:x'; }; HTMLAnchorElement.prototype.click = function () {};`;
const body = (doc) => doc.slice(doc.indexOf('<h2>TERMS AND CONDITIONS</h2>'), doc.indexOf('<div class="sig-box">'));
module.exports = async ({ run, open }) => {
  await open('booking.html');
  const t = await run(`({ tc: DEUS_TERMS.tc, sa: DEUS_TERMS.sa, boxTc: $('docTC').textContent, boxSa: $('docSA').textContent })`);
  assert.equal(t.boxTc, t.tc); assert.equal(t.boxSa, t.sa);
  assert.match(t.tc, /^DEUS LABOUR HIRE\nMoving & Cleaning Services/);
  assert.match(t.tc, /governed by the laws of Australia\.$/);
  assert.match(t.sa, /Company Representative: Deus Labour Hire Pty Ltd$/);

  const clientDoc = await run(`(async () => { ${capture}
    formData = { name: 'A', phone: '1', email: 'a@x.au', date: '2030-01-01', startTime: '09:00', pickupAddress: 'p', dropoffAddress: 'd', signatureName: 'A', signedDate: '2030-01-01T00:00:00Z' };
    downloadSignedDoc(); return __doc.text(); })()`);

  await open('admin.html');
  assert.equal(await run(`$('docContent').textContent`), t.tc);
  await run(`switchDoc('sa')`);
  assert.equal(await run(`$('docContent').textContent`), t.sa);
  const adminDoc = await run(`(async () => { ${capture}
    bookings = [{ id: 'b', name: 'A', date: '2030-01-01', signature_name: 'A' }]; downloadDoc('b'); return __doc.text(); })()`);

  // both documents have the same terms, and every paragraph shown to the client is in them
  assert.equal(body(adminDoc), body(clientDoc));
  const html = (s) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
  for (const text of [t.tc, t.sa]) {
    for (const block of text.split('\n\n').slice(2)) {
      for (const line of block.split('\n')) assert.ok(body(clientDoc).includes(html(line)), line.slice(0, 70));
    }
  }
  assert.ok(body(clientDoc).includes('Removal services involve inherent risks and minor damage'));
  assert.ok(body(clientDoc).includes('liability will be assessed based on the fair market value of the item considering age'));
};
