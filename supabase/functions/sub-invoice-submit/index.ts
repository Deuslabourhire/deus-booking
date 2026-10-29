// sub-invoice-submit — TEST FIRST (deus-authtest).
// Platform JWT check OFF (supabase/config.toml: [functions.sub-invoice-submit]
// verify_jwt = false). The worker page has no Supabase JWT: it sends the personal
// link token (validated in the database), and the scheduled retry sends
// x-retry-secret without apikey/Authorization. Every action authenticates itself:
// a JWT is never accepted as a substitute for the link token or the retry secret.
// Only "payment_notice" uses an Authorization header: the Admin's own session,
// which is checked by the database (PostgREST verifies the JWT, the RPC checks admin).
//
// Actions (POST JSON):
//   {token, action: "submit", declaration_accepted: true}
//       -> OLD flow, switched off by migration 20261020120000: the database answers
//          flow_changed (409, "reload the page"). Workers now send days with the RPC
//          sub_portal_send_days, and the Admin creates the invoice from sent days; the
//          copy of that invoice to the worker goes through "resend_email" below.
//   {token, action: "bank_changed"}
//       -> rpc sub_claim_bank_alerts (alerts already queued by the database when
//          the worker changed existing bank details) -> admin e-mail alert AND a
//          warning to the worker at the address on file BEFORE the change, both
//          with MASKED values only -> rpc sub_record_alert_channel (per channel,
//          tied to the claim token) -> rpc sub_finish_alert_claim.
//   {action: "retry_due"} + header x-retry-secret: <ALERT_RETRY_SECRET>
//       -> rpc sub_claim_due_bank_alerts: retries alerts left pending (failed send)
//          or whose claim expired (interrupted attempt). Meant for a scheduled job
//          (see supabase/scheduled/sub_alert_retry_cron.sql, every 15 minutes).
//          Disabled (403) when ALERT_RETRY_SECRET is not set or shorter than 32 chars.
//          The database only re-claims an alert within 23 h of its first attempt
//          (sub_alert_retry_window), inside the provider's 24 h idempotency window.
//   {action: "payment_notice", payment_id, confirm_unknown?, reason?}
//   {action: "resend_email", kind: "record_worker"|"record_admin"|"payment_notice", id,
//    confirm_unknown?, reason?}   + header Authorization: Bearer <admin session>
//       -> rpc sub_admin_email_claim AS THE ADMIN (the database refuses non-admins and
//          applies the resend rules: already sent, in progress, outcome unknown after the
//          23 h idempotency window = confirmation + reason) -> ONE e-mail with the key the
//          database chose -> rpc sub_record_email_result (service_role) for that attempt.
//          payment_notice: record numbers, each amount, combined total (no rates, bank
//          account masked). Record copies: same content and subject as at submit time.
//
// Overlapping calls are expected: pg_net sends asynchronously, so a scheduled run
// can overlap a slow previous run, a worker-triggered call or a manual call. Safety
// does NOT come from the schedule interval but from: row locks with SKIP LOCKED (an
// alert is claimed by one caller only), the claim token + 10-minute lease (results
// from an expired claim are ignored), per-channel final statuses, and the
// provider Idempotency-Key below.
//
// Duplicate protection: channels already delivered are never re-sent (the database
// returns need_admin / need_worker); each e-mail carries a Resend Idempotency-Key
// derived from the alert id and channel, so a resend after an interruption between
// "sent" and "recorded" is de-duplicated by the provider.
//
// Secrets / env (never hard-coded):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY  (provided by the platform)
//   ALLOWED_ORIGINS     comma-separated list of origins allowed by CORS
//   EMAIL_MODE, RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO  read only by
//                       ../_shared/email-transport.ts (the test build has a transport that
//                       cannot send: scripts/build-email-functions.sh test)
//   ADMIN_NOTIFY_EMAIL  optional; if unset admin e-mails are skipped ("not_configured");
//                       the Admin still sees the record / alert in the CRM.
//   COMPANY_NAME        optional; name used in the worker bank-change warning.
//   ALERT_RETRY_SECRET  optional; enables action "retry_due" (scheduled retries).
//
// The token and e-mail bodies are never logged. The database never returns bank
// numbers to this function, so they cannot appear in any e-mail.

