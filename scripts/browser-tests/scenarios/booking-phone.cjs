// The booking form only moves on with a valid Australian phone number.
const assert = require('assert/strict');
const MESSAGE = 'Please enter a valid Australian phone number.';
module.exports = async ({ run, open }) => {
  await open('booking.html');
  assert.equal(await run(`$('f-phone').querySelector('.field-error').textContent`), MESSAGE);
  await run(`(() => { const v = { name: 'Ana', email: 'a@x.au', date: sydneyToday(), startTime: '09:00', pickup: 'A', dropoff: 'B' };
    Object.keys(v).forEach((k) => { $(k).value = v[k]; }); })()`);
  const attempt = (phone) => run(`(() => { $('phone').value = ${JSON.stringify(phone)}; goStep2();
    return { err: $('f-phone').classList.contains('has-error'), step2: $('step2').classList.contains('active') }; })()`);

  for (const phone of ['12', '041234567', '04123456789', '61412345678', '+61 2 9000 0000', '+61 412 345 67', '01 2345 6789', '05 1234 5678',
    '06 1234 5678', '09 1234 5678', '1300 123 456', '1800 123 456', '+55 11 91234 5678', '0412.345.678', '0412 345 67a', '04+12345678', '']) {
    assert.deepEqual(await attempt(phone), { err: true, step2: false }, phone);
  }
  for (const phone of ['0412345678', '0412 345 678', '04-1234-5678', '(04) 1234 5678', '+61412345678', '+61 412 345 678', '+61-412-345-678',
    '+61 (412) 345 678', '02 9000 0000', '(02) 9000 0000', '03-9000-0000', '07 3000 0000', '08 8000 0000', '  0412 345 678  ']) {
    assert.equal((await attempt(phone)).err, false, phone);
  }
  assert.equal(await run(`$('step2').classList.contains('active')`), true);
};
