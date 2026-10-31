// What sendReminder actually sends, compared word for word with the approved text.
const assert = require('assert/strict');
const body = (name) => `Hi ${name},

It's been about a year since we helped with your move. Thank you again for choosing Deus Labour Hire!

If you have another move coming up, we'd love to help again. As a returning customer, you'll get 10% off your next move. Just mention this email when you book. This offer is valid for 2 weeks.

Best regards,
Jefferson Deus
Deus Labour Hire
0430 008 700
deus.labour.hire@gmail.com`;
module.exports = async ({ run, open, sleep }) => {
  await open('admin.html');
  const send = (name) => run(`(async () => {
    window.showToast = () => {}; window.saveToSupabase = async (d, id) => ({ id, ...d });
    db.auth.getSession = async () => ({ data: { session: { access_token: 't' } } });
    let sent; window.fetch = async (u, o) => { sent = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ id: 'e1' }) }; };
    bookings = [{ id: 'b1', name: ${JSON.stringify(name)}, email: 'a@x.au', date: '2025-11-01', status: 'completed' }];
    await sendReminder('b1');
    const box = document.createElement('div'); box.innerHTML = sent.invoiceHtml.replace(/<br>/g, '\\n').replace(/<\\/p><p>/g, '\\n\\n');
    return { subject: sent.subject, text: box.textContent };
  })()`);
  let r = await send('Maria Silva');
  
  assert.equal(r.subject, 'A 10% discount on your next move — Deus Labour Hire');
  assert.equal(r.text, body('Maria'));
  assert.equal((await send('')).text, body('there'));
  assert.equal((await send('   ')).text, body('there'));

};
