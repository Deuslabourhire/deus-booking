import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://deuslabourhire.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

const REPEAT_WINDOW_MS = 10 * 60 * 1000;

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function isValidPhone(phone: string) {
  // Same rule as booking.html: mobile 04 or +61 4, landline 02, 03, 07 or 08.
  return /^(0[23478]\d{8}|\+614\d{8})$/.test(phone.replace(/[\s\-()]/g, ""));
}
function isValidTime(time: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

function isValidCalendarDate(dateStr: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(year, month, 0).getDate();
  return day >= 1 && day <= daysInMonth;
}

// Same rule as booking.html.
function sydneyToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
function normalizePhone(phone: string): string {
  const digits = phone.trim().replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("0")) {
    return "61" + digits.slice(1);
  }
  return digits;
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "We could not read your booking. Please reload the page and try again." }, 400);
  }

  const name = getString(body.name);
  if (!name || name.length === 0 || name.length > 200)
    return jsonResponse({ success: false, error: "Please enter your name (up to 200 characters)." }, 400);

  const phone = getString(body.phone);
  if (!phone || !isValidPhone(phone))
    return jsonResponse({ success: false, error: "Please enter a valid Australian phone number." }, 400);
  if (phone.length > 30)
    return jsonResponse({ success: false, error: "The phone number must be 30 characters or fewer." }, 400);

  const email = getString(body.email);
  if (!email || !isValidEmail(email))
    return jsonResponse({ success: false, error: "Please enter a valid email address." }, 400);
  if (email.length > 254)
    return jsonResponse({ success: false, error: "The email address must be 254 characters or fewer." }, 400);

  const date = getString(body.date);
  if (!date || !isValidCalendarDate(date))
    return jsonResponse({ success: false, error: "Please choose a valid move date." }, 400);
  if (date < sydneyToday())
    return jsonResponse({ success: false, error: "The move date cannot be in the past. Please choose today or a later date." }, 400);

  const startTime = getString(body.startTime);
  if (!startTime || !isValidTime(startTime))
    return jsonResponse({ success: false, error: "Please choose a valid start time." }, 400);

  const pickupAddress = getString(body.pickupAddress);
  if (!pickupAddress)
    return jsonResponse({ success: false, error: "Please enter the pickup address." }, 400);
  if (pickupAddress.length > 300)
    return jsonResponse({ success: false, error: "The pickup address must be 300 characters or fewer." }, 400);

  const dropoffAddress = getString(body.dropoffAddress);
  if (!dropoffAddress)
    return jsonResponse({ success: false, error: "Please enter the drop-off address." }, 400);
  if (dropoffAddress.length > 300)
    return jsonResponse({ success: false, error: "The drop-off address must be 300 characters or fewer." }, 400);

  const signatureName = getString(body.signatureName);
  if (!signatureName)
    return jsonResponse({ success: false, error: "Please sign with your full name." }, 400);
  if (signatureName.length > 200)
    return jsonResponse({ success: false, error: "The signature must be 200 characters or fewer." }, 400);

  const signedDate = getString(body.signedDate);
  if (!signedDate || isNaN(Date.parse(signedDate)))
    return jsonResponse({ success: false, error: "We could not confirm the signing date. Please reload the page and try again." }, 400);

  let notes = "";
  if (body.notes !== undefined && body.notes !== null) {
    const notesStr = getString(body.notes);
    if (notesStr === null)
      return jsonResponse({ success: false, error: "We could not read your notes. Please check them and try again." }, 400);
    notes = notesStr.slice(0, 2000);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const emailNorm = normalizeEmail(email);
  const phoneNorm = normalizePhone(phone);

  // ── Repeat of a recent booking: answer with the existing id, create nothing ──
  // shortcut: check then insert, so two requests at the very same moment can both insert; add a unique rule in the database if that happens.
  const { data: recent, error: recentError } = await supabase
    .from("bookings")
    .select("id, email")
    .eq("date", date)
    .eq("start_time", startTime)
    .eq("pickup_address", pickupAddress)
    .gte("created_at", new Date(Date.now() - REPEAT_WINDOW_MS).toISOString())
    .order("created_at", { ascending: true });
  // A failed check must not lose the booking: continue and create it.
  if (recentError) console.error("Could not check for a repeated booking:", recentError);
  const repeated = recent?.find((b) => normalizeEmail(b.email ?? "") === emailNorm);
  if (repeated) return jsonResponse({ success: true, id: repeated.id }, 200);

  let customerId: string | null = null;
  let leadId: string | null = null;

  // ── Validação de quote_id (fail-open) — antes da heurística ──
  let bookingQuoteId: string | null = null;
  let validatedQuote: { id: string; customer_id: string | null; lead_id: string | null } | null = null;
  const quoteIdInput = getString(body.quoteId);

  if (quoteIdInput && isValidUuid(quoteIdInput)) {
    try {
      const { data: quote } = await supabase
        .from("quotes")
        .select("id, contact_email, status, customer_id, lead_id")
        .eq("id", quoteIdInput)
        .maybeSingle();

      if (quote && (quote.status === "sent" || quote.status === "accepted") && quote.contact_email) {
        const quoteEmailNorm = normalizeEmail(quote.contact_email);
        if (quoteEmailNorm === emailNorm) {
          const { data: existingBooking } = await supabase
            .from("bookings")
            .select("id")
            .eq("quote_id", quoteIdInput)
            .limit(1)
            .maybeSingle();

          if (!existingBooking) {
            bookingQuoteId = quoteIdInput;
            validatedQuote = quote;
          }
        }
      }
    } catch (err) {
      console.error("Quote check failed (ignored, booking continues):", err);
    }
  }

  // ── Prioridade: Quote validada com lead_id + customer_id preenchidos ──
  if (validatedQuote && validatedQuote.lead_id && validatedQuote.customer_id) {
    customerId = validatedQuote.customer_id;
    leadId = validatedQuote.lead_id;
  } else {
    // ── Fallback: lógica heurística existente, sem alteração ──
    const { data: byEmail } = await supabase
      .from("customers")
      .select("id")
      .eq("email_normalized", emailNorm)
      .limit(1)
      .maybeSingle();

    const { data: byPhone } = await supabase
      .from("customers")
      .select("id")
      .eq("phone_normalized", phoneNorm)
      .limit(1)
      .maybeSingle();

    if (byEmail && byPhone && byEmail.id !== byPhone.id) {
      customerId = null;
    } else if (byEmail) {
      customerId = byEmail.id;
    } else if (byPhone) {
      customerId = byPhone.id;
    } else {
      const { data: newCustomer } = await supabase
        .from("customers")
        .insert({
          name,
          phone,
          email,
          phone_normalized: phoneNorm,
          email_normalized: emailNorm,
          source: "booking",
        })
        .select("id")
        .single();
      if (newCustomer) customerId = newCustomer.id;
    }

    if (customerId) {
      const { data: lead } = await supabase
        .from("leads")
        .select("id")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lead) leadId = lead.id;
    }
  }

  const { data, error } = await supabase
    .from("bookings")
    .insert({
      name, phone, email, date,
      start_time: startTime,
      pickup_address: pickupAddress,
      dropoff_address: dropoffAddress,
      notes,
      signature_name: signatureName,
      signed_date: signedDate,
      status: "upcoming",
      reminder_sent: false,
      customer_id: customerId,
      lead_id: leadId,
      quote_id: bookingQuoteId,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Could not insert booking:", error);
    return jsonResponse({ success: false, error: "We could not save your booking. Please try again." }, 500);
  }

  // ── Marca a Quote como aceita (best-effort, não desfaz o booking se falhar) ──
  if (bookingQuoteId) {
    const { error: quoteUpdateError } = await supabase
      .from("quotes")
      .update({ status: "accepted" })
      .eq("id", bookingQuoteId);
    if (quoteUpdateError) {
      console.error("Could not update quote status (booking kept):", quoteUpdateError);
    }
  }

  // ── Caminho A apenas: marca o Lead como booked (best-effort, não desfaz o booking se falhar) ──
  if (bookingQuoteId && validatedQuote?.lead_id) {
    const { error: leadUpdateError } = await supabase
      .from("leads")
      .update({ status: "booked" })
      .eq("id", validatedQuote.lead_id);
    if (leadUpdateError) {
      console.error("Could not update lead status (booking kept):", leadUpdateError);
    }
  }

  return jsonResponse({ success: true, id: data.id }, 201);
});
