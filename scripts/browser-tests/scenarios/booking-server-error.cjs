// The client sees the message sent by create-booking; a repeated booking (200) counts as saved, like 201.
const assert = require('assert/strict');
const FALLBACK = 'Could not save. Please try again or contact us via WhatsApp.';
module.exports = async ({ run, open }) => {
  const submit = async (setup) => {
    await open('booking.html');
    return run(`(async () => {
      console.error = () => {};
      window.fetch = async () => { ${setup} };
      formData = { name: 'Ana', phone: '0400 000 000', email: 'a@x.au', date: '2030-01-01', startTime: '09:00', pickupAddress: 'p', dropoffAddress: 'd', signatureName: 'Ana', signedDate: '2030-01-01T00:00:00Z' };
      await submitBooking();
      return { toast: $('toast').textContent, shown: $('toast').style.display, bold: $('toast').querySelectorAll('b').length,
        done: $('stepDone').classList.contains('active'), disabled: $('btnSubmit').disabled, label: $('btnSubmit').textContent };
    })()`);
  };
  const answer = (status, body) => `return new Response(${JSON.stringify(JSON.stringify(body))}, { status: ${status} });`;

  const refused = async (setup, message) => {
    const r = await submit(setup);
    assert.deepEqual([r.toast, r.shown, r.done, r.disabled, r.label], [message, 'block', false, false, '✓ Confirm My Booking'], setup);
  };
  const PAST = 'The move date cannot be in the past. Please choose today or a later date.';
  await refused(answer(400, { success: false, error: PAST }), PAST);
  await refused(answer(500, { success: false, error: 'We could not save your booking. Please try again.' }), 'We could not save your booking. Please try again.');

  // No usable message: the old text stays.
  await refused(answer(500, { success: false }), FALLBACK);
  await refused(answer(400, { success: false, error: '' }), FALLBACK);
  await refused(answer(400, { success: false, error: { code: 1 } }), FALLBACK);
  await refused(`return new Response('<html>Bad gateway</html>', { status: 502 });`, FALLBACK);
  await refused(`throw new Error('offline');`, FALLBACK);

  // A message is only ever shown as plain text.
  const r = await submit(answer(400, { success: false, error: '<b>x</b>' }));
  assert.deepEqual([r.toast, r.bold], ['<b>x</b>', 0]);

  for (const status of [200, 201]) {
    const ok = await submit(answer(status, { success: true, id: 'b1' }));
    assert.equal(ok.done, true, String(status));
    assert.notEqual(ok.shown, 'block');
  }
};