import { BodyError, cleanSubject, isPlainEmail, readJsonLimited } from "../_shared/request.ts";
import { deliver } from "../_shared/email-transport.ts";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const KNOWN_ERRORS: Record<string, [number, string]> = {
  invalid_link: [401, "This link is not valid any more. Please ask the office for a new link."],
  link_expired: [401, "This link has expired because it was not used for 7 days. Please ask the office for a new link."],
  declaration_required: [400, "Please confirm the declaration before sending."],
  profile_incomplete: [400, "Please complete your details (name, address, email, ABN and bank details) before sending."],
  no_open_days: [400, "There are no new days to send."],
  flow_changed: [409, "This page was updated. Please reload it and send your days again."],
};

// Day lines as returned by the database: hours and amounts only (no rates, no bank data).
type Day = {
  work_date: string; job_type: string; start_time: string; finish_time: string;
  break_minutes: number; work_hours: number; labour_amount: number;
  travel_minutes: number; travel_amount: number; amount?: number;
};
type Submitted = {
  invoice_id: string; invoice_number: string; submitted_at: string;
  worker: Record<string, string | boolean | null>; company: Record<string, string>;
  labour_total: number; travel_total: number; subtotal: number; gst_amount: number; total: number;
  declaration_text: string; declaration_accepted_at: string;
  days: Day[];
  grouped?: boolean;   // invoice made by the Admin from sent days
};
type Masked = { account_name: string | null; bsb: string | null; account_number: string | null };
type BankAlert = {
  id: number; claim_token: string; attempt: number; need_admin: boolean; need_worker: boolean;
  created_at: string; worker: string | null; display_name: string;
  worker_notify_email: string | null;   // address on file BEFORE the change (chosen by the database)
  details: { old: Masked; new: Masked; email_changed_in_same_save?: boolean };
};

function allowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGINS") ?? "https://deuslabourhire.github.io")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    // supabase-js (functions.invoke, used by the Admin page) also sends apikey and x-client-info;
    // without them in this list the browser blocks the request after the preflight.
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins().includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function reply(origin: string | null, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
const money = (n: number) => "$" + Number(n).toFixed(2);
// Amount of one day: work + travel (the database also sends it as "amount").
const dayAmount = (d: Day) => d.amount ?? Number(d.labour_amount) + Number(d.travel_amount);
// One line per day: date, work (+ travel time included), time, hours, the day's amount.
function dayRows(days: Day[]): string {
  return days.map((d) =>
    `<tr><td>${esc(d.work_date)}</td><td>${esc(d.job_type)}${Number(d.travel_minutes) ? ` <small>(incl. travel ${esc(d.travel_minutes)} min)</small>` : ""}</td>` +
    `<td>${esc(d.start_time)}–${esc(d.finish_time)}</td>` +
    `<td style="text-align:right">${esc(d.work_hours)} h</td><td style="text-align:right">${money(dayAmount(d))}</td></tr>`).join("");
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: unknown }> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("server_misconfigured");
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, data };
}

// Older records (sent by the worker with the old flow): ORIGINAL layout, unchanged.
// Worker copy: worker details, days with amounts, ONE travel-time line, totals,
// and the accepted declaration. No rates, no bank details.
function legacyWorkerHtml(s: Submitted): string {
  const w = s.worker;
  const rows = s.days.map((d) =>
    `<tr><td>${esc(d.work_date)}</td><td>${esc(d.job_type)}</td><td>${esc(d.start_time)}–${esc(d.finish_time)}</td>` +
    `<td style="text-align:right">${esc(d.work_hours)} h</td><td style="text-align:right">${money(d.labour_amount)}</td></tr>`).join("");
  const travel = s.travel_total > 0
    ? `<tr><td colspan="4">Travel time</td><td style="text-align:right">${money(s.travel_total)}</td></tr>` : "";
  const gst = w.gst_registered ? `<p>GST: <b>${money(s.gst_amount)}</b></p>` : "";
  return `<div style="font-family:Arial,sans-serif;max-width:640px">
<h2>Work record ${esc(s.invoice_number)}</h2>
<p>Copy of the work record you sent to ${esc(s.company.name)} (ABN ${esc(s.company.abn)}).<br>
This is a payment record, not a tax invoice.</p>
<p><b>${esc(w.full_name)}</b> — ABN ${esc(w.abn)}${w.gst_registered ? " — registered for GST" : ""}<br>
${esc(w.address)}<br>${esc(w.email)}${w.phone ? " · " + esc(w.phone) : ""}</p>
<table cellpadding="6" style="border-collapse:collapse;width:100%;font-size:13px">
<tr style="background:#f0f0eb"><th align="left">Date</th><th align="left">Job</th><th align="left">Time</th><th align="right">Hours</th><th align="right">Amount</th></tr>
${rows}${travel}</table>
<p>Subtotal: <b>${money(s.subtotal)}</b></p>${gst}<p>Total: <b>${money(s.total)}</b></p>
<p style="font-size:12px;border-top:1px solid #eee;padding-top:8px">Declaration accepted on ${esc(s.declaration_accepted_at)}:<br>
<i>${esc(s.declaration_text)}</i></p>
<p style="color:#888;font-size:12px">Status: pending. The office may correct hours before payment.</p></div>`;
}

