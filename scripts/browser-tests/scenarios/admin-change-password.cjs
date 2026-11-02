// Change password and the recovery link. The real supabase-js runs here; only its HTTP calls are answered
// by the stub below, because the order of its session and its PASSWORD_RECOVERY event is what matters.
const assert = require('assert/strict');

const stub = `(() => {
  const jwt = (sub) => [{ alg: 'HS256', typ: 'JWT' }, { sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }]
    .map((p) => btoa(JSON.stringify(p))).join('.') + '.sig';
  const user = { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'admin@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' } });
  window.__jwt = jwt;
  window.__auth = { password: 'Old-Password-1!', admin: !/nonadmin/.test(location.search), logins: [], updates: [], rest: [], loginReply: null, updateReply: null };
  const real = window.fetch;
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (!url.hostname.endsWith('.supabase.co')) return real(input, init);
    const a = window.__auth, method = (init.method || 'GET').toUpperCase(), body = init.body ? JSON.parse(init.body) : null;
    if (url.pathname === '/auth/v1/token') {
      a.logins.push(body);
      if (a.loginReply) return json(a.loginReply.body, a.loginReply.status);
      if (body.password !== a.password) return json({ code: 'invalid_credentials', message: 'Invalid login credentials' }, 400);
      return json({ access_token: jwt('login'), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh', user });
    }
    if (url.pathname === '/auth/v1/user' && method === 'GET') {
      const token = new Headers(init.headers).get('Authorization') || '';
      return token.includes('.') ? json(user) : json({ code: 'bad_jwt', message: 'invalid JWT' }, 403);
    }
    if (url.pathname === '/auth/v1/user' && method === 'PUT') {
      a.updates.push(body);
      if (a.updateReply) return json(a.updateReply.body, a.updateReply.status);
      return json(user);
    }
    if (url.pathname === '/auth/v1/logout') return a.logoutReply ? json(a.logoutReply.body, a.logoutReply.status) : new Response(null, { status: 204 });
    a.rest.push(url.pathname);
    if (url.pathname.endsWith('/user_roles')) return json(a.admin ? [{ role: 'admin' }] : []);
    return json([]);
  };
})();`;

// The fragment Supabase redirects to. The query changes the URL, so the page really loads again.
const recoveryUrl = (query, token) => `admin.html?${query}#access_token=${token}&expires_in=3600&refresh_token=refresh&token_type=bearer&type=recovery`;

