// E-mail transport — LIVE build. The only file that talks to Resend or reads its key.
// The TEST build replaces this file with email-transport.dryrun.ts (scripts/build-email-functions.sh),
// so a test deployment contains no Resend code at all.
//
// Secrets:
//   EMAIL_MODE      "live" sends; "dry_run" sends nothing; anything else (or unset) = not_configured
//   RESEND_API_KEY  read only when EMAIL_MODE=live
//   EMAIL_FROM      sender (live only)
//   EMAIL_REPLY_TO  optional

export type Mail = { to: string; subject: string; html: string; idempotencyKey?: string };
export type Outcome =
  | { status: "sent"; id: string }
  | { status: "dry_run"; id: string }
  | { status: "not_configured" }
  | { status: "failed"; code: string };

export const TRANSPORT = "live";

// Upper limit for ONE call to the provider (request + response body). When it is reached the
// request is aborted and the outcome is "failed_timeout" = UNKNOWN (the provider may have accepted
// it), never "not sent". 30 s keeps the worst case of the submit path (two e-mails one after the
// other, plus database calls) inside Supabase's 150 s request limit, and far below the 10-minute
// attempt lease in the database, so an attempt always ends — sent, failed or aborted — while the
// database still blocks cancel / Undo for it.
export const SEND_TIMEOUT_MS = 30_000;

export async function deliver(m: Mail): Promise<Outcome> {
  const mode = Deno.env.get("EMAIL_MODE");
  if (mode === "dry_run") return { status: "dry_run", id: "dryrun_" + crypto.randomUUID() };
  if (mode !== "live") return { status: "not_configured" };
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM");
  if (!key || !from) return { status: "not_configured" };
  const replyTo = (Deno.env.get("EMAIL_REPLY_TO") ?? "").trim();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: ctl.signal,
      headers: {
        Authorization: `Bearer ${key}`, "Content-Type": "application/json",
        ...(m.idempotencyKey ? { "Idempotency-Key": m.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, html: m.html, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    const data = await res.json().catch(() => null) as { id?: unknown } | null;
    if (ctl.signal.aborted) return { status: "failed", code: "timeout" };   // aborted while reading the answer
    if (!res.ok || typeof data?.id !== "string") return { status: "failed", code: String(res.status) };
    return { status: "sent", id: data.id };
  } catch {
    return { status: "failed", code: ctl.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
