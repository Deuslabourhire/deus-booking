// The worker is only told a warning e-mail went out when it really did.
const assert = require('assert/strict');
const SENT = /warning was sent to your previous e-mail/;
const FAILED = 'Your details were saved and the office can see the change. The warning e-mail could not be sent yet.';
module.exports = async ({ run, open, sleep }) => {
  await open('subcontractor.html#t=' + 'a'.repeat(43));
  await run(`(() => { window.__fail = null; window.fetch = async (u) => {
      if (u.includes('/rest/v1/rpc/')) return { ok: true, json: async () => ({ bank_alert: true }) };
      if (window.__fail === 'network') throw new Error('offline');
      return window.__mail;
    };
    window.__set = (ok, body) => { window.__fail = null; window.__mail = { ok, json: async () => body }; };
    return 1; })()`);
  const save = async (setup) => {
    await run(`(() => { ${setup}; document.getElementById('msg').textContent = ''; document.getElementById('saveProfileBtn').click(); })()`);
    await sleep(120);
    return run(`document.getElementById('msg').textContent`);
  };
  assert.match(await save(`__set(true, { ok: true, alerts: 1, email: [{ admin: 'sent', worker: 'sent' }] })`), SENT);
  assert.equal(await save(`__set(true, { ok: true, alerts: 1, email: [{ admin: 'sent', worker: 'failed_500' }] })`), FAILED);
  assert.equal(await save(`__set(true, { ok: true, alerts: 1, email: [{ admin: 'not_configured', worker: 'sent' }] })`), FAILED);
  assert.equal(await save(`__set(true, { ok: true, alerts: 0, email: [] })`), FAILED);
  assert.equal(await save(`__set(false, { ok: false, error: 'alert_failed' })`), FAILED);
  assert.equal(await save(`window.__fail = 'network'`), FAILED);
};
