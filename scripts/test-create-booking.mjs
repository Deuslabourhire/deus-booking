// Checks create-booking with no network and no database. Run: node scripts/test-create-booking.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// The function imports supabase-js from a web address: answer with the fake below instead.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("https://esm.sh/@supabase/")) {
      return { shortCircuit: true, url: "data:text/javascript,export const createClient = () => globalThis.fakeDb;" };
    }
    return next(spec, ctx);
  },
});

// A small in-memory database: only what the function uses.
let tables, failInsert, failRead;
const reset = () => { tables = { bookings: [], customers: [], leads: [], quotes: [] }; failInsert = false; failRead = false; };
globalThis.fakeDb = {
  from(table) {
    const filters = [];
    let row = null;
    const run = () => {
      if (row) {
        if (failInsert && table === "bookings") return { data: null, error: { message: "insert failed" } };
        const saved = { id: table + "-" + (tables[table].length + 1), created_at: new Date().toISOString(), ...row };
        tables[table].push(saved);
        return { data: saved, error: null };
      }
      if (failRead && table === "bookings") return { data: null, error: { message: "read failed" } };
      return { data: tables[table].filter((r) => filters.every((f) => f(r))), error: null };
    };
    const first = (out) => out.error ? out : { data: Array.isArray(out.data) ? out.data[0] ?? null : out.data, error: null };
    const q = {
      select: () => q,
      eq: (k, v) => { filters.push((r) => r[k] === v); return q; },
      gte: (k, v) => { filters.push((r) => r[k] >= v); return q; },
      order: () => q,
      limit: () => q,
      insert: (r) => { row = r; return q; },
      update: () => { filters.push(() => false); return q; },
      single: async () => first(run()),
      maybeSingle: async () => first(run()),
      then: (ok, bad) => Promise.resolve(run()).then(ok, bad),
    };
    return q;
  },
};

let handler;
globalThis.Deno = { env: { get: () => "x" }, serve: (f) => { handler = f; } };
await import("../supabase/functions/create-booking/index.ts");
console.error = () => {};   // the failure cases below log on purpose

