// Checks the e-mail functions with no network and no database. Run: node scripts/test-email-functions.mjs
// resend-email is not loaded here because it needs its npm sanitiser; its CORS code is the shared one below.
import assert from "node:assert/strict";

const env = { ALLOWED_ORIGINS: "https://deuslabourhire.github.io, http://evil.example , https://other.example" };
let handler;
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (f) => { handler = f; } };

const { allowedOrigins, corsHeaders, reply } = await import("../supabase/functions/_shared/request.ts");
assert.deepEqual(allowedOrigins(), ["https://deuslabourhire.github.io", "https://other.example"]);
assert.equal(corsHeaders("https://other.example")["Access-Control-Allow-Origin"], "https://other.example");
assert.equal(corsHeaders("http://evil.example")["Access-Control-Allow-Origin"], undefined);
assert.equal(corsHeaders(null)["Access-Control-Allow-Origin"], undefined);
assert.match(corsHeaders(null)["Access-Control-Allow-Headers"], /apikey/);
const r = reply("https://other.example", 418, { ok: false });
assert.equal(r.status, 418);
assert.equal(r.headers.get("Cache-Control"), "no-store");
assert.deepEqual(await r.json(), { ok: false });

delete env.ALLOWED_ORIGINS;
assert.deepEqual(allowedOrigins(), ["https://deuslabourhire.github.io"]);

await import("../supabase/functions/sub-invoice-submit/index.ts");
const origin = "https://deuslabourhire.github.io";
const call = (body, headers = {}) => handler(new Request("https://x/", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Origin: origin, ...headers },
}));

const pre = await handler(new Request("https://x/", { method: "OPTIONS", headers: { Origin: origin } }));
assert.equal(pre.status, 204);
assert.equal(pre.headers.get("Access-Control-Allow-Origin"), origin);
assert.equal((await call({}, { Origin: "https://evil.example" })).status, 403);
assert.equal((await call({ token: "short" })).status, 401);

// The old flow answers "reload the page" with no database call: no database settings exist in this test.
const old = await call({ token: "a".repeat(43), action: "submit" });
assert.equal(old.status, 409);
assert.equal((await old.json()).error, "flow_changed");
assert.equal((await call({ token: "a".repeat(43), action: "nope" })).status, 400);

// Alert e-mails: the real code path, with the database and the e-mail provider faked.
Object.assign(env, {
  SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "k", EMAIL_MODE: "live", RESEND_API_KEY: "r",
  EMAIL_FROM: "from@x.test", ADMIN_NOTIFY_EMAIL: "office@x.test", ALERT_RETRY_SECRET: "s".repeat(32),
});
let mails, channels, claimed;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === "https://api.resend.com/emails") {
    mails.push({ ...JSON.parse(init.body), key: init.headers["Idempotency-Key"] });
    return new Response(JSON.stringify({ id: "e1" }));
  }
  const fn = url.split("/rpc/")[1];
  if (fn === "sub_claim_bank_alerts" || fn === "sub_claim_due_bank_alerts") return new Response(JSON.stringify(claimed));
  if (fn === "sub_record_alert_channel") channels.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ delivery_state: "done" }));
};
const base = { claim_token: "c", attempt: 1, need_admin: true, need_worker: true, created_at: "2026-11-01", worker: "Ana <b>", display_name: "Ana" };
const emailAlert = { ...base, id: 7, kind: "email_changed_by_worker", worker_notify_email: "old@x.test",
  details: { old_email: "o•••@x.test", new_email: "n•••@y.test" } };
const bankDetails = { old: { account_name: "A•••", bsb: "•••111", account_number: "•••222" }, new: { account_name: "B•••", bsb: "•••333", account_number: "•••444" } };
const bankAlert = { ...base, id: 8, kind: "bank_changed_by_worker", worker_notify_email: "old@x.test", details: bankDetails };
// A function deployed before the migration receives alerts with no kind: they are bank alerts.
const noKindAlert = { ...base, id: 9, worker_notify_email: "old@x.test", details: bankDetails };
const claim = async (alerts, send) => { mails = []; channels = []; claimed = alerts; const res = await send(); return { status: res.status, body: await res.json() }; };
const bankChanged = () => call({ token: "a".repeat(43), action: "bank_changed" });

let out = await claim([emailAlert], bankChanged);
assert.equal(out.status, 200);
assert.deepEqual(out.body.email, [{ id: 7, attempt: 1, admin: "sent", worker: "sent", delivery_state: "done" }]);
assert.deepEqual(mails.map((m) => m.to), [["office@x.test"], ["old@x.test"]]);
assert.deepEqual(mails.map((m) => m.key), ["sub-alert-7-admin", "sub-alert-7-worker"]);
assert.match(mails[0].subject, /^Contact e-mail changed — Ana <b>$/);
assert.equal(mails[1].subject, "Your contact e-mail was changed");
for (const m of mails) {
  assert.match(m.html, /o•••@x\.test/);
  assert.match(m.html, /n•••@y\.test/);
  assert.match(m.html, /Ana &lt;b&gt;/);
  assert.doesNotMatch(m.html, /undefined|BSB|null/);
}
assert.deepEqual(channels.map((c) => [c.p_id, c.p_channel, c.p_status]), [[7, "admin", "sent"], [7, "worker", "sent"]]);

// Bank alerts keep their e-mails, with or without a kind, also next to an e-mail alert in the same claim.
out = await claim([bankAlert, noKindAlert, emailAlert], bankChanged);
assert.deepEqual(mails.map((m) => m.subject), [
  "Bank details changed — Ana <b>", "Your bank details were changed",
  "Bank details changed — Ana <b>", "Your bank details were changed",
  "Contact e-mail changed — Ana <b>", "Your contact e-mail was changed",
]);
assert.match(mails[1].html, /BSB •••111/);

// A retry sends only the channel still missing, and the scheduled path sends the same e-mail.
out = await claim([{ ...emailAlert, need_admin: false }], () => call({ action: "retry_due" }, { "x-retry-secret": "s".repeat(32) }));
assert.equal(out.status, 200);
assert.deepEqual(mails.map((m) => m.to), [["old@x.test"]]);

console.log("ok");
