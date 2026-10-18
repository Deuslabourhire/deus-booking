// resend-email — sends one e-mail written in the Admin page (client invoices, booking links).
// Deploy with verify_jwt = true. The gateway check alone is not enough (the public anon key
// is itself a valid JWT), so this function also confirms the caller is a signed-in Admin.
//
// Callers (all POST JSON { to, subject, invoiceHtml }, with the Admin's session token):
//   admin.html  sendInvoiceEmail()  — client invoice
//   admin.html  sendBookingLink()   — booking link for an accepted quote
//
// Sending, its secrets (EMAIL_MODE, RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO) and the test
// build that cannot send: ../_shared/email-transport.ts. Other settings:
//   ALLOWED_ORIGINS   optional, comma-separated; default https://deuslabourhire.github.io
//   SUPABASE_URL, SUPABASE_ANON_KEY  provided by Supabase
//
// The HTML is not trusted as sent: it goes through an allow-list sanitiser
// (../_shared/sanitize-email-html.ts) and only the cleaned result is e-mailed.
// Nothing about the recipient, subject, body or token is logged.

import { BodyError, isPlainEmail, readJsonLimited } from "../_shared/request.ts";
import { deliver } from "../_shared/email-transport.ts";
import { sanitizeEmailHtml } from "../_shared/sanitize-email-html.ts";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 200_000;
const MAX_SUBJECT = 200;
const DEFAULT_SUBJECT = "Invoice from Deus Labour Hire";
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const BEARER_RE = /^Bearer\s+([A-Za-z0-9._-]+)$/;
const ALLOWED_KEYS = new Set(["to", "subject", "invoiceHtml", "clientName"]);
const enc = new TextEncoder();

function allowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGINS") ?? "https://deuslabourhire.github.io")
    .split(",").map((s) => s.trim()).filter((s) => s.startsWith("https://"));
}

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    // supabase-js in the browser also sends apikey and x-client-info.
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

// `message` is what admin.html shows in its toast.
const MESSAGES: Record<string, string> = {
  method_not_allowed: "Method not allowed.",
  origin_not_allowed: "This page is not allowed to send e-mails.",
  missing_token: "Session expired — please log in again.",
  invalid_session: "Session expired — please log in again.",
  forbidden: "Only an Admin can send e-mails.",
  auth_unavailable: "Could not check your login right now. Try again.",
  unsupported_media_type: "Invalid request.",
  invalid_json: "Invalid request.",
  invalid_payload: "Invalid request.",
  invalid_recipient: "The client e-mail address is not valid.",
  invalid_subject: "The subject is empty, too long or has line breaks.",
  invalid_content: "The e-mail content is empty after removing unsafe parts.",
  payload_too_large: "The e-mail is too large.",
  email_not_configured: "E-mail sending is not configured on the server.",
  send_failed: "The e-mail provider did not accept the message. Try again later.",
  send_unknown: "The e-mail service did not answer in time. The e-mail MAY have been sent: check before sending it again.",
};
const fail = (origin: string | null, error: string, status: number): Response =>
  reply(origin, status, { ok: false, error, message: MESSAGES[error] ?? "Failed" });

async function requireAdmin(token: string): Promise<"ok" | "invalid_session" | "forbidden" | "auth_unavailable"> {
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return "auth_unavailable";
  const headers = { apikey: anon, Authorization: `Bearer ${token}` };
  try {
    // Confirmed by the Auth server: an anon key or an expired/forged token has no user.
    const u = await fetch(`${url}/auth/v1/user`, { headers });
    if (u.status >= 500) return "auth_unavailable";
    if (!u.ok) return "invalid_session";
    const user = await u.json() as { id?: unknown };
    if (typeof user?.id !== "string" || !user.id) return "invalid_session";
    // Read as the user, under RLS (own row only) — no service role key involved.
    const r = await fetch(
      `${url}/rest/v1/user_roles?select=role&user_id=eq.${encodeURIComponent(user.id)}`,
      { headers: { ...headers, Accept: "application/json" } },
    );
    if (!r.ok) return "auth_unavailable";
    const rows = await r.json() as Array<{ role?: unknown }>;
    return Array.isArray(rows) && rows.some((row) => row?.role === "admin") ? "ok" : "forbidden";
  } catch {
    return "auth_unavailable";
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return fail(origin, "method_not_allowed", 405);

  // Only the Admin page may use this function. (A script outside a browser can fake Origin,
  // so the Admin check below is the real barrier; this stops other web pages.)
  if (!origin || !allowedOrigins().includes(origin)) return fail(origin, "origin_not_allowed", 403);

  const m = (req.headers.get("Authorization") ?? "").match(BEARER_RE);
  if (!m) return fail(origin, "missing_token", 401);
  const auth = await requireAdmin(m[1]);
  if (auth === "auth_unavailable") return fail(origin, auth, 503);
  if (auth !== "ok") return fail(origin, auth, auth === "forbidden" ? 403 : 401);

  if (!/^application\/json\b/i.test(req.headers.get("Content-Type") ?? "")) {
    return fail(origin, "unsupported_media_type", 415);
  }
  let body: unknown;
  try {
    body = await readJsonLimited(req, MAX_BODY_BYTES);   // stops reading past the limit
  } catch (e) {
    const code = e instanceof BodyError ? e.message : "invalid_json";
    return fail(origin, code, code === "payload_too_large" ? 413 : 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(origin, "invalid_payload", 400);
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !ALLOWED_KEYS.has(k))) return fail(origin, "invalid_payload", 400);

  // One recipient only: no lists, no display names, no header tricks.
  const to = typeof b.to === "string" ? b.to.trim() : "";
  if (!isPlainEmail(to)) {
    return fail(origin, "invalid_recipient", 400);
  }
  // Same default as before when the subject is missing.
  const subject = b.subject === undefined || b.subject === null ? DEFAULT_SUBJECT
    : typeof b.subject === "string" ? b.subject.trim() : "";
  if (!subject || subject.length > MAX_SUBJECT || CONTROL_RE.test(subject)) {
    return fail(origin, "invalid_subject", 400);
  }
  const rawHtml = typeof b.invoiceHtml === "string" ? b.invoiceHtml : "";
  if (enc.encode(rawHtml).length > MAX_HTML_BYTES) return fail(origin, "payload_too_large", 413);
  const html = sanitizeEmailHtml(rawHtml);
  // Nothing left to show (no text, no image) after cleaning: refuse instead of sending a blank e-mail.
  if (!html.replace(/<[^>]*>/g, "").trim() && !/<img\b/i.test(html)) return fail(origin, "invalid_content", 400);

  const out = await deliver({ to, subject, html });
  if (out.status === "dry_run") return reply(origin, 200, { ok: true, dry_run: true, id: out.id });
  if (out.status === "sent") return reply(origin, 200, { ok: true, id: out.id });
  if (out.status === "not_configured") return fail(origin, "email_not_configured", 503);
  console.error("resend-email: provider status", out.code);
  // Timeout, network error or provider 5xx/408/409: the result is unknown, not "not sent".
  if (!/^4\d\d$/.test(out.code) || out.code === "408" || out.code === "409") return fail(origin, "send_unknown", 504);
  return fail(origin, "send_failed", 502);
});