// Admin copy: summary only (no bank details, no rates). Full detail is in Admin → Subcontractors.
function legacyAdminHtml(s: Submitted): string {
  const w = s.worker;
  const rows = s.days.map((d) =>
    `<tr><td>${esc(d.work_date)}</td><td>${esc(d.job_type)}</td><td>${esc(d.start_time)}–${esc(d.finish_time)}</td>` +
    `<td style="text-align:right">${esc(d.work_hours)} h</td><td style="text-align:right">${money(d.labour_amount)}</td></tr>`).join("");
  return `<div style="font-family:Arial,sans-serif;max-width:640px">
<h2>New subcontractor record ${esc(s.invoice_number)} — pending</h2>
<p><b>${esc(w.full_name)}</b> — ABN ${esc(w.abn)} — GST registered: ${w.gst_registered ? "yes" : "no"}</p>
<table cellpadding="6" border="1" style="border-collapse:collapse;font-size:12px">
<tr><th>Date</th><th>Job</th><th>Time</th><th>Hours</th><th>Amount</th></tr>${rows}
<tr><td colspan="4">Travel time</td><td style="text-align:right">${money(s.travel_total)}</td></tr></table>
<p>Subtotal ${money(s.subtotal)} · GST ${money(s.gst_amount)} · <b>Total ${money(s.total)}</b></p>
<p>Declaration accepted on ${esc(s.declaration_accepted_at)}.</p>
<p>Review, correct and mark as paid in Admin → Subcontractors.</p></div>`;
}

// Invoice made by the Admin from sent days (s.grouped): one line per day, the amount includes
// travel; totals and the accepted declaration. No rates, no bank details.
function groupedWorkerHtml(s: Submitted): string {
  const w = s.worker;
  const gst = w.gst_registered ? `<p>GST: <b>${money(s.gst_amount)}</b></p>` : "";
  return `<div style="font-family:Arial,sans-serif;max-width:640px">
<h2>Work record ${esc(s.invoice_number)}</h2>
<p>Copy of your invoice with ${esc(s.company.name)} (ABN ${esc(s.company.abn)}), made by the office from the days you sent.<br>
This is a payment record, not a tax invoice.</p>
<p><b>${esc(w.full_name)}</b> — ABN ${esc(w.abn)}${w.gst_registered ? " — registered for GST" : ""}<br>
${esc(w.address)}<br>${esc(w.email)}${w.phone ? " · " + esc(w.phone) : ""}</p>
<table cellpadding="6" style="border-collapse:collapse;width:100%;font-size:13px">
<tr style="background:#f0f0eb"><th align="left">Date</th><th align="left">Work</th><th align="left">Time</th><th align="right">Hours</th><th align="right">Amount</th></tr>
${dayRows(s.days)}</table>
<p>Subtotal: <b>${money(s.subtotal)}</b></p>${gst}<p>Total: <b>${money(s.total)}</b></p>
<p style="font-size:12px;border-top:1px solid #eee;padding-top:8px">Declaration accepted on ${esc(s.declaration_accepted_at)}:<br>
<i>${esc(s.declaration_text)}</i></p>
<p style="color:#888;font-size:12px">Status: pending. The office may correct hours before payment.</p></div>`;
}

