// sub-invoice-submit — TEST FIRST (deus-authtest).
// Platform JWT check OFF (supabase/config.toml: [functions.sub-invoice-submit]
// verify_jwt = false). Neither caller has a Supabase JWT: the worker page sends the
// personal link token (validated in the database), and the scheduled retry sends
// x-retry-secret without apikey/Authorization. Every action authenticates itself;
// an Authorization header is never read or accepted as a substitute.
//
// Actions (POST JSON):
//   {token, action: "submit", declaration_accepted: true}
//       -> rpc sub_portal_submit (service_role only; the database re-checks the
//          declaration) -> record created, open days locked -> worker copy +
//          optional admin copy -> rpc sub_record_email_status.
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
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (provided by the platform)
//   ALLOWED_ORIGINS     comma-separated list of origins allowed by CORS
//   EMAIL_MODE          "live" to really send; anything else = dry-run (default)
//   RESEND_API_KEY      only read when EMAIL_MODE=live
//   EMAIL_FROM          sender, e.g. "Deus Labour Hire <invoices@your-domain>" (live only)
//   ADMIN_NOTIFY_EMAIL  optional; if unset admin e-mails are skipped ("not_configured");
//                       the Admin still sees the record / alert in the CRM.
//   COMPANY_NAME        optional; name used in the worker bank-change warning.
//   ALERT_RETRY_SECRET  optional; enables action "retry_due" (scheduled retries).
//
// The token and e-mail bodies are never logged. The database never returns bank
// numbers to this function, so they cannot appear in any e-mail.

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const KNOWN_ERRORS: Record<string, [number, string]> = {
  invalid_link: [401, "This link is not valid any more. Please ask the office for a new link."],
  declaration_required: [400, "Please confirm the declaration before sending."],
  profile_incomplete: [400, "Please complete your details (name, address, email, ABN and bank details) before sending."],
  no_open_days: [400, "There are no new days to send."],
};

// Day lines as returned by the database: hours and amounts only (no rates, no bank data).
type Day = {
  work_date: string; job_type: string; start_time: string; finish_time: string;
  break_minutes: number; work_hours: number; labour_amount: number;
  travel_minutes: number; travel_amount: number;
};
type Submitted = {
  invoice_id: string; invoice_number: string; submitted_at: string;
  worker: Record<string, string | boolean | null>; company: Record<string, string>;
  labour_total: number; travel_total: number; subtotal: number; gst_amount: number; total: number;
  declaration_text: string; declaration_accepted_at: string;
  days: Day[];
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
    "Access-Control-Allow-Headers": "content-type",
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

// Worker copy: worker details, days with amounts, ONE travel-time line, totals,
// and the accepted declaration. No rates, no bank details.
function workerHtml(s: Submitted): string {
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
function adminHtml(s: Submitted): string {
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

async function sendEmail(to: string, subject: string, html: string, idempotencyKey?: string): Promise<string> {
  if ((Deno.env.get("EMAIL_MODE") ?? "dry_run") !== "live") return "dry_run";
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM");
  if (!key || !from) return "not_configured";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`, "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    return res.ok ? "sent" : `failed_${res.status}`;
  } catch {
    return "failed_network";
  }
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
  const workerEmail = typeof submitted.worker.email === "string" ? submitted.worker.email : "";
  const adminEmail = (Deno.env.get("ADMIN_NOTIFY_EMAIL") ?? "").trim();
  const subjectBase = `Work record ${submitted.invoice_number}`;

  const workerStatus = workerEmail
    ? await sendEmail(workerEmail, `${subjectBase} — copy`, workerHtml(submitted), `sub-record-${submitted.invoice_id}-worker`)
    : "no_worker_email";
  const adminStatus = adminEmail
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
      const admin = adminEmail
        ? await sendEmail(adminEmail, `Bank details changed — ${String(a.worker ?? a.display_name)}`, bankAlertHtml(a), `sub-alert-${a.id}-admin`)
        : "not_configured";
      result.admin = admin;
      try { await rpc("sub_record_alert_channel", { p_id: a.id, p_claim_token: a.claim_token, p_channel: "admin", p_status: admin }); } catch { /* claim expires -> retried */ }
    }
    if (a.need_worker) {
      // Only the address chosen by the database (pre-change) is used; nothing from the request body.
      const worker = a.worker_notify_email
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

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return reply(origin, 405, { ok: false, error: "method_not_allowed" });
  if (origin && !allowedOrigins().includes(origin)) return reply(origin, 403, { ok: false, error: "origin_not_allowed" });
  if (!/^application\/json\b/i.test(req.headers.get("Content-Type") ?? "")) {
    return reply(origin, 415, { ok: false, error: "unsupported_media_type" });
  }

  let body: { token?: unknown; action?: unknown; declaration_accepted?: unknown };
  try {
    const raw = await req.text();
    if (raw.length > 1024) return reply(origin, 413, { ok: false, error: "payload_too_large" });
    body = JSON.parse(raw) ?? {};
  } catch {
    return reply(origin, 400, { ok: false, error: "invalid_json" });
  }
  if (body.action === "retry_due") return handleRetryDue(origin, req);
  const token = String(body.token ?? "");
  if (!TOKEN_RE.test(token)) return reply(origin, 401, { ok: false, error: "invalid_link", message: KNOWN_ERRORS.invalid_link[1] });

  const action = String(body.action ?? "submit");
  if (action === "submit") return handleSubmit(origin, token, body.declaration_accepted);
  if (action === "bank_changed") return handleBankChanged(origin, token);
  return reply(origin, 400, { ok: false, error: "unknown_action" });
});
