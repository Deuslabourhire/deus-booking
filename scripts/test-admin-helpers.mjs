// Small checks for helpers in the pages. Run: node scripts/test-admin-helpers.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../admin.html", import.meta.url), "utf8");
const esc = new Function(html.match(/function esc\(v\)\{.*\}/)[0] + "; return esc;")();

assert.equal(esc('<img src=x onerror="a()">'), "&lt;img src=x onerror=&quot;a()&quot;&gt;");
assert.equal(esc("O'Brien & Sons"), "O&#39;Brien &amp; Sons");
assert.equal(esc(null), "");
assert.equal(esc(0), "0");

// Sydney dates. The results must not depend on this machine's time zone.
const win = {};
new Function("window", readFileSync(new URL("../sub-shared.js", import.meta.url), "utf8"))(win);
const { sydneyDate, sydneyDateTime, addDays } = win.SubShared;
assert.equal(sydneyDate("2026-10-30T22:00:00Z"), "2026-10-31");               // 9 am in summer (UTC+11)
assert.equal(sydneyDateTime("2026-10-30T22:00:00Z"), "2026-10-31 09:00");
assert.equal(sydneyDateTime("2026-06-30T14:30:00+00:00"), "2026-07-01 00:30"); // winter (UTC+10)
assert.equal(sydneyDate("2026-10-31"), "2026-10-31");                          // date without a time
assert.match(sydneyDate(), /^\d{4}-\d{2}-\d{2}$/);
for (const empty of [null, "", "not a date"]) assert.equal(sydneyDateTime(empty), "");
assert.equal(addDays("2026-10-31", 7), "2026-11-07");
assert.equal(addDays("2028-02-28", 1), "2028-02-29");
assert.equal(addDays("2026-12-31", 7), "2027-01-07");

// invoice.html: 9 am in Sydney is still the previous day in UTC.
const invoice = readFileSync(new URL("../invoice.html", import.meta.url), "utf8");
const dates = invoice.match(/var today = new Date\(\);[\s\S]*?var dueStr = .*/)[0];
const at = (iso) => class extends Date { constructor(...a) { super(...(a.length ? a : [iso])); } };
const [today, due] = new Function("Date", dates + "; return [todayStr, dueStr];")(at("2026-10-30T22:00:00Z"));
assert.deepEqual([today, due], ["2026-10-31", "2026-11-07"]);

console.log("ok");
