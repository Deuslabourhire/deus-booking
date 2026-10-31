// Small checks for helpers in the pages. Run: node scripts/test-admin-helpers.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../admin.html", import.meta.url), "utf8");
const esc = new Function(html.match(/function esc\(v\)\{.*\}/)[0] + "; return esc;")();

assert.equal(esc('<img src=x onerror="a()">'), "&lt;img src=x onerror=&quot;a()&quot;&gt;");
assert.equal(esc("O'Brien & Sons"), "O&#39;Brien &amp; Sons");
assert.equal(esc(null), "");
assert.equal(esc(0), "0");

console.log("ok");