// Office copy of an invoice made by the Admin: same lines (no bank details, no rates).
function groupedAdminHtml(s: Submitted): string {
  const w = s.worker;
  return `<div style="font-family:Arial,sans-serif;max-width:640px">
<h2>Subcontractor invoice ${esc(s.invoice_number)} — pending</h2>
<p><b>${esc(w.full_name)}</b> — ABN ${esc(w.abn)} — GST registered: ${w.gst_registered ? "yes" : "no"}</p>
<table cellpadding="6" border="1" style="border-collapse:collapse;font-size:12px">
<tr><th>Date</th><th>Work</th><th>Time</th><th>Hours</th><th>Amount</th></tr>${dayRows(s.days)}</table>
<p>Subtotal ${money(s.subtotal)} · GST ${money(s.gst_amount)} · <b>Total ${money(s.total)}</b></p>
<p>Declaration accepted on ${esc(s.declaration_accepted_at)}.</p>
<p>Review, correct and mark as paid in Admin → Subcontractors.</p></div>`;
}

// The layout follows the record: invoices made by the Admin (grouped) use one line per day;
// older records keep their original e-mail.
const workerHtml = (s: Submitted) => s.grouped ? groupedWorkerHtml(s) : legacyWorkerHtml(s);
const adminHtml = (s: Submitted) => s.grouped ? groupedAdminHtml(s) : legacyAdminHtml(s);

// Admin alert: bank details changed through the personal link. Masked values only.
function bankAlertHtml(a: BankAlert): string {
  const m = (x: Masked) => `${esc(x.account_name)} · BSB ${esc(x.bsb)} · Acc ${esc(x.account_number)}`;
  return `<div style="font-family:Arial,sans-serif;max-width:640px">
<h2>Bank details changed by a subcontractor</h2>
<p><b>${esc(a.worker ?? a.display_name)}</b> changed their bank details through the personal link on ${esc(a.created_at)}.</p>
<p>Before: ${m(a.details.old)}<br>After: ${m(a.details.new)}</p>
<p>If this was not expected, revoke the link and confirm the details with the subcontractor before paying.
Open Admin → Subcontractors to review and acknowledge this alert.</p></div>`;
}

// Worker warning: sent to the address on file BEFORE the change. Masked values only.
function workerBankWarningHtml(a: BankAlert, companyName: string): string {
  const m = (x: Masked) => `${esc(x.account_name)} · BSB ${esc(x.bsb)} · Acc ${esc(x.account_number)}`;
  const emailNote = a.details.email_changed_in_same_save
    ? `<p><b>The contact e-mail on your profile was also changed in the same update.</b></p>` : "";
  return `<div style="font-family:Arial,sans-serif;max-width:640px">
<h2>Your bank details were changed</h2>
<p>Hi ${esc(a.worker ?? a.display_name)}, the bank details on your subcontractor profile with ${esc(companyName)}
were changed through your personal link on ${esc(a.created_at)}.</p>
<p>Before: ${m(a.details.old)}<br>After: ${m(a.details.new)}</p>
${emailNote}
<p>If you made this change, no action is needed. <b>If you did not, contact the office immediately</b>
so the link can be revoked and no payment is made to the new account.</p></div>`;
}

// Status strings stored by the database: sent / dry_run / not_configured / failed_<code>.
async function sendEmail(to: string, subject: string, html: string, idempotencyKey?: string): Promise<string> {
  const out = await deliver({ to, subject: cleanSubject(subject), html, idempotencyKey });
  return out.status === "failed" ? `failed_${out.code}` : out.status;
}

function errorReply(origin: string | null, data: unknown, fallback: string): Response {
  const msg = String((data as { message?: unknown } | null)?.message ?? "");
  const known = KNOWN_ERRORS[msg];
  if (known) return reply(origin, known[0], { ok: false, error: msg, message: known[1] });
  return reply(origin, 500, { ok: false, error: fallback });
}

