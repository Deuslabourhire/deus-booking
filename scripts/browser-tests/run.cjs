// Runs each page in headless Chrome. Supabase is mapped to an unreachable address, so these tests
// can never touch a database: each scenario stubs what it needs.
//   node scripts/browser-tests/run.cjs [scenario ...]     CHROME_PATH overrides the browser
//   ROOT=<folder> runs the scenarios against another copy of the pages.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const dir = path.join(__dirname, 'scenarios');
const root = process.env.ROOT || path.join(__dirname, '..', '..');
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const names = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(dir).filter((f) => f.endsWith('.cjs')).map((f) => f.replace('.cjs', '')).sort();

(async () => {
  const server = http.createServer((q, s) => {
    const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
    fs.readFile(f, (e, d) => {
      if (e) { s.writeHead(404); return s.end(); }
      s.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'text/plain' }); s.end(d);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port, dbg = port + 1;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'deus-tests-'));
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--host-resolver-rules=MAP *.supabase.co 127.0.0.1:9', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find((t) => t.type === 'page'); } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0, errors = [], loaded = null; const wait = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id) { wait.get(d.id)(d); wait.delete(d.id); }
    if (d.method === 'Page.loadEventFired' && loaded) loaded();
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const run = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
    if (r.result.exceptionDetails) throw new Error(expr.slice(0, 80) + ' -> ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    return r.result.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  const open = async (page, width) => {
    await send('Emulation.setDeviceMetricsOverride', { width: width || 1200, height: 800, deviceScaleFactor: 1, mobile: !!width });
    const done = new Promise((r) => { loaded = r; });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/${page}` });
    await done; await sleep(300); errors = [];
  };

  let failed = 0;
  for (const name of names) {
    try {
      await require(path.join(dir, name + '.cjs'))({ run, open, sleep, errors: () => errors });
      if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
      console.log('ok  ', name);
    } catch (e) { failed++; console.log('FAIL', name, '\n    ' + String(e.message).split('\n').slice(0, 12).join('\n    ')); }
  }
  ws.close(); chrome.kill(); server.close();
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
