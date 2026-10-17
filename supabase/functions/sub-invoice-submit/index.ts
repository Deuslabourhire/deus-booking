// sub-invoice-submit — TEST FIRST (deus-authtest). Publish with verify_jwt: false
// (the worker has no Supabase account; the personal link token is the credential
// and is validated inside the database by public.sub_portal_submit).
//
// Flow: POST {token} -> rpc sub_portal_submit (service_role only) -> invoice created,
//       open days locked -> optional e-mails -> rpc sub_record_email_status.
//
// Secrets / env (never hard-coded):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (provided by the platform)
//   ALLOWED_ORIGINS     comma-separated list of origins allowed by CORS
//   EMAIL_MODE          "live" to really send; anything else = dry-run (default)
//   RESEND_API_KEY      only read when EMAIL_MODE=live
//   EMAIL_FROM          sender, e.g. "Deus Labour Hire <invoices@your-domain>" (live only)
//   ADMIN_NOTIFY_EMAIL  optional; if unset the admin copy is skipped ("not_configured")
//
// The token and e-mail bodies are never logged. The database never returns bank
// details to this function, so they cannot appear in any e-mail.

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const KNOWN_ERRORS: Record<string, [number, string]> = {
  invalid_link: [401, "This link is not valid any more. Please ask the office for a new link."],
  profile_incomplete: [400, "Please complete your details (name, address, ABN and bank details) before sending."],
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
  days: Day[];
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

// Worker copy: days with amounts, ONE travel-time line, totals. No rates shown.
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
<p><b>${esc(w.full_name)}</b> — ABN ${esc(w.abn)}${w.gst_registered ? " — registered for GST" : ""}</p>
<table cellpadding="6" style="border-collapse:collapse;width:100%;font-size:13px">
<tr style="background:#f0f0eb"><th align="left">Date</th><th align="left">Job</th><th align="left">Time</th><th align="right">Hours</th><th align="right">Amount</th></tr>
${rows}${travel}</table>
<p>Subtotal: <b>${money(s.subtotal)}</b></p>${gst}<p>Total: <b>${money(s.total)}</b></p>
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
<p>Review, correct and mark as paid in Admin → Subcontractors.</p></div>`;
}

async function sendEmail(to: string, subject: string, html: string): Promise<string> {
  if ((Deno.env.get("EMAIL_MODE") ?? "dry_run") !== "live") return "dry_run";
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM");
  if (!key || !from) return "not_configured";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    return res.ok ? "sent" : `failed_${res.status}`;
  } catch {
    return "failed_network";
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return reply(origin, 405, { ok: false, error: "method_not_allowed" });
  if (origin && !allowedOrigins().includes(origin)) return reply(origin, 403, { ok: false, error: "origin_not_allowed" });
  if (!/^application\/json\b/i.test(req.headers.get("Content-Type") ?? "")) {
    return reply(origin, 415, { ok: false, error: "unsupported_media_type" });
  }

  let token = "";
  try {
    const raw = await req.text();
    if (raw.length > 1024) return reply(origin, 413, { ok: false, error: "payload_too_large" });
    token = String((JSON.parse(raw) as { token?: unknown }).token ?? "");
  } catch {
    return reply(origin, 400, { ok: false, error: "invalid_json" });
  }
  if (!TOKEN_RE.test(token)) return reply(origin, 401, { ok: false, error: "invalid_link", message: KNOWN_ERRORS.invalid_link[1] });

  let submitted: Submitted;
  try {
    const r = await rpc("sub_portal_submit", { p_token: token });
    if (!r.ok) {
      const msg = String((r.data as { message?: unknown } | null)?.message ?? "");
      const known = KNOWN_ERRORS[msg];
      if (known) return reply(origin, known[0], { ok: false, error: msg, message: known[1] });
      return reply(origin, 500, { ok: false, error: "submit_failed" });
    }
    submitted = r.data as Submitted;
  } catch {
    return reply(origin, 503, { ok: false, error: "service_unavailable" });
  }

  // From here the record is saved and locked; e-mail problems never undo it.
  const workerEmail = typeof submitted.worker.email === "string" ? submitted.worker.email : "";
  const adminEmail = (Deno.env.get("ADMIN_NOTIFY_EMAIL") ?? "").trim();
  const subjectBase = `Work record ${submitted.invoice_number}`;

  const workerStatus = workerEmail
    ? await sendEmail(workerEmail, `${subjectBase} — copy`, workerHtml(submitted))
    : "no_worker_email";
  const adminStatus = adminEmail
    ? await sendEmail(adminEmail, `${subjectBase} — ${String(submitted.worker.full_name ?? "")} — pending`, adminHtml(submitted))
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
});