module.exports = async ({ run, open, sleep, init }) => {
  await init(stub);
  const shown = (id) => run(`(() => { const e = $('${id}'); return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`);
  const fill = (cur, next, again) => run(`(() => {
    $('pwCurrent').value = ${JSON.stringify(cur)}; $('pwNew').value = ${JSON.stringify(next)}; $('pwConfirm').value = ${JSON.stringify(again)};
    return 1;
  })()`);
  const submit = () => run(`submitPasswordForm(new Event('submit')).then(() => $('pwError').textContent)`);
  const fresh = () => run(`(() => { __auth.logins = []; __auth.updates = []; __auth.rest = []; return 1; })()`);
  const signIn = async () => {
    await run(`$('emailInput').value = 'admin@example.com'; $('passInput').value = __auth.password; login()`);
    await sleep(100);
  };
  const openRecovery = async (query) => {
    const token = await run(`__jwt('recovery')`);
    await open(recoveryUrl(query, token));
    await sleep(200);
  };

  // --- Logged in ---
  await open('admin.html');
  assert.equal(await shown('btnChangePassword'), false, 'no button before login');
  assert.equal(await shown('passwordOverlay'), false);
  await signIn();
  assert.equal(await shown('app'), true);
  assert.equal(await shown('btnChangePassword'), true, 'button once logged in');
  await run(`$('btnChangePassword').click()`);
  for (const id of ['passwordOverlay', 'pwCurrent', 'pwNew', 'pwConfirm']) assert.equal(await shown(id), true, id);

  // New password rules: refused before any call, in English.
  const good = 'New-Password-2!';
  const cases = [
    ['Abcdefgh1!x', /at least 12 characters/], // 11 characters
    ['new-password-2!', /uppercase/],
    ['NEW-PASSWORD-2!', /lowercase/],
    ['New-Password-X!', /number/],
    ['NewPassword123', /symbol/],
    ['New Password 12', /symbol/], // a space is not a symbol
  ];
  for (const [bad, message] of cases) {
    await fresh(); await fill('Old-Password-1!', bad, bad);
    assert.match(await submit(), message, bad);
    assert.deepEqual([await run(`__auth.logins.length`), await run(`__auth.updates.length`)], [0, 0], bad);
  }
  await fresh(); await fill('Old-Password-1!', good, good + 'x');
  assert.match(await submit(), /do not match/);
  await fill('Old-Password-1!', 'Old-Password-1!', 'Old-Password-1!');
  assert.match(await submit(), /different from your current/);
  await fill('', good, good);
  assert.match(await submit(), /current password/i);
  assert.deepEqual([await run(`__auth.logins.length`), await run(`__auth.updates.length`)], [0, 0]);

  // Wrong current password: error, and nothing changes.
  await fresh(); await fill('Wrong-Password-1!', good, good);
  assert.match(await submit(), /Current password is incorrect/);
  assert.equal(await run(`__auth.updates.length`), 0);
  assert.equal(await shown('app'), true, 'still logged in');
  assert.equal(await run(`db.auth.getSession().then((r) => !!r.data.session)`), true);

  // Could not check it (rate limit): not called a wrong password, and nothing changes.
  await fresh(); await run(`__auth.loginReply = { status: 429, body: { code: 'over_request_rate_limit', message: 'Too many requests' } }; 1`);
  await fill('Old-Password-1!', good, good);
  assert.match(await submit(), /Could not verify/);
  assert.equal(await run(`__auth.updates.length`), 0);
  await run(`__auth.loginReply = null; 1`);

  // Refused by the server: its reason is shown, the form stays open and can be sent again.
  await fresh(); await run(`__auth.updateReply = { status: 422, body: { code: 'weak_password', message: 'Password is known to be weak.' } }; 1`);
  await fill('Old-Password-1!', good, good);
  assert.match(await submit(), /known to be weak/);
  assert.equal(await shown('passwordOverlay'), true);
  assert.equal(await run(`$('pwSubmit').disabled`), false);
  await run(`__auth.updateReply = null; 1`);

  // Exactly 12 characters, and the right current password: verified with the logged-in e-mail, then changed.
  const twelve = 'Abcdefgh1!xy';
  await fresh(); await run(`window.__toasts = []; window.showToast = (m) => __toasts.push(m); 1`);
  await fill('Old-Password-1!', twelve, twelve);
  assert.equal(await submit(), '');
  assert.deepEqual((await run(`__auth.logins`)).map((l) => [l.email, l.password]), [['admin@example.com', 'Old-Password-1!']]);
  assert.deepEqual((await run(`__auth.updates`)).map((u) => u.password), [twelve]);
  assert.match((await run(`__toasts`)).join(), /Password changed/);
  assert.equal(await shown('passwordOverlay'), false, 'closed after success');
  assert.equal(await shown('app'), true);
  await run(`$('btnChangePassword').click()`);
  assert.deepEqual([await run(`$('pwCurrent').value`), await run(`$('pwNew').value`), await run(`$('pwConfirm').value`)], ['', '', ''], 'no password left in the form');
  await run(`closePasswordForm()`);

  // The event itself, for a recovery that reaches an open panel: the panel closes.
  await run(`db.auth.getSession().then((r) => db.auth._notifyAllSubscribers('PASSWORD_RECOVERY', r.data.session))`);
  assert.equal(await shown('app'), false, 'event closes the panel');
  assert.equal(await shown('pwNew'), true);
  assert.equal(await shown('pwCurrent'), false);
  await run(`logout()`);
  await sleep(100);

  // --- Recovery link ---
  await openRecovery('r=1');
  assert.equal(await shown('app'), false, 'link must not open the panel');
  assert.equal(await shown('loginScreen'), false);
  assert.equal(await shown('pwNew'), true);
  assert.equal(await shown('pwConfirm'), true);
  assert.equal(await shown('pwCurrent'), false, 'no current password on a recovery link');
  assert.equal(await shown('btnChangePassword'), false);
  assert.equal(await shown('hdrBtns'), false, 'no Add Job or Logout behind the form');
  assert.deepEqual(await run(`__auth.rest`), [], 'no panel data loaded');

  // A reload must not skip the new password, and neither may a page opened afterwards.
  await open('admin.html?r=2');
  await sleep(200);
  assert.equal(await shown('app'), false, 'reload must not open the panel');
  assert.equal(await shown('pwNew'), true);

  // Same rules, without a current password. The server knows the old password, so its refusal keeps the panel closed.
  await fill('', 'short', 'short');
  assert.match(await submit(), /at least 12 characters/);
  await fill('', good, good + 'x');
  assert.match(await submit(), /do not match/);
  await run(`__auth.updateReply = { status: 422, body: { code: 'same_password', message: 'New password should be different from the old password.' } }; 1`);
  await fill('', good, good);
  assert.match(await submit(), /different from the old password/);
  assert.equal(await shown('app'), false);
  await run(`__auth.updateReply = null; window.__toasts = []; window.showToast = (m) => __toasts.push(m); 1`);

  // Changed: no current-password check, then the panel opens.
  await fresh(); await fill('', good, good);
  assert.equal(await submit(), '');
  await sleep(100);
  assert.equal(await run(`__auth.logins.length`), 0);
  assert.deepEqual((await run(`__auth.updates`)).map((u) => u.password), [good]);
  assert.match((await run(`__toasts`)).join(), /Password changed/);
  assert.equal(await shown('passwordOverlay'), false);
  assert.equal(await shown('app'), true, 'panel opens after the change');
  assert.equal(await shown('btnChangePassword'), true);
  assert.equal(await shown('hdrBtns'), true);
  await open('admin.html?r=3');
  await sleep(200);
  assert.equal(await shown('app'), true, 'the next load is a normal one');
  assert.equal(await shown('passwordOverlay'), false);
  await run(`logout()`);
  await sleep(100);

  // Cancel: logged out, and the link's session is gone.
  await openRecovery('r=4');
  await run(`closePasswordForm()`);
  await sleep(100);
  assert.equal(await shown('loginScreen'), true);
  assert.equal(await shown('app'), false);
  assert.equal(await run(`db.auth.getSession().then((r) => !!r.data.session)`), false);
  await open('admin.html?r=5');
  await sleep(200);
  assert.equal(await shown('loginScreen'), true);
  assert.equal(await shown('passwordOverlay'), false);

  // Not an admin: the password can change, the panel still does not open.
  await openRecovery('nonadmin=1');
  await fill('', good, good);
  await submit();
  await sleep(100);
  assert.equal(await run(`__auth.updates.length`), 1);
  assert.equal(await shown('app'), false);
  assert.equal(await shown('loginScreen'), true);

  // A link the server refuses: login screen with a reason, no form.
  await open('admin.html?r=6#access_token=bad&expires_in=3600&refresh_token=refresh&token_type=bearer&type=recovery');
  await sleep(200);
  assert.equal(await shown('passwordOverlay'), false);
  assert.equal(await shown('app'), false);
  assert.equal(await shown('loginScreen'), true);
  assert.match(await run(`$('loginErr').textContent`), /invalid or has expired/);
  assert.equal(await shown('loginErr'), true);

  // A forged link on a browser already logged in must not skip the current password. supabase-js ignores
  // this first one, so the old session survives it; the second it refuses, which logs the browser out.
  await open('admin.html?r=7');
  await signIn();
  assert.equal(await shown('app'), true);
  await open('admin.html?r=9#type=recovery');
  await sleep(200);
  assert.equal(await shown('passwordOverlay'), false, 'a bare type=recovery gets no form');
  assert.equal(await shown('app'), true, 'and the session stays a normal one');
  await open('admin.html?r=8#access_token=bad&expires_in=3600&refresh_token=refresh&token_type=bearer&type=recovery');
  await sleep(200);
  assert.equal(await run(`__auth.updates.length`), 0);
  assert.equal(await shown('passwordOverlay'), false, 'forged link gets no form');
  assert.equal(await shown('pwNew'), false);

  // A sign-out the server refuses leaves the session in the browser, so the recovery must stay pending.
  await openRecovery('r=11');
  await run(`__auth.logoutReply = { status: 500, body: { message: 'down' } }; window.__toasts = []; window.showToast = (m) => __toasts.push(m); 1`);
  await run(`closePasswordForm()`);
  await sleep(100);
  assert.match((await run(`__toasts`)).join(), /Could not log out/);
  assert.equal(await shown('pwNew'), true, 'form stays after a failed sign-out');
  assert.equal(await shown('loginScreen'), false);
  await open('admin.html?r=12');
  await sleep(200);
  assert.equal(await shown('app'), false, 'failed sign-out must not open the panel on reload');
  assert.equal(await shown('pwNew'), true);

  // Not being able to read the session does not mean there is none: the recovery stays pending.
  await run(`db.auth.getSession = async () => ({ data: { session: null }, error: new Error('down') }); restoreSession()`);
  await open('admin.html?r=13');
  await sleep(200);
  assert.equal(await shown('app'), false, 'a failed session read must not open the panel on reload');
  assert.equal(await shown('pwNew'), true);
  await run(`closePasswordForm()`);
  await sleep(100);

  // A marker left behind must not spare the next password login from the current password.
  await open('admin.html?r=14');
  await sleep(100);
  await run(`localStorage.setItem('deusAdminPasswordRecovery', '1'); 1`);
  await signIn();
  await open('admin.html?r=15');
  await sleep(200);
  assert.equal(await shown('app'), true, 'a password login is a normal session');
  assert.equal(await shown('passwordOverlay'), false);
  await run(`$('btnChangePassword').click()`);
  assert.equal(await shown('pwCurrent'), true, 'and it still asks for the current password');
  await run(`closePasswordForm(); logout()`);
  await sleep(100);

  // Phone: the three header buttons and the form stay on screen, and focus does not zoom the page.
  await open('admin.html?r=10', 320);
  await signIn();
  await run(`$('btnChangePassword').click()`);
  const phone = await run(`(() => {
    const inside = (e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; };
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      buttons: [...$('hdrBtns').children].every(inside),
      form: inside(document.querySelector('#passwordOverlay .modal')),
      font: parseFloat(getComputedStyle($('pwNew')).fontSize),
    };
  })()`);
  assert.deepEqual(phone, { overflow: 0, buttons: true, form: true, font: 16 });
};