async function handleSubmit(origin: string | null, token: string, declarationAccepted: unknown): Promise<Response> {
  // Checked here for a clear message AND again in the database (authoritative).
  if (declarationAccepted !== true) {
    return reply(origin, 400, { ok: false, error: "declaration_required", message: KNOWN_ERRORS.declaration_required[1] });
  }
  let submitted: Submitted;
  try {
    const r = await rpc("sub_portal_submit", { p_token: token, p_declaration_accepted: true });
    if (!r.ok) return errorReply(origin, r.data, "submit_failed");
    submitted = r.data as Submitted;
  } catch {
    return reply(origin, 503, { ok: false, error: "service_unavailable" });
  }

  // From here the record is saved and locked; e-mail problems never undo it.
  const workerEmail = isPlainEmail(submitted.worker.email) ? submitted.worker.email : "";
  const adminEmail = (Deno.env.get("ADMIN_NOTIFY_EMAIL") ?? "").trim();
  const subjectBase = `Work record ${submitted.invoice_number}`;

  const workerStatus = workerEmail
    ? await sendEmail(workerEmail, `${subjectBase} — copy`, workerHtml(submitted), `sub-record-${submitted.invoice_id}-worker`)
    : "no_worker_email";
  const adminStatus = isPlainEmail(adminEmail)
    ? await sendEmail(adminEmail, `${subjectBase} — ${String(submitted.worker.full_name ?? "")} — pending`, adminHtml(submitted), `sub-record-${submitted.invoice_id}-admin`)
    : "not_configured";

  try {
    await rpc("sub_record_email_status", { p_invoice_id: submitted.invoice_id, p_worker: workerStatus, p_admin: adminStatus });
  } catch { /* status bookkeeping only */ }

  return reply(origin, 200, {
    ok: true,
    invoice_number: submitted.invoice_number,
    subtotal: submitted.subtotal,
    gst_amount: submitted.gst_amount,
    total: submitted.total,
    email: { worker: workerStatus, admin: adminStatus },
  });
}

// Sends the channels still needed for each claimed alert, records each result against
// the claim token, then closes the claim (done / back to pending / gave_up).
async function deliverAlerts(alerts: BankAlert[]): Promise<Record<string, unknown>[]> {
  const adminEmail = (Deno.env.get("ADMIN_NOTIFY_EMAIL") ?? "").trim();
  const companyName = (Deno.env.get("COMPANY_NAME") ?? "Deus Labour Hire Pty Ltd").trim();
  const out: Record<string, unknown>[] = [];
  for (const a of alerts) {
    const result: Record<string, unknown> = { id: a.id, attempt: a.attempt };
    if (a.need_admin) {
      const admin = isPlainEmail(adminEmail)
        ? await sendEmail(adminEmail, `Bank details changed — ${String(a.worker ?? a.display_name)}`, bankAlertHtml(a), `sub-alert-${a.id}-admin`)
        : "not_configured";
      result.admin = admin;
      try { await rpc("sub_record_alert_channel", { p_id: a.id, p_claim_token: a.claim_token, p_channel: "admin", p_status: admin }); } catch { /* claim expires -> retried */ }
    }
    if (a.need_worker) {
      // Only the address chosen by the database (pre-change) is used; nothing from the request body.
      const worker = isPlainEmail(a.worker_notify_email)
        ? await sendEmail(a.worker_notify_email, "Your bank details were changed", workerBankWarningHtml(a, companyName), `sub-alert-${a.id}-worker`)
        : "no_previous_email";
      result.worker = worker;
      try { await rpc("sub_record_alert_channel", { p_id: a.id, p_claim_token: a.claim_token, p_channel: "worker", p_status: worker }); } catch { /* claim expires -> retried */ }
    }
    try {
      const f = await rpc("sub_finish_alert_claim", { p_id: a.id, p_claim_token: a.claim_token });
      result.delivery_state = (f.data as { delivery_state?: string } | null)?.delivery_state ?? "unknown";
    } catch { result.delivery_state = "unknown"; }
    out.push(result);
  }
  return out;
}

async function handleBankChanged(origin: string | null, token: string): Promise<Response> {
  let alerts: BankAlert[];
  try {
    const r = await rpc("sub_claim_bank_alerts", { p_token: token });
    if (!r.ok) return errorReply(origin, r.data, "alert_failed");
    alerts = (r.data as BankAlert[]) ?? [];
  } catch {
    return reply(origin, 503, { ok: false, error: "service_unavailable" });
  }
  const results = await deliverAlerts(alerts);
  return reply(origin, 200, { ok: true, alerts: alerts.length, email: results });
}

