// Request helpers shared by the e-mail functions.

// Only https origins count: the Authorization header makes CORS the barrier against other pages.
export function allowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGINS") ?? "https://deuslabourhire.github.io")
    .split(",").map((s) => s.trim()).filter((s) => s.startsWith("https://"));
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    // supabase-js in the browser also sends apikey and x-client-info; without them in this list
    // the browser blocks the request after the preflight.
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins().includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function reply(origin: string | null, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export class BodyError extends Error {}

// Reads at most maxBytes of the body. Stops (and cancels the upload) as soon as the limit
// is passed, so a huge request is never held in memory. Throws BodyError("payload_too_large")
// or BodyError("invalid_json").
export async function readJsonLimited(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyError("payload_too_large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyError("payload_too_large");
      }
      chunks.push(value);
    }
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
  } catch {
    throw new BodyError("invalid_json");
  }
}

// One plain address: no lists, no display names, no control characters.
const EMAIL_RE = /^[^\s@,;<>"()[\]\\]+@[^\s@,;<>"()[\]\\]+\.[A-Za-z]{2,}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
export function isPlainEmail(v: unknown): v is string {
  return typeof v === "string" && v.length <= 254 && !CONTROL_RE.test(v) && EMAIL_RE.test(v);
}

// Subjects built from stored data (names typed by a worker): no line breaks, max 200.
export function cleanSubject(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}
