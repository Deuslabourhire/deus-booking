// The booking form refuses a past date with a clear message.
const assert = require('assert/strict');
module.exports = async ({ run, open }) => {
  await open('booking.html');
  const today = await run(`sydneyToday()`);
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(await run(`$('date').min`), today);
  await run(`(() => { const v = { name: 'Ana', phone: '0400 000 000', email: 'a@x.au', startTime: '09:00', pickup: 'A', dropoff: 'B' };
    Object.keys(v).forEach((k) => { $(k).value = v[k]; }); })()`);
  const attempt = (date) => run(`(() => { $('date').value = ${JSON.stringify(date)}; goStep2();
    const f = $('f-date'); return { step2: $('step2').classList.contains('active'), err: f.classList.contains('has-error'), msg: f.querySelector('.field-error').textContent }; })()`);

  let r = await attempt('2020-01-01');
  assert.deepEqual([r.step2, r.err], [false, true]); assert.match(r.msg, /cannot be in the past/);
  r = await attempt('');
  assert.deepEqual([r.step2, r.err, r.msg], [false, true, 'Select a date.']);
  r = await attempt(today);
  assert.deepEqual([r.step2, r.err], [true, false]);
};
