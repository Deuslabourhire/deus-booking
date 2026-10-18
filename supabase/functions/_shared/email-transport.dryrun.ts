// E-mail transport — TEST build (no-send). Copied over email-transport.ts by
// scripts/build-email-functions.sh test. It has no provider address and reads no e-mail
// secret, so no setting (EMAIL_MODE, RESEND_API_KEY, ...) can make it send anything.
// As a second barrier, loading this file restricts outgoing requests to this project's own
// Supabase URL: any other host is refused before a connection is made.

export type Mail = { to: string; subject: string; html: string; idempotencyKey?: string };
export type Outcome =
  | { status: "sent"; id: string }
  | { status: "dry_run"; id: string }
  | { status: "not_configured" }
  | { status: "failed"; code: string };

export const TRANSPORT = "test_no_send";
export const SEND_TIMEOUT_MS = 30_000;   // same interface as the live transport; nothing is sent here

const realFetch = globalThis.fetch;
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  const own = Deno.env.get("SUPABASE_URL");
  if (!own || target.origin !== new URL(own).origin) {
    return Promise.reject(new Error("test build: outgoing request blocked"));
  }
  return realFetch(input, init);
};

export function deliver(_m: Mail): Promise<Outcome> {
  return Promise.resolve({ status: "dry_run", id: "dryrun_" + crypto.randomUUID() });
}