function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function handleRetryDue(origin: string | null, req: Request): Promise<Response> {
  const secret = Deno.env.get("ALERT_RETRY_SECRET") ?? "";
  // A short/guessable secret disables the endpoint instead of weakening it.
  if (secret.length < 32 || !sameSecret(req.headers.get("x-retry-secret") ?? "", secret)) {
    return reply(origin, 403, { ok: false, error: "forbidden" });
  }
  let alerts: BankAlert[];
  try {
    const r = await rpc("sub_claim_due_bank_alerts", { p_limit: 20 });
    if (!r.ok) return reply(origin, 500, { ok: false, error: "retry_failed" });
    alerts = (r.data as BankAlert[]) ?? [];
  } catch {
    return reply(origin, 503, { ok: false, error: "service_unavailable" });
  }
  const results = await deliverAlerts(alerts);
  return reply(origin, 200, { ok: true, alerts: alerts.length, email: results });
}

type PaymentNotice = {
  need_send?: boolean; notice_status?: string;
  payment_id: string; payment_number: string; paid_at: string; payment_method: string;
  payment_reference: string | null; total: number; email: string | null; worker: string; company: string;
  bank_masked: Masked; invoices: { invoice_number: string; amount: number }[];
};

// Payment confirmation: record numbers, each amount, combined total. No rates; account masked.
function paymentNoticeHtml(n: PaymentNotice): string {
  const rows = n.invoices.map((i) =>
    `<tr><td>${esc(i.invoice_number)}</td><td style="text-align:right">${money(i.amount)}</td></tr>`).join("");
  const account = n.payment_method === "Bank transfer"
    ? `<br>Account: ${esc(n.bank_masked.account_name)} · BSB ${esc(n.bank_masked.bsb)} · Acc ${esc(n.bank_masked.account_number)}` : "";
  return `<div style="font-family:Arial,sans-serif;max-width:640px">
<h2>Payment ${esc(n.payment_number)}</h2>
<p>Hi ${esc(n.worker)}, ${esc(n.company)} has recorded a payment for the following work record${n.invoices.length > 1 ? "s" : ""}:</p>
<table cellpadding="6" style="border-collapse:collapse;width:100%;font-size:13px">
<tr style="background:#f0f0eb"><th align="left">Record</th><th align="right">Amount</th></tr>
${rows}<tr><td><b>Total paid</b></td><td style="text-align:right"><b>${money(n.total)}</b></td></tr></table>
<p>Date: ${esc(n.paid_at)}<br>Method: ${esc(n.payment_method)}${n.payment_reference ? `<br>Reference: ${esc(n.payment_reference)}` : ""}${account}</p>
<p style="color:#888;font-size:12px">If something does not look right, contact the office.</p></div>`;
}

const SEND_KINDS = new Set(["record_worker", "record_admin", "payment_notice"]);
const CLAIM_ERRORS: Record<string, number> = {
  already_sent: 409, in_progress: 409, unknown_needs_confirmation: 409, reason_required: 400,
  payment_voided: 400, invoice_closed: 400, not_found: 404,
};
type Claim = { kind: string; id: string; attempt_token: string; idem_key: string; to: string | null; data: unknown };

