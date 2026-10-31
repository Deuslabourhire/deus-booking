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

console.log("ok");