const sydneyDay = (offset = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date(Date.now() + offset * 86400000));
const good = () => ({
  name: "Ana Silva", phone: "0400 000 000", email: "ana@x.au", date: sydneyDay(7), startTime: "09:00",
  pickupAddress: "1 Pitt St", dropoffAddress: "2 George St", signatureName: "Ana Silva", signedDate: "2030-01-01T00:00:00Z",
});
const post = async (body) => {
  const res = await handler(new Request("https://x/", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const refused = async (change, message) => {
  const out = await post({ ...good(), ...change });
  assert.deepEqual([out.status, out.body], [400, { success: false, error: message }], JSON.stringify(change));
};

reset();
let out = await post("not json");
assert.deepEqual([out.status, out.body.error], [400, "We could not read your booking. Please reload the page and try again."]);
await refused({ name: "" }, "Please enter your name (up to 200 characters).");
await refused({ name: "a".repeat(201) }, "Please enter your name (up to 200 characters).");
await refused({ phone: "12" }, "Please enter a valid Australian phone number.");
await refused({ email: "nope" }, "Please enter a valid email address.");
await refused({ date: "2030-02-31" }, "Please choose a valid move date.");
await refused({ startTime: "25:00" }, "Please choose a valid start time.");
await refused({ pickupAddress: " " }, "Please enter the pickup address.");
await refused({ dropoffAddress: "" }, "Please enter the drop-off address.");
await refused({ signatureName: 5 }, "Please sign with your full name.");
await refused({ signedDate: "someday" }, "We could not confirm the signing date. Please reload the page and try again.");
await refused({ notes: 5 }, "We could not read your notes. Please check them and try again.");
assert.equal(tables.bookings.length, 0);

failInsert = true;
out = await post(good());
assert.deepEqual([out.status, out.body.error], [500, "We could not save your booking. Please try again."]);

reset();
out = await post(good());
assert.deepEqual([out.status, out.body], [201, { success: true, id: "bookings-1" }]);

// Past dates, with the day taken from Sydney and not from the server clock.
const PAST = "The move date cannot be in the past. Please choose today or a later date.";
reset();
await refused({ date: sydneyDay(-1) }, PAST);
await refused({ date: "2020-01-01" }, PAST);
assert.equal(tables.bookings.length, 0);
out = await post({ ...good(), date: sydneyDay() });
assert.equal(out.status, 201);

const RealDate = Date;
const atInstant = (iso) => {
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(iso); }
    static now() { return new RealDate(iso).getTime(); }
  };
};
atInstant("2030-01-01T14:00:00Z");   // 01:00 on 2 January in Sydney, still 1 January in UTC
await refused({ date: "2030-01-01" }, PAST);
assert.equal((await post({ ...good(), date: "2030-01-02" })).status, 201);
globalThis.Date = RealDate;

// Size limits: the limit itself is accepted, one more is refused.
const emailOf = (n) => "a".repeat(n - 5) + "@x.au";
reset();
await refused({ phone: "04" + " ".repeat(21) + "12345678" }, "The phone number must be 30 characters or fewer.");
await refused({ email: emailOf(255) }, "The email address must be 254 characters or fewer.");
await refused({ pickupAddress: "p".repeat(301) }, "The pickup address must be 300 characters or fewer.");
await refused({ dropoffAddress: "d".repeat(301) }, "The drop-off address must be 300 characters or fewer.");
await refused({ signatureName: "s".repeat(201) }, "The signature must be 200 characters or fewer.");
assert.equal(tables.bookings.length, 0);
out = await post({ ...good(), phone: "04" + " ".repeat(20) + "12345678", email: emailOf(254), pickupAddress: "p".repeat(300), dropoffAddress: "d".repeat(300), signatureName: "s".repeat(200) });
assert.equal(out.status, 201);
// Spaces around a value do not count.
assert.equal((await post({ ...good(), pickupAddress: "  " + "q".repeat(300) + "  " })).status, 201);

// Repeats within 10 minutes answer with the existing booking and create nothing.
reset();
const first = await post(good());
assert.deepEqual([first.status, first.body.id], [201, "bookings-1"]);
const customers = tables.customers.length;
out = await post(good());
assert.deepEqual([out.status, out.body], [200, { success: true, id: "bookings-1" }]);
out = await post({ ...good(), email: " ANA@X.AU " });
assert.deepEqual([out.status, out.body.id], [200, "bookings-1"]);
assert.deepEqual([tables.bookings.length, tables.customers.length], [1, customers]);

// Any difference in email, date, time or pickup is a new booking.
for (const change of [{ email: "bea@x.au" }, { date: sydneyDay(8) }, { startTime: "10:00" }, { pickupAddress: "9 Other St" }]) {
  assert.equal((await post({ ...good(), ...change })).status, 201, JSON.stringify(change));
}
assert.equal(tables.bookings.length, 5);

// Older than 10 minutes is a new booking; just inside is still a repeat.
reset();
await post(good());
tables.bookings[0].created_at = new Date(Date.now() - 9 * 60 * 1000).toISOString();
assert.equal((await post(good())).status, 200);
tables.bookings[0].created_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
assert.equal((await post(good())).status, 201);
assert.equal(tables.bookings.length, 2);

// If the check fails, the booking is still created.
reset();
failRead = true;
assert.equal((await post(good())).status, 201);
assert.equal(tables.bookings.length, 1);

// Only Australian numbers: mobile 04xx xxx xxx or +61 4xx xxx xxx, landline 02, 03, 07 or 08.
reset();
for (const phone of ["12", "041234567", "04123456789", "61412345678", "+61 2 9000 0000", "+61 412 345 67", "01 2345 6789", "05 1234 5678",
  "06 1234 5678", "09 1234 5678", "1300 123 456", "1800 123 456", "+55 11 91234 5678", "0412.345.678", "0412 345 67a", "04+12345678"]) {
  await refused({ phone }, "Please enter a valid Australian phone number.");
}
assert.equal(tables.bookings.length, 0);
for (const phone of ["0412345678", "0412 345 678", "04-1234-5678", "(04) 1234 5678", "+61412345678", "+61 412 345 678", "+61-412-345-678",
  "+61 (412) 345 678", "02 9000 0000", "(02) 9000 0000", "03-9000-0000", "07 3000 0000", "08 8000 0000"]) {
  reset();
  assert.equal((await post({ ...good(), phone })).status, 201, phone);
  assert.equal(tables.bookings[0].phone, phone);
}

console.log("ok");