// Admin-started send (first payment notice, or a resend). The database decides whether it is
// allowed and which Idempotency-Key to use; this function only builds and sends the e-mail.
async function handleAdminSend(origin: string | null, req: Request, kind: unknown, id: unknown,
                               confirmUnknown: unknown, reason: unknown): Promise<Response> {
  const auth = req.headers.get("Authorization") ?? "";
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!/^Bearer [A-Za-z0-9._-]+$/.test(auth)) return reply(origin, 401, { ok: false, error: "forbidden" });
  if (typeof kind !== "string" || !SEND_KINDS.has(kind) || typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id) ||
      (confirmUnknown !== undefined && typeof confirmUnknown !== "boolean") ||
      (reason !== undefined && reason !== null && (typeof reason !== "string" || reason.length > 300))) {
    return reply(origin, 400, { ok: false, error: "invalid_request" });
  }
  if (!url || !anon) return reply(origin, 500, { ok: false, error: "server_misconfigured" });
  let c: Claim;
  try {
    // As the Admin: PostgREST verifies the session JWT; the RPC refuses anyone who is not admin.
    const res = await fetch(`${url}/rest/v1/rpc/sub_admin_email_claim`, {
      method: "POST",
      headers: { apikey: anon, Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ p_kind: kind, p_id: id, p_confirm_unknown: confirmUnknown === true, p_reason: reason ?? null }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = String((data as { message?: unknown } | null)?.message ?? "");
      if (msg in CLAIM_ERRORS) return reply(origin, CLAIM_ERRORS[msg], { ok: false, error: msg });
      return reply(origin, 403, { ok: false, error: "forbidden" });
    }
    c = data as Claim;
  } catch {
    return reply(origin, 503, { ok: false, error: "service_unavailable" });
  }

  let status: string;
  if (kind === "record_admin") {
    const adminEmail = (Deno.env.get("ADMIN_NOTIFY_EMAIL") ?? "").trim();
    const s = c.data as Submitted;
    status = isPlainEmail(adminEmail)
      ? await sendEmail(adminEmail, `Work record ${s.invoice_number} — ${String(s.worker.full_name ?? "")} — pending`, adminHtml(s), c.idem_key)
      : "not_configured";
  } else if (kind === "record_worker") {
    const s = c.data as Submitted;
    status = isPlainEmail(c.to)
      ? await sendEmail(c.to, `Work record ${s.invoice_number} — copy`, workerHtml(s), c.idem_key)
      : "no_worker_email";
  } else {
    const n = c.data as PaymentNotice;
    status = isPlainEmail(c.to)
      ? await sendEmail(c.to, `Payment ${n.payment_number} — ${money(n.total)}`, paymentNoticeHtml(n), c.idem_key)
      : "no_worker_email";
  }
  try {
    await rpc("sub_record_email_result", { p_kind: kind, p_id: id, p_attempt_token: c.attempt_token, p_status: status });
  } catch { /* stays "sending": shown as outcome unknown after 10 minutes */ }
  return reply(origin, 200, { ok: true, kind, email: status });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return reply(origin, 405, { ok: false, error: "method_not_allowed" });
  if (origin && !allowedOrigins().includes(origin)) return reply(origin, 403, { ok: false, error: "origin_not_allowed" });
  if (!/^application\/json\b/i.test(req.headers.get("Content-Type") ?? "")) {
    return reply(origin, 415, { ok: false, error: "unsupported_media_type" });
  }

  let body: { token?: unknown; action?: unknown; declaration_accepted?: unknown; payment_id?: unknown;
              kind?: unknown; id?: unknown; confirm_unknown?: unknown; reason?: unknown };
  try {
    body = (await readJsonLimited(req, 1024) ?? {}) as typeof body;   // stops reading past 1 KB
  } catch (e) {
    if (e instanceof BodyError && e.message === "payload_too_large") return reply(origin, 413, { ok: false, error: "payload_too_large" });
    return reply(origin, 400, { ok: false, error: "invalid_json" });
  }
  if (typeof body !== "object" || Array.isArray(body)) return reply(origin, 400, { ok: false, error: "invalid_json" });
  if (body.action === "retry_due") return handleRetryDue(origin, req);
  if (body.action === "payment_notice") {
    return handleAdminSend(origin, req, "payment_notice", body.payment_id, body.confirm_unknown, body.reason);
  }
  if (body.action === "resend_email") return handleAdminSend(origin, req, body.kind, body.id, body.confirm_unknown, body.reason);
  const token = String(body.token ?? "");
  if (!TOKEN_RE.test(token)) return reply(origin, 401, { ok: false, error: "invalid_link", message: KNOWN_ERRORS.invalid_link[1] });

  const action = String(body.action ?? "submit");
  if (action === "submit") return handleSubmit(origin, token, body.declaration_accepted);
  if (action === "bank_changed") return handleBankChanged(origin, token);
  return reply(origin, 400, { ok: false, error: "unknown_action" });
});
