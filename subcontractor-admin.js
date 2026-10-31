// Subcontractor work records — Admin/CRM module.
// Usage: SubAdmin.init(db, rootElement[, { portalUrl }])  — db = an admin-logged-in supabase-js v2 client.
// All worker-provided text is rendered with textContent (never innerHTML).
// Every write to records goes through audited SECURITY DEFINER RPCs; the database re-checks admin.
(function () {
  'use strict';

  var db = null, root = null, portalUrl = '', currentFilter = 'pending';
  var cache = { payments: [], subs: [], links: [], invoices: [], alerts: [], waiting: [] };
  var STATUS_LABEL = { pending: 'Pending', approved: 'Approved', paid: 'Paid', cancelled: 'Cancelled' };

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'style') e.style.cssText = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function money(n) { return '$' + Number(n || 0).toFixed(2); }
  // Messages and questions are shown inside the page (SubShared.toast / SubShared.dialog), never with the
  // browser's alert/confirm/prompt: the browser can silence those, and then buttons seem to do nothing.
  function toast(msg, isError) {
    if (typeof window.showToast === 'function') window.showToast(msg, isError ? 6000 : 4000); else SubShared.toast(msg, isError);
  }
  var ERRORS = {
    reason_required: 'Please write a reason (at least 3 characters). It is saved in the history.',
    no_change: 'Nothing was changed, so nothing was saved.',
    role_required: 'The job/role cannot be empty.',
    finish_before_start: 'The finish time must be after the start time.',
    break_too_long: 'The unpaid break is longer than the time worked.',
    break_invalid: 'Unpaid break: choose a value from the list (10-minute steps, up to 2 h).',
    travel_invalid: 'Travel time: choose a value from the list (10-minute steps, up to 4 h).',
    invoice_closed: 'This record is Paid or Cancelled, so it can no longer be corrected.',
    day_not_submitted: 'This day is not part of a sent record.',
    day_changed: 'This day was changed by someone else. Nothing was saved. The list was refreshed: please check it and try again.',
    transition_not_allowed: 'That status change is not allowed for this record.',
    use_void_payment: 'This record is Paid. Undo the payment first (in the record), then you can cancel it.',
    use_record_payment: 'Use the payment bar to record a payment.',
    rate_invalid: 'Enter a valid hourly rate.',
    forbidden: 'Your login is not an Admin login.',
    invoice_not_payable: 'This record is no longer Pending/Approved.',
    already_voided: 'This payment was already undone.',
    email_in_progress: 'An e-mail for this is being sent right now. Wait a minute and try again.',
    not_found: 'This record no longer exists. The list was refreshed.',
    day_not_available: 'One of the days is already in an invoice (or was not sent by the subcontractor). The list was refreshed.',
    no_days_selected: 'Tick at least one day.',
    too_many_days: 'Select at most 100 days for one invoice.',
    mixed_subcontractors: 'One invoice can only include days of one subcontractor.',
    bank_alert_pending: 'This subcontractor changed their bank details. Review and acknowledge the bank-change alert first, then create the invoice.',
    profile_incomplete: 'The subcontractor\'s details are incomplete (name, address, e-mail, ABN or bank details).'
  };
  // Postgres deadlock (SQLSTATE 40P01): the database cancelled this transaction, so nothing was saved.
  var DEADLOCK_MSG = 'Another change was being saved at the same moment, so this one was not saved. Please try again.';
  function fail(e) {
    if (e && e.code === '40P01') return toast(DEADLOCK_MSG, true);
    var c = e && (e.message || e.code); toast(ERRORS[c] || ('The database refused the change: ' + (c || 'unknown error') + '.'), true);
  }
  var BTN = 'padding:6px 10px;border-radius:7px;border:1px solid #ccc;background:#fff;cursor:pointer;font-size:12px;margin:2px';
  var BTN_G = 'padding:6px 10px;border-radius:7px;border:none;background:#1a8a1a;color:#fff;cursor:pointer;font-size:12px;margin:2px';
  var CARD = 'background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:12px;margin-bottom:10px';
  var INPUT = 'padding:6px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px;margin:2px';

  function b64url(bytes) {
    var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function sha256hex(text) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // ------------------------------------------------------------------ data
  async function loadAll() {
    var r = await Promise.all([
      // bank details are NOT in this table; they are only fetched on demand via an audited RPC
      db.from('subcontractors').select('id,display_name,hourly_rate,active,full_name,address,email,phone,abn,gst_registered,profile_updated_at').order('display_name'),
      db.from('sub_links').select('id,subcontractor_id,created_at,expires_at,revoked_at,last_used_at,last_activity_at').is('revoked_at', null),
      db.from('sub_invoices').select('*').order('submitted_at', { ascending: false }).limit(200),
      db.from('sub_notifications').select('id,kind,subcontractor_id,created_at,details,email_status,worker_email_status,delivery_state,attempts,gave_up_reason').is('acknowledged_at', null).order('created_at', { ascending: false }),
      db.from('sub_payments').select('id,payment_number,subcontractor_id,paid_at,payment_method,payment_reference,total,invoice_count,notice_status,notice_attempts,voided_at,void_reason,created_at').order('created_at', { ascending: false }).limit(300),
      // days sent by the workers and not in an invoice yet
      db.from('sub_work_days').select('*').is('invoice_id', null).not('sent_at', 'is', null).order('work_date').order('start_time').limit(1000)
    ]);
    r.forEach(function (x) { if (x.error) throw x.error; });
    cache.subs = r[0].data; cache.links = r[1].data; cache.invoices = r[2].data; cache.alerts = r[3].data; cache.payments = r[4].data;
    cache.waiting = r[5].data;
    // keep only selections that can still be paid / invoiced
    selected = selected.filter(function (id) { var i = invById(id); return i && payable(i); });
    daySel = daySel.filter(function (id) { return !!dayById(id); });
  }
  function invById(id) { return cache.invoices.find(function (x) { return x.id === id; }); }
  function payById(id) { return cache.payments.find(function (x) { return x.id === id; }); }
  function payable(inv) { return inv.status === 'pending' || inv.status === 'approved'; }
  function subName(id) { var s = cache.subs.find(function (x) { return x.id === id; }); return s ? (s.full_name || s.display_name) : '?'; }
  function dayById(id) { return cache.waiting.find(function (x) { return x.id === id; }); }

  // ------------------------------------------------------------------ one payment for several records
  // Tick records of ONE subcontractor; the bar shows the automatic sum and records a single
  // payment. Each record keeps its own number and history; all ticked records become Paid.
  var selected = [];
  var payBar = el('div');
  var NOTICE_LABEL = { sent: 'sent', dry_run: 'dry-run (test, not really sent)', not_configured: 'not sent: e-mail not configured on the server',
    no_worker_email: 'not sent: no e-mail on file', sending: 'sending… (if this stays, the result is unknown)',
    failed_timeout: 'no answer from the e-mail service within 30 s — it MAY have been sent (result unknown)' };
  function noticeLabel(s) { return s ? (NOTICE_LABEL[s] || 'failed (' + s + ')') : 'not sent yet'; }
  // Only a real outcome is final; everything else can be sent again (the database applies the rules).
  function noticeFinal(s) { return s === 'sent' || s === 'dry_run'; }
  function cents(n) { return Math.round(Number(n || 0) * 100); }
  function selectedSum() { return selected.reduce(function (a, id) { return a + cents(invById(id).total); }, 0) / 100; }

  function toggleSelect(inv, cb) {
    if (cb.checked) {
      var first = selected.length ? invById(selected[0]) : null;
      if (first && first.subcontractor_id !== inv.subcontractor_id) {
        cb.checked = false;
        return toast('One payment = one subcontractor. Clear the selection to pay ' + subName(inv.subcontractor_id) + '.');
      }
      if (selected.indexOf(inv.id) < 0) selected.push(inv.id);
    } else {
      selected = selected.filter(function (id) { return id !== inv.id; });
    }
    renderPayBar();
  }

  function renderPayBar() {
    payBar.textContent = '';
    payBar.style.cssText = 'position:sticky;top:0;z-index:5;background:#f0f7f0;border:1px solid #b7dbb7;border-radius:10px;padding:10px;margin-bottom:10px;font-size:13px';
    if (!selected.length) {
      payBar.appendChild(el('span', { style: 'color:#555', text: '💳 To pay, tick the records (Pending or Approved) of one subcontractor. The total is added up here and you record ONE payment.' }));
      return;
    }
    var recs = selected.map(invById);
    var subId = recs[0].subcontractor_id;
    var sum = selectedSum();
    payBar.appendChild(el('div', null, [el('b', { text: '💳 Payment to ' + subName(subId) }), ' · ' + recs.length + ' record' + (recs.length > 1 ? 's' : '') + ': ',
      recs.map(function (i) { return i.invoice_number + ' (' + money(i.total) + ')'; }).join(', ')]));
    payBar.appendChild(el('div', { style: 'font-size:18px;font-weight:bold;margin:4px 0', text: 'Total: ' + money(sum) }));
    var others = cache.invoices.filter(function (i) { return i.subcontractor_id === subId && payable(i) && selected.indexOf(i.id) < 0; });
    if (others.length) {
      payBar.appendChild(el('button', { style: BTN, text: 'Add all ' + others.length + ' other unpaid record(s) of ' + subName(subId), onclick: function () {
        others.forEach(function (i) { selected.push(i.id); }); refresh();
      } }));
    }
    payBar.appendChild(el('button', { style: BTN, text: 'Clear selection', onclick: function () { selected = []; refresh(); } }));
    if (cache.alerts.some(function (a) { return a.subcontractor_id === subId; })) {
      payBar.appendChild(el('div', { style: 'background:#fff0f0;border:1px solid #fca5a5;border-radius:6px;padding:6px;margin:4px 0',
        text: '⚠ Payment blocked: this subcontractor has an unacknowledged bank-change alert (see above).' }));
    }
    var date = el('input', { type: 'date', style: INPUT, value: SubShared.sydneyDate(), max: SubShared.sydneyDate() });
    var method = el('select', { style: INPUT }, [el('option', { value: '', text: 'Payment method *' })]
      .concat(PAY_METHODS.map(function (m) { return el('option', { value: m, text: m }); })));
    var ref = el('input', { style: INPUT, placeholder: 'Reference (optional)', maxlength: '120' });
    payBar.appendChild(el('div', { style: 'margin-top:4px' }, [date, method, ref,
      el('button', { style: BTN_G, text: 'Record payment of ' + money(sum), onclick: function () { recordPayment(date.value, method.value, ref.value, sum, this); } })]));
    payBar.appendChild(el('div', { style: 'font-size:11px;color:#666', text:
      'Pay to the bank details saved with the records (open a record → 🔒 Bank details). All ticked records must have been sent with the same bank details. ' +
      'The subcontractor gets ONE confirmation e-mail with the record numbers and the total.' }));
  }

  // ------------------------------------------------------------------ one invoice from several sent days
  // Tick sent days of ONE subcontractor (any weeks). Confirming creates ONE invoice with ONE number;
  // each day is a line and the total is their sum (+ GST if the subcontractor is registered).
  var daySel = [];
  var dayBar = el('div');
  function dayAmountCents(d) { return cents(d.labour_amount) + cents(d.travel_amount); }
  function dayTotals(ids) {
    var sub = ids.reduce(function (a, id) { return a + dayAmountCents(dayById(id)); }, 0);
    var s = cache.subs.find(function (x) { return x.id === dayById(ids[0]).subcontractor_id; }) || {};
    var gst = s.gst_registered ? Math.round(sub / 10) : 0;     // 10 %, rounded like the database
    return { subtotal: sub / 100, gst: gst / 100, total: (sub + gst) / 100, gstRegistered: !!s.gst_registered };
  }
  function toggleDay(d, cb) {
    if (cb.checked) {
      var first = daySel.length ? dayById(daySel[0]) : null;
      if (first && first.subcontractor_id !== d.subcontractor_id) {
        cb.checked = false;
        return toast('One invoice = one subcontractor. Clear the selection to invoice ' + subName(d.subcontractor_id) + '.');
      }
      if (daySel.indexOf(d.id) < 0) daySel.push(d.id);
    } else {
      daySel = daySel.filter(function (id) { return id !== d.id; });
    }
    renderDayBar();
  }
  function dayLine(d) {
    return d.work_date + ' · ' + (d.role || '?') + ' · ' + money(dayAmountCents(d) / 100);
  }
  function renderDayBar() {
    dayBar.textContent = '';
    dayBar.style.cssText = 'position:sticky;top:0;z-index:5;background:#eef4ff;border:1px solid #b9cdf3;border-radius:10px;padding:10px;margin-bottom:10px;font-size:13px';
    if (!daySel.length) {
      dayBar.appendChild(el('span', { style: 'color:#555', text: '🧾 To make an invoice, tick the sent days of one subcontractor (any weeks). ONE invoice with ONE number is created for all ticked days.' }));
      return;
    }
    var days = daySel.map(dayById).sort(function (a, b) { return a.work_date < b.work_date ? -1 : 1; });
    var subId = days[0].subcontractor_id, t = dayTotals(daySel);
    dayBar.appendChild(el('div', null, [el('b', { text: '🧾 Invoice for ' + subName(subId) }), ' · ' + days.length + ' day' + (days.length > 1 ? 's' : '')]));
    dayBar.appendChild(el('div', { style: 'font-size:12px;color:#444;margin:2px 0', text: days.map(dayLine).join('  |  ') }));
    dayBar.appendChild(el('div', { style: 'font-size:18px;font-weight:bold;margin:4px 0', text: 'Total: ' + money(t.total) +
      (t.gstRegistered ? ' (incl. GST ' + money(t.gst) + ')' : '') }));
    var others = cache.waiting.filter(function (d) { return d.subcontractor_id === subId && daySel.indexOf(d.id) < 0; });
    if (others.length) {
      dayBar.appendChild(el('button', { style: BTN, text: 'Add all ' + others.length + ' other waiting day(s) of ' + subName(subId), onclick: function () {
        others.forEach(function (d) { daySel.push(d.id); }); refresh();
      } }));
    }
    dayBar.appendChild(el('button', { style: BTN, text: 'Clear selection', onclick: function () { daySel = []; refresh(); } }));
    if (cache.alerts.some(function (a) { return a.subcontractor_id === subId; })) {
      dayBar.appendChild(el('div', { style: 'background:#fff0f0;border:1px solid #fca5a5;border-radius:6px;padding:6px;margin:4px 0',
        text: '⚠ This subcontractor has an unacknowledged bank-change alert (see above). Acknowledge it before creating the invoice.' }));
    }
    dayBar.appendChild(el('button', { style: BTN_G, text: 'Create ONE invoice for ' + money(t.total), onclick: function () { createInvoice(this); } }));
  }
  async function createInvoice(btn) {
    var ids = daySel.slice(), days = ids.map(dayById), t = dayTotals(ids), subId = days[0].subcontractor_id;
    var ok = await SubShared.dialog({ title: 'Create one invoice for ' + money(t.total) + '?', confirmText: 'Create invoice',
      message: 'Subcontractor: ' + subName(subId) + '\n' + days.map(dayLine).join('\n') +
        '\n\nSubtotal ' + money(t.subtotal) + (t.gstRegistered ? ' · GST ' + money(t.gst) : '') + ' · Total ' + money(t.total) +
        '\n\nOne invoice number for all these days. The days cannot be put in another invoice (unless you cancel this one). ' +
        'The subcontractor sees the same invoice on their link. A copy is e-mailed to the subcontractor and to the office.' });
    if (!ok) return;
    btn.disabled = true;
    var r = await db.rpc('sub_admin_create_invoice', { p_day_ids: ids, p_expected_total: t.total });
    if (r.error) {
      btn.disabled = false;
      toast(r.error.message === 'total_changed' ? 'A day was changed since you opened this page. The list was refreshed: check the new total and try again.'
        : (ERRORS[r.error.message] || ('The database refused the invoice: ' + r.error.message + '.')), true);
      return refresh();
    }
    daySel = [];
    var copy = await sendRecordCopy('record_worker', r.data.invoice_id);
    var office = await sendRecordCopy('record_admin', r.data.invoice_id);
    toast('Invoice ' + r.data.invoice_number + ' created: ' + r.data.days + ' day(s), ' + money(r.data.total) +
      '. Copy to the subcontractor: ' + copy + '. Copy to the office: ' + office + '.');
    await refresh();
  }
  // First copies of a new invoice (same path and rules as "Send copy" in a record).
  async function sendRecordCopy(kind, invoiceId) {
    try {
      var r = await db.functions.invoke('sub-invoice-submit', { body: { action: 'resend_email', kind: kind, id: invoiceId } });
      if (r.error || !r.data || !r.data.ok) return 'not sent (you can send it from the record)';
      return noticeLabel(r.data.email);
    } catch (e) { return 'not sent (you can send it from the record)'; }
  }
  function waitingBox() {
    var box = el('div', { style: 'margin-bottom:12px' });
    box.appendChild(el('b', { text: 'Days sent, waiting for an invoice (' + cache.waiting.length + ')' }));
    box.appendChild(dayBar); renderDayBar();
    if (!cache.waiting.length) { box.appendChild(el('div', { style: 'color:#999;font-size:13px', text: 'No days waiting.' })); return box; }
    var bySub = {};
    cache.waiting.forEach(function (d) { (bySub[d.subcontractor_id] = bySub[d.subcontractor_id] || []).push(d); });
    Object.keys(bySub).forEach(function (subId) {
      var list = bySub[subId];
      var card = el('div', { style: CARD }, [el('div', null, [el('b', { text: subName(subId) }), ' · ' + list.length + ' day(s) · ' +
        money(list.reduce(function (a, d) { return a + dayAmountCents(d); }, 0) / 100) + ' before GST'])]);
      list.forEach(function (d) {
        var cb = el('input', { type: 'checkbox', title: 'Select for the invoice', style: 'width:18px;height:18px;margin:2px 8px 0 0;flex:none' });
        cb.checked = daySel.indexOf(d.id) >= 0;
        cb.addEventListener('change', function () { toggleDay(d, cb); });
        var row = dayRow(d, null, true);
        row.insertBefore(el('div', { style: 'font-size:11px;color:#888', text: 'sent ' + SubShared.sydneyDateTime(d.sent_at) }), row.firstChild);
        card.appendChild(el('div', { style: 'display:flex;align-items:flex-start' }, [cb, el('div', { style: 'flex:1' }, [row])]));
      });
      box.appendChild(card);
    });
    return box;
  }

  var PAY_ERRORS = {
    total_changed: 'A record was changed since you opened this page. The list was refreshed: check the new total and try again.',
    bank_details_differ: 'These records were sent with different bank details. Pay them in separate payments.',
    mixed_subcontractors: 'One payment can only include records of one subcontractor.',
    invoice_not_payable: 'One of the records is no longer Pending/Approved. The list was refreshed.',
    paid_date_future: 'The payment date cannot be in the future.',
    payment_method_required: 'Choose the payment method.'
  };
  async function recordPayment(date, method, ref, sum, btn) {
    if (!date || !method) return toast('Payment date and method are required.', true);
    var recs = selected.map(invById);
    var ok = await SubShared.dialog({ title: 'Record payment of ' + money(sum) + '?', confirmText: 'Record payment',
      message: 'To: ' + subName(recs[0].subcontractor_id) + '\nRecords: ' + recs.map(function (i) { return i.invoice_number + ' (' + money(i.total) + ')'; }).join(', ') +
        '\nDate: ' + date + ' · Method: ' + method + (ref ? ' · Ref: ' + ref : '') + '\n\nAll of them will be marked as Paid.' });
    if (!ok) return;
    btn.disabled = true;
    var r = await db.rpc('sub_admin_record_payment', { p_invoice_ids: selected.slice(), p_paid_at: date, p_payment_method: method,
      p_payment_reference: ref, p_expected_total: sum });
    if (r.error) { btn.disabled = false; toast(PAY_ERRORS[r.error.message] || ERRORS[r.error.message] || ('The database refused the payment: ' + r.error.message + '.'), true); return refresh(); }
    if (r.data && r.data.ok === false) { toast(r.data.message || r.data.error, true); return refresh(); }
    selected = [];
    var notice = await sendNotice(r.data.payment_id);
    toast('Payment ' + r.data.payment_number + ' recorded: ' + r.data.invoice_count + ' record(s), ' + money(r.data.total) +
      '. Confirmation e-mail: ' + notice + '.');
    await refresh();
  }

  // "Pay this record" inside a record: selects it (a selection of another subcontractor is replaced)
  // and brings the payment bar into view.
  function payThis(inv) {
    var first = selected.length ? invById(selected[0]) : null;
    if (first && first.subcontractor_id !== inv.subcontractor_id) selected = [];
    if (selected.indexOf(inv.id) < 0) selected.push(inv.id);
    if (currentFilter !== 'all' && currentFilter !== inv.status) currentFilter = 'all';
    refresh().then(function () { payBar.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }

  // One confirmation e-mail per payment, sent by the Edge Function with the Admin's own session.
  async function sendNotice(paymentId) {
    try {
      var r = await db.functions.invoke('sub-invoice-submit', { body: { action: 'payment_notice', payment_id: paymentId } });
      if (r.error || !r.data || !r.data.ok) return 'not sent (you can resend it from the record)';
      return noticeLabel(r.data.email);
    } catch (e) { return 'not sent (you can resend it from the record)'; }
  }

  // Send / resend one e-mail (record copy to the worker, copy to the office, payment confirmation).
  // The database decides if it is allowed: already sent and "in progress" are refused; an outcome
  // that is unknown after the provider's 24 h duplicate protection needs a confirmation + reason.
  var SEND_ERRORS = {
    already_sent: 'This e-mail was already sent. It is not sent again.',
    in_progress: 'This e-mail is being sent right now. Wait a minute and refresh.',
    unknown_needs_confirmation: 'The result of the last attempt is unknown. Confirm and give a reason to send it again.',
    reason_required: 'Please write a reason (at least 3 characters).',
    payment_voided: 'This payment was undone. No confirmation e-mail is sent.',
    invoice_closed: 'This record is cancelled. No copy is sent.',
    forbidden: 'Your login is not an Admin login.'
  };
  async function emailSend(kind, id, what) {
    var st = await db.rpc('sub_admin_email_state', { p_kind: kind, p_id: id });
    if (st.error) return fail(st.error);
    var s = st.data, body = { action: 'resend_email', kind: kind, id: id };
    if (!s.can_resend) return toast(SEND_ERRORS[s.class === 'done' ? 'already_sent' : 'in_progress'], true);
    if (s.needs_confirmation) {
      var why = await askReason('', { title: 'Send ' + what + ' again?', confirmText: 'Send again', danger: true,
        message: 'The last attempt (' + SubShared.sydneyDateTime(s.last_attempt_at) + ') ended without a clear result, and it was more than 23 hours ago, ' +
          'so the e-mail service can no longer recognise a duplicate. It MAY already have been delivered.\n\n' +
          'Before sending again, check the e-mail service log or ask the recipient. Write what you checked.' });
      if (!why) return;
      body.confirm_unknown = true; body.reason = why;
    } else {
      var ok = await SubShared.dialog({ title: 'Send ' + what + '?', confirmText: 'Send', message:
        s.class === 'unknown' ? 'The last attempt has no clear result. Sending again now is safe: if it was already delivered, the e-mail service will not deliver it twice (protection valid for 24 h after the first attempt).'
          : 'It will be sent once.' });
      if (!ok) return;
    }
    try {
      var r = await db.functions.invoke('sub-invoice-submit', { body: body });
      var data = r.data;
      if (r.error && r.error.context && typeof r.error.context.json === 'function') data = await r.error.context.json().catch(function () { return null; });
      if (!data || !data.ok) { toast(SEND_ERRORS[data && data.error] || 'Not sent. Try again later.', true); return refresh(); }
      toast(what.charAt(0).toUpperCase() + what.slice(1) + ': ' + noticeLabel(data.email) + '.');
    } catch (e) { toast('Not sent (no answer from the server). The result is shown in the record.', true); }
    await refresh();
  }
  function emailLine(label, status, kind, id, what) {
    var line = el('div', { style: 'font-size:11px;color:#555;margin:2px 0', text: label + ': ' + noticeLabel(status) + ' ' });
    if (!noticeFinal(status)) line.appendChild(el('button', { style: BTN, text: '✉ Send ' + what, onclick: function () { emailSend(kind, id, what); } }));
    return line;
  }

  // ------------------------------------------------------------------ invoices
  function renderInvoices(box) {
    var filter = el('select', { style: INPUT }, ['all', 'pending', 'approved', 'paid', 'cancelled'].map(function (s) {
      return el('option', { value: s, text: s === 'all' ? 'All' : STATUS_LABEL[s] });
    }));
    filter.value = currentFilter;
    filter.onchange = function () { currentFilter = filter.value; refresh(); };
    var list = el('div');
    var head = el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px' }, [
      el('b', { text: 'Work records' }), filter,
      el('button', { style: BTN, text: '⬇ CSV (expenses)', onclick: function () { exportCsv(filter.value); } })
    ]);
    box.appendChild(alertsBox());
    box.appendChild(waitingBox());
    box.appendChild(head); box.appendChild(payBar); box.appendChild(list);
    renderPayBar();
    var rows = cache.invoices.filter(function (i) { return filter.value === 'all' || i.status === filter.value; });
    if (cache.invoices.length >= 200) list.appendChild(el('div', { style: 'color:#666;font-size:12px;margin-bottom:6px', text: 'Showing the latest 200 records. The CSV includes all of them.' }));
    if (!rows.length) list.appendChild(el('div', { style: 'color:#999;font-size:13px', text: 'No records.' }));
    rows.forEach(function (inv) { list.appendChild(invoiceCard(inv)); });
  }

  // Open alerts (e.g. bank details changed by a worker through the link). Values are masked.
  function alertsBox() {
    var box = el('div');
    cache.alerts.forEach(function (a) {
      var d = a.details || {}, o = d.old || {}, n = d.new || {};
      box.appendChild(el('div', { style: 'background:#fff0f0;border:1px solid #fca5a5;border-radius:8px;padding:8px;margin-bottom:8px;font-size:12px' }, [
        el('b', { text: '⚠ Bank details changed by ' + subName(a.subcontractor_id) }),
        el('div', { text: SubShared.sydneyDateTime(a.created_at) + ' · before: ' + [o.account_name, 'BSB ' + o.bsb, 'Acc ' + o.account_number].join(' ') +
          ' · after: ' + [n.account_name, 'BSB ' + n.bsb, 'Acc ' + n.account_number].join(' ') + ' · admin e-mail: ' + (a.email_status || 'not sent yet') + ' · warning to worker (previous e-mail): ' + (a.worker_email_status || 'not sent yet') +
          ' · delivery: ' + a.delivery_state + ' (attempts ' + a.attempts + ')' +
          (a.gave_up_reason === 'retry_window_closed' ? ' · automatic e-mail retries stopped after 23 h (to avoid duplicates): contact the subcontractor directly' :
           a.gave_up_reason === 'max_attempts' ? ' · e-mail retries stopped after the maximum attempts: contact the subcontractor directly' : '') +
          (d.email_changed_in_same_save ? ' · ⚠ e-mail was changed in the same update' : '') }),
        el('div', { text: 'Payments to this subcontractor are BLOCKED until this alert is acknowledged. If the change was not expected, revoke the link and confirm with the subcontractor first.' }),
        el('button', { style: BTN, text: 'Acknowledge', onclick: async function () {
          var r = await db.rpc('sub_admin_ack_notification', { p_id: a.id }); if (r.error) return fail(r.error);
          toast('Alert acknowledged (recorded in history).'); await refresh();
        } })
      ]));
    });
    return box;
  }

  function invoiceCard(inv) {
    var w = inv.worker_snapshot || {};
    var details = el('div', { style: 'display:none;margin-top:8px' });
    var pick = null;
    if (payable(inv)) {
      pick = el('input', { type: 'checkbox', title: 'Select for payment', style: 'width:18px;height:18px;margin:2px 8px 0 0;flex:none' });
      pick.checked = selected.indexOf(inv.id) >= 0;
      pick.addEventListener('click', function (e) { e.stopPropagation(); });
      pick.addEventListener('change', function () { toggleSelect(inv, pick); });
    }
    var pay = inv.payment_id ? payById(inv.payment_id) : null;
    var card = el('div', { style: CARD }, [
      el('div', { style: 'display:flex;justify-content:space-between;gap:8px;cursor:pointer', onclick: function () { toggle(details, inv); } }, [
        pick,
        el('div', { style: 'flex:1' }, [el('b', { text: inv.invoice_number }), ' · ', w.full_name || subName(inv.subcontractor_id),
          el('div', { style: 'font-size:11px;color:#888', text: SubShared.sydneyDate(inv.submitted_at) + ' · ABN ' + (w.abn || '-') + (inv.gst_registered ? ' · GST' : ' · no GST') })]),
        el('div', { style: 'text-align:right' }, [el('b', { text: money(inv.total) }), el('div', { style: 'font-size:11px', text: STATUS_LABEL[inv.status] + (pay ? ' · ' + pay.payment_number : '') })])
      ]),
      details
    ]);
    return card;
  }

  async function toggle(details, inv) {
    if (details.style.display === 'block') { details.style.display = 'none'; return; }
    details.textContent = 'Loading…'; details.style.display = 'block';
    // A cancelled invoice made in Admin shows its ORIGINAL lines (frozen at cancellation; its days were released).
    var r = inv.cancelled_lines ? { data: inv.cancelled_lines }
      : await db.from('sub_work_days').select('*').eq('invoice_id', inv.id).order('work_date').order('start_time');
    if (r.error) { details.textContent = 'Error loading days.'; return; }
    details.textContent = '';
    var w = inv.worker_snapshot || {};
    details.appendChild(el('div', { style: 'font-size:12px;color:#555;margin-bottom:6px', text:
      (w.address || '-') + ' · Email ' + (w.email || '-') + ' · Phone ' + (w.phone || '-') }));
    if (inv.cancelled_lines) details.appendChild(el('div', { style: 'font-size:12px;color:#b91c1c;margin-bottom:4px', text:
      'Original lines of this cancelled invoice (kept for the records). These days were released and can be in a new invoice.' }));
    var editable = !inv.cancelled_lines && (inv.status === 'pending' || inv.status === 'approved');
    r.data.forEach(function (d) { details.appendChild(dayRow(d, inv, editable)); });
    details.appendChild(el('div', { style: 'font-size:13px;margin:8px 0', text:
      'Labour ' + money(inv.labour_total) + ' · Travel ' + money(inv.travel_total) + ' · Subtotal ' + money(inv.subtotal) +
      ' · GST ' + money(inv.gst_amount) + ' · Total ' + money(inv.total) }));
    details.appendChild(el('button', { style: BTN, text: '🧾 View / Print PDF', onclick: function () {
      var p = inv.payment_id ? payById(inv.payment_id) : null;
      SubShared.openInvoice(Object.assign({}, inv, { worker: inv.worker_snapshot, company: inv.company_snapshot,
        payment_number: p ? p.payment_number : null, days: r.data,      // r.data = frozen lines when cancelled
        grouped: !!inv.grouped_by }));                                  // one line per day only for invoices made in Admin
    } }));
    if (inv.payment_id) details.appendChild(paymentBox(inv));
    details.appendChild(el('div', { style: 'font-size:11px;color:#555;margin:4px 0', text:
      'Declaration (' + (inv.declaration_version || '-') + ') accepted ' + SubShared.sydneyDateTime(inv.declaration_accepted_at) + ': ' + (inv.declaration_text || '') }));
    if (inv.admin_notes) details.appendChild(el('div', { style: 'font-size:12px;color:#555', text: 'Notes: ' + inv.admin_notes }));
    if (inv.status !== 'cancelled') {
      details.appendChild(emailLine('Copy to the subcontractor', inv.worker_email_status, 'record_worker', inv.id, 'copy to the subcontractor'));
      details.appendChild(emailLine('Copy to the office', inv.admin_email_status, 'record_admin', inv.id, 'copy to the office'));
    }
    details.appendChild(statusActions(inv));
    var h = await db.rpc('sub_admin_invoice_history', { p_invoice_id: inv.id });
    if (!h.error && h.data && h.data.length) details.appendChild(historyList(h.data));
  }

  // History of one record: when, who, what (before → after) and why.
  var ACTION_LABEL = { submitted: 'Sent by the subcontractor', invoice_created: 'Invoice created in Admin from sent days',
    days_released: 'Cancelled: days released for a new invoice',
    day_adjusted: 'Day corrected', status_changed: 'Status changed',
    bank_viewed: 'Bank details viewed', payment_blocked: 'Payment blocked', email_send_started: 'E-mail sent again', email_result: 'E-mail result' };
  var FIELD_LABEL = { role: 'job', start_time: 'start', finish_time: 'finish', break_minutes: 'unpaid break (min)',
    travel_minutes: 'travel (min)', hourly_rate: 'hourly rate $/h', travel_rate: 'travel rate $/h', work_hours: 'hours', travel_hours: 'travel hours', labour_amount: 'labour $', travel_amount: 'travel $',
    record_total: 'record total $', status: 'status', paid_at: 'paid on', payment_method: 'method',
    payment_reference: 'reference', payment_number: 'payment', kind: 'e-mail', attempt: 'attempt' };
  function histValue(k, v) { return v == null ? '—' : String(v).slice(0, /_time$/.test(k) ? 5 : 45); }
  function historyList(rows) {
    var box = el('div', { style: 'font-size:11px;color:#444;margin-top:8px;border-top:1px solid #eee;padding-top:6px' }, [el('b', { text: 'History' })]);
    rows.forEach(function (a) {
      var o = a.old || {}, n = a.new || {}, changes = [];
      Object.keys(FIELD_LABEL).forEach(function (k) {
        if (!(k in n) && !(k in o)) return;
        var ov = o[k], nv = n[k];
        if (JSON.stringify(ov) === JSON.stringify(nv)) return;
        changes.push(FIELD_LABEL[k] + ': ' + histValue(k, ov) + ' → ' + histValue(k, nv));
      });
      if (n.payment_voided) changes.push('payment ' + n.payment_voided + ' undone');
      if (a.action === 'day_adjusted' && n.work_date) changes.unshift('day ' + n.work_date);
      box.appendChild(el('div', { style: 'padding:3px 0;border-bottom:1px dotted #eee' }, [
        el('span', { style: 'color:#888', text: SubShared.sydneyDateTime(a.at) + ' · ' }),
        el('b', { text: ACTION_LABEL[a.action] || a.action }),
        ' · by ' + (a.by || (a.by_admin ? 'Admin' : 'subcontractor / system')),
        changes.length ? el('div', { text: changes.join(' · ') }) : null,
        a.reason ? el('div', { style: 'color:#555', text: 'Reason: ' + a.reason }) : null
      ]));
    });
    return box;
  }

  // Payment of this record: number, records in the same payment, confirmation e-mail, void.
  function paymentBox(inv) {
    var p = payById(inv.payment_id);
    var box = el('div', { style: 'font-size:12px;background:#f0f7f0;border-radius:6px;padding:6px;margin:6px 0' });
    if (!p) { box.textContent = 'Paid ' + inv.paid_at; return box; }
    var same = cache.invoices.filter(function (i) { return i.payment_id === p.id; }).map(function (i) { return i.invoice_number; });
    box.appendChild(el('div', { style: 'color:#2a7a2a', text: 'Paid ' + p.paid_at + ' · ' + p.payment_method + (p.payment_reference ? ' · ref. ' + p.payment_reference : '') +
      ' · payment ' + p.payment_number + ' · ' + p.invoice_count + ' record(s), total ' + money(p.total) + (same.length > 1 ? ' (' + same.join(', ') + ')' : '') }));
    box.appendChild(el('div', { text: 'Confirmation e-mail to the subcontractor: ' + noticeLabel(p.notice_status) }));
    if (!noticeFinal(p.notice_status) && !p.voided_at) {
      box.appendChild(el('button', { style: BTN, text: 'Send confirmation e-mail', onclick: function () {
        emailSend('payment_notice', p.id, 'confirmation e-mail');
      } }));
    }
    box.appendChild(el('button', { style: BTN, text: 'Undo payment ' + p.payment_number + (p.invoice_count > 1 ? ' (all ' + p.invoice_count + ' records)' : ''), onclick: async function () {
      var note = await askReason('', { title: 'Undo payment ' + p.payment_number + '?', confirmText: 'Undo payment', danger: true,
        message: p.invoice_count + ' record(s), ' + money(p.total) + '. Each record goes back to the status it had before (Pending or Approved). The payment stays in the history as undone.' });
      if (!note) return;
      var r = await db.rpc('sub_admin_void_payment', { p_payment_id: p.id, p_reason: note });
      if (r.error) return fail(r.error);
      toast('Payment ' + p.payment_number + ' undone. Each record is back to its previous status (Pending or Approved).'); await refresh();
    } }));
    return box;
  }

  // Bank details are fetched only when an admin clicks, and every view is recorded in sub_audit.
  function bankReveal(fetcher, label) {
    var box = el('div', { style: 'font-size:12px;margin:4px 0' });
    var btn = el('button', { style: BTN, text: '🔒 ' + label + ' (logged)', onclick: async function () {
      var r = await fetcher();
      if (r.error) return fail(r.error);
      box.textContent = '';
      box.appendChild(el('div', { style: 'background:#fff7e0;padding:6px;border-radius:6px', text: r.data
        ? 'Account holder: ' + r.data.account_name + ' · BSB ' + r.data.bsb + ' · Account ' + r.data.account_number
        : 'No bank details on file.' }));
    } });
    box.appendChild(btn);
    return box;
  }
  // Asks for a reason in an in-page dialog. Resolves to the reason, or null if the Admin goes back.
  async function askReason(what, opts) {
    opts = opts || {};
    var r = await SubShared.dialog({ title: opts.title || 'Reason required', message: opts.message || ('Reason for ' + what + '. It is saved in the history.'),
      confirmText: opts.confirmText || 'Confirm', danger: !!opts.danger,
      reason: { label: 'Reason (required)', placeholder: opts.placeholder || '', minLength: 3 } });
    return r ? r.value : null;
  }


  // inv null = a sent day waiting for an invoice. Days of invoices made in Admin (and waiting days) show
  // the day total first; days of older records keep their original line.
  function dayRow(d, inv, editable) {
    var calc = d.work_hours + 'h × ' + money(d.hourly_rate) + ' = ' + money(d.labour_amount) +
      ' · travel ' + d.travel_minutes + 'm × ' + money(d.travel_rate) + '/h = ' + money(d.travel_amount) + (d.admin_adjusted ? ' · ✎ adjusted' : '');
    var row = el('div', { style: 'border-top:1px solid #f0f0f0;padding:6px 0;font-size:12px' }, [
      !inv || inv.grouped_by
        ? el('div', null, [el('b', { text: d.work_date + ' · ' + (d.role || '?') + ' · day total ' + money(SubShared.dayAmount(d)) }),
            el('span', { style: 'color:#666', text: ' — ' + String(d.start_time).slice(0, 5) + '–' + String(d.finish_time).slice(0, 5) +
              ' (break ' + d.break_minutes + 'm) · ' + calc })])
        : el('div', { text: d.work_date + ' · ' + (d.role || '?') + ' · ' + d.start_time.slice(0, 5) + '–' + d.finish_time.slice(0, 5) +
            ' (break ' + d.break_minutes + 'm) · ' + calc }),
      d.notes ? el('div', { style: 'color:#888', text: d.notes }) : null
    ]);
    if (editable) row.appendChild(el('button', { style: BTN, text: '✎ Correct hours / job / rate', onclick: function () { adjustForm(row, d, inv); } }));
    return row;
  }

  function adjustForm(row, d, inv) {
    if (row.querySelector('form')) return;
    var job = el('input', { style: INPUT, maxlength: '60', value: d.role || '', title: 'Job / role' });
    var st = el('input', { type: 'time', style: INPUT, value: d.start_time.slice(0, 5), title: 'Start' });
    var fi = el('input', { type: 'time', style: INPUT, value: d.finish_time.slice(0, 5), title: 'Finish' });
    var br = el('select', { style: INPUT, title: 'Unpaid break' }); SubShared.fillDuration(br, 120, d.break_minutes);
    var tr = el('select', { style: INPUT, title: 'Travel time' }); SubShared.fillDuration(tr, 240, d.travel_minutes);
    var rate = el('input', { type: 'number', min: '1', max: '999.99', step: '0.01', style: INPUT, value: Number(d.hourly_rate).toFixed(2), title: 'Hourly rate for this job' });
    var reason = el('input', { style: INPUT + ';width:100%', placeholder: 'Reason for the correction (required, saved in history)', maxlength: '500' });
    var lab = function (t, f) { return el('label', { style: 'display:inline-block;margin:2px 6px 2px 0;font-size:11px;color:#555' }, [t, el('br'), f]); };
    var form = el('form', { style: 'margin-top:6px;background:#fafafa;padding:6px;border-radius:6px' }, [
      lab('Job / role', job), lab('Start', st), lab('Finish', fi), lab('Unpaid break', br), lab('Travel time', tr), lab('Hourly rate ($/h)', rate), reason,
      el('div', { style: 'font-size:11px;color:#666;margin:2px 0', text: 'This changes the rate for this job only. Travel is recalculated at half the hourly rate. The reason is saved in history.' }),
      el('button', { type: 'submit', style: BTN_G, text: 'Save correction' }),
      el('button', { type: 'button', style: BTN, text: 'Close', onclick: function () { form.remove(); } })
    ]);
    form.onsubmit = async function (ev) {
      ev.preventDefault();
      if (reason.value.trim().length < 3) { reason.focus(); return toast(ERRORS.reason_required); }
      if (!job.value.trim()) { job.focus(); return toast(ERRORS.role_required); }
      var rateValue = Math.round(Number(rate.value) * 100) / 100;   // the database stores cents
      if (!(rateValue > 0 && rateValue < 1000)) { rate.focus(); return toast(ERRORS.rate_invalid); }
      var r = await db.rpc('sub_admin_adjust_day_rate', { p_day_id: d.id, p_role: job.value.trim(), p_start: st.value, p_finish: fi.value,
        p_break_minutes: Number(br.value || 0), p_travel_minutes: Number(tr.value || 0), p_hourly_rate: rateValue, p_reason: reason.value.trim() });
      if (r.error) {
        fail(r.error);
        // The day's invoice link changed under us: the form shows stale data, so reload the list.
        if (r.error.message === 'day_changed') await refresh();
        return;
      }
      toast(r.data && r.data.status === 'awaiting_invoice'
        ? 'Correction saved. This day is not in an invoice yet; the new amount is used when you create the invoice.'
        : r.data && r.data.amounts_changed
        ? 'Correction saved. Record total: ' + money(r.data.total_before) + ' → ' + money(r.data.total_after) + '. Status unchanged. The worker\'s link already shows the corrected record; copies already e-mailed are not sent again.'
        : 'Correction saved (job/role only). Total unchanged. Status unchanged.');
      await refresh();
    };
    row.appendChild(form);
  }

  var PAY_METHODS = ['Bank transfer', 'Cash', 'Other'];

  function statusActions(inv) {
    var box = el('div', { style: 'margin-top:8px' });
    // Pay with the bank details SAVED WITH THIS RECORD at submission (not the current profile). Viewing is logged.
    box.appendChild(bankReveal(function () { return db.rpc('sub_admin_get_invoice_bank', { p_invoice_id: inv.id }); },
      'Bank details saved with this record (use these to pay)'));
    async function set(status, extra) {
      var r;
      try { r = await db.rpc('sub_admin_set_status', Object.assign({ p_invoice_id: inv.id, p_status: status }, extra || {})); }
      catch (e) { return toast('Could not reach the database. Check the connection and try again.', true); }
      if (r.error) return fail(r.error);
      // Refusals that are recorded in history come back as { ok:false, error, message } (no exception).
      if (r.data && r.data.ok === false) { toast(r.data.message || r.data.error, true); await refresh(); return; }
      toast(inv.invoice_number + ': ' + STATUS_LABEL[status] + (status === 'cancelled' ? ' (kept in the records, reason saved in the history)' : '') + '.');
      await refresh();
    }
    if (inv.status === 'pending') {
      box.appendChild(el('button', { style: BTN_G, text: 'Approve', onclick: function () { set('approved'); } }));
    }
    var blocked = cache.alerts.some(function (a) { return a.subcontractor_id === inv.subcontractor_id; });
    if (blocked && (inv.status === 'pending' || inv.status === 'approved')) {
      box.appendChild(el('div', { style: 'background:#fff0f0;border:1px solid #fca5a5;border-radius:6px;padding:6px;font-size:12px;margin:4px 0',
        text: '⚠ Payment blocked: this subcontractor has an unacknowledged bank-change alert (see the top of Records).' }));
    }
    if (inv.status === 'pending' || inv.status === 'approved') {
      box.appendChild(el('button', { style: BTN_G, text: '💳 Pay this record', onclick: function () { payThis(inv); } }));
      box.appendChild(el('span', { style: 'font-size:11px;color:#555', text:
        ' To pay several records of this subcontractor together, tick their boxes in the list; the total is added up in the payment bar.' }));
    }
    if (inv.status === 'approved') {
      box.appendChild(el('button', { style: BTN, text: 'Back to pending', onclick: function () { set('pending'); } }));
    }
    if (inv.status === 'pending' || inv.status === 'approved') {
      box.appendChild(el('button', { style: BTN + ';color:#b91c1c', text: 'Cancel record', onclick: async function () {
        var btn = this;
        var note = await askReason('', { title: 'Cancel ' + inv.invoice_number + '?', confirmText: 'Cancel record', danger: true,
          placeholder: 'e.g. Duplicate of another record',
          message: subName(inv.subcontractor_id) + ' · ' + money(inv.total) + ' · ' + STATUS_LABEL[inv.status] +
            (inv.grouped_by
              ? '\n\nThe invoice is NOT deleted: it is kept with its number, original lines and history, marked Cancelled. ' +
                'Its days go back to "waiting for an invoice" so you can put them in a NEW invoice (new number). This number is never reused.'
              : '\n\nThe record is NOT deleted: it is kept with its days and history, marked Cancelled, and can no longer be corrected or paid.') });
        if (!note) return;   // went back: nothing was changed
        btn.disabled = true;
        await set('cancelled', { p_note: note });
        btn.disabled = false;
      } }));
    }
    if (inv.status === 'paid') {
      box.appendChild(el('div', { style: 'font-size:11px;color:#555;margin:4px 0', text: 'To cancel a paid record, undo its payment first.' }));
    }
    if (inv.status === 'cancelled') {
      box.appendChild(el('div', { style: 'font-size:12px;color:#b91c1c;margin:4px 0', text:
        'Cancelled — kept for the records (not deleted). See the reason in the history below.' }));
    }
    return box;
  }

  // The screen only loads recent records; a report must cover all of them.
  async function fetchAll(build) {
    var rows = [], size = 1000;
    for (var from = 0; ; from += size) {
      var r = await build().range(from, from + size - 1);
      if (r.error) throw r.error;
      rows = rows.concat(r.data);
      if (r.data.length < size) return rows;
    }
  }
  async function exportCsv(filter) {
    var rows, payments;
    try {
      rows = await fetchAll(function () {
        var q = db.from('sub_invoices').select('*').order('submitted_at', { ascending: false }).order('id');
        return filter === 'all' ? q : q.eq('status', filter);
      });
      payments = await fetchAll(function () { return db.from('sub_payments').select('id,payment_number').order('id'); });
    } catch (e) { return toast('Could not load all the records, so no CSV was created. Try again.', true); }
    function payNumber(id) { var p = payments.find(function (x) { return x.id === id; }); return p ? p.payment_number : ''; }
    var head = ['invoice_number', 'worker', 'abn', 'gst_registered', 'submitted_at', 'status', 'paid_at', 'payment_number', 'payment_method',
      'payment_reference', 'expense_category', 'labour_total', 'travel_total', 'subtotal', 'gst_amount', 'total'];
    function q(v) { var s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }
    var lines = [head.join(',')].concat(rows.map(function (i) {
      var w = i.worker_snapshot || {};
      return [i.invoice_number, w.full_name, w.abn, i.gst_registered, i.submitted_at, i.status, i.paid_at, payNumber(i.payment_id), i.payment_method,
        i.payment_reference, i.expense_category, i.labour_total, i.travel_total, i.subtotal, i.gst_amount, i.total].map(q).join(',');
    }));
    var a = el('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: 'subcontractor-records-' + filter + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ------------------------------------------------------------------ subcontractors + links
  // A link expires 7 days after its last activity (saving details, a day or sending a record);
  // only opening the page does not count. The database enforces it; this is just the label.
  var LINK_IDLE_DAYS = 7;
  function linkExpiry(link) { return new Date(new Date(link.last_activity_at || link.created_at).getTime() + LINK_IDLE_DAYS * 864e5); }
  function linkExpired(link) { return !!link && linkExpiry(link) <= new Date(); }
  function linkStatus(link) {
    if (!link) return 'none';
    var last = 'last activity ' + SubShared.sydneyDate(link.last_activity_at || link.created_at);
    if (linkExpired(link)) return 'EXPIRED (no activity for ' + LINK_IDLE_DAYS + ' days, ' + last + ') — create a new link';
    return 'active, ' + last + ', expires ' + SubShared.sydneyDate(linkExpiry(link)) + ' if not used';
  }
  function renderSubs(box) {
    box.appendChild(el('b', { text: 'Subcontractors' }));
    var name = el('input', { style: INPUT, placeholder: 'Name (internal label)' });
    var rate = el('input', { type: 'number', min: '1', max: '999', step: '0.01', style: INPUT + ';width:110px', placeholder: 'Hourly rate $' });
    var created = el('div');
    box.appendChild(el('div', { style: 'font-size:11px;color:#888', text:
      'The hourly rate is set here and never shown to the worker. Travel time is paid at half this rate.' }));
    box.appendChild(el('div', { style: 'margin:6px 0' }, [name, rate, el('button', { style: BTN_G, text: '+ Add and create link', onclick: async function () {
      var v = Number(rate.value);
      if (!name.value.trim() || !(v > 0 && v < 1000)) return toast('Name and a valid hourly rate are required.');
      var r = await db.rpc('sub_admin_create_subcontractor', { p_display_name: name.value.trim(), p_hourly_rate: v });
      if (r.error) return fail(r.error);
      var nm = name.value.trim(); name.value = ''; rate.value = '';
      await newLink({ id: r.data, display_name: nm }, created);
    } })]));
    box.appendChild(created);
    cache.subs.forEach(function (s) {
      var link = cache.links.find(function (l) { return l.subcontractor_id === s.id; });
      var lvl = el('input', { type: 'number', min: '1', max: '999', step: '0.01', style: INPUT + ';width:90px', value: s.hourly_rate, title: 'Hourly rate $' });
      lvl.onchange = async function () {
        var v = Number(lvl.value);
        if (!(v > 0 && v < 1000)) { lvl.value = s.hourly_rate; return toast('Invalid rate.'); }
        var reason = await askReason('changing the hourly rate of ' + s.display_name + ' to ' + money(v) + '/h (applies to new days only)');
        if (!reason) { lvl.value = s.hourly_rate; return; }
        var r = await db.rpc('sub_admin_update_subcontractor', { p_id: s.id, p_display_name: s.display_name, p_hourly_rate: v, p_active: s.active, p_reason: reason });
        if (r.error) { lvl.value = s.hourly_rate; return fail(r.error); } toast('Rate updated (applies to new days only).'); await refresh();
      };
      var out = el('div');
      box.appendChild(el('div', { style: CARD }, [
        el('div', null, [el('b', { text: s.display_name }), s.full_name ? ' · ' + s.full_name : '', ' · ', s.active ? 'active' : 'INACTIVE']),
        el('div', { style: 'font-size:11px;color:#888', text: (s.address || 'no address') + ' · ABN ' + (s.abn || '-') + (s.gst_registered ? ' · GST' : ' · no GST') +
          ' · ' + (s.email || 'no email') + ' · ' + (s.phone || 'no phone') +
          ' · link: ' + linkStatus(link) }),
        el('div', null, ['Rate $', lvl, '/h ',
          el('button', { style: BTN_G, text: !link ? 'Create link' : linkExpired(link) ? 'New link (link expired)' : 'New link (replaces old)', onclick: function () { newLink(s, out); } }),
          link ? el('button', { style: BTN + ';color:#b91c1c', text: 'Revoke link', onclick: async function () {
            if (!(await SubShared.dialog({ title: 'Revoke the link of ' + s.display_name + '?', message: 'It stops working immediately. Sent records are not affected.',
              confirmText: 'Revoke link', danger: true }))) return;
            var r = await db.rpc('sub_admin_revoke_links', { p_subcontractor_id: s.id }); if (r.error) return fail(r.error);
            toast('Link revoked.'); await refresh();
          } }) : null,
          el('button', { style: BTN, text: s.active ? 'Deactivate' : 'Activate', onclick: async function () {
            var reason = await askReason((s.active ? 'deactivating ' : 'activating ') + s.display_name); if (!reason) return;
            var r = await db.rpc('sub_admin_update_subcontractor', { p_id: s.id, p_display_name: s.display_name, p_hourly_rate: s.hourly_rate, p_active: !s.active, p_reason: reason });
            if (r.error) return fail(r.error); await refresh();
          } }),
          el('button', { style: BTN, text: 'Edit details', onclick: function () { profileForm(s, out); } }),
          el('button', { style: BTN, text: 'Bank details', onclick: function () { bankPanel(s, out); } }),
          el('button', { style: BTN, text: 'History', onclick: function () { historyPanel(s, out); } })
        ]),
        out
      ]));
    });
  }

  // Admin edit of the worker profile: reason required, changes recorded in sub_audit.
  function profileForm(s, out) {
    out.textContent = '';
    function inp(v, ph) { return el('input', { style: INPUT + ';width:100%', value: v || '', placeholder: ph }); }
    var f = { name: inp(s.full_name, 'Full name *'), address: inp(s.address, 'Address *'), email: inp(s.email, 'Email'),
      phone: inp(s.phone, 'Phone'), abn: inp(s.abn, 'ABN *'), reason: inp('', 'Reason for the change (required)') };
    var gst = el('input', { type: 'checkbox' }); gst.checked = !!s.gst_registered;
    out.appendChild(el('form', { style: 'background:#fafafa;padding:8px;border-radius:6px;margin-top:6px', onsubmit: async function (ev) {
      ev.preventDefault();
      var r = await db.rpc('sub_admin_update_profile', { p_id: s.id, p_full_name: f.name.value, p_address: f.address.value,
        p_email: f.email.value, p_phone: f.phone.value, p_abn: f.abn.value, p_gst_registered: gst.checked, p_reason: f.reason.value });
      if (r.error) return fail(r.error);
      toast(r.data && r.data.changed ? 'Details updated and recorded in history.' : 'No changes.'); await refresh();
    } }, [f.name, f.address, f.email, f.phone, f.abn, el('label', { style: 'font-size:12px' }, [gst, ' Registered for GST']), f.reason,
      el('button', { type: 'submit', style: BTN_G, text: 'Save details' })]));
  }

  // Bank details: shown only after an explicit (logged) request; edits need a reason.
  function bankPanel(s, out) {
    out.textContent = '';
    out.appendChild(bankReveal(function () { return db.rpc('sub_admin_get_bank', { p_subcontractor_id: s.id }); }, 'Show current bank details'));
    var name = el('input', { style: INPUT, placeholder: 'Account holder *' });
    var bsb = el('input', { style: INPUT, placeholder: 'BSB *', inputmode: 'numeric' });
    var acc = el('input', { style: INPUT, placeholder: 'Account number *', inputmode: 'numeric' });
    var reason = el('input', { style: INPUT + ';width:100%', placeholder: 'Reason for the change (required)' });
    out.appendChild(el('form', { style: 'background:#fafafa;padding:8px;border-radius:6px;margin-top:6px', onsubmit: async function (ev) {
      ev.preventDefault();
      var r = await db.rpc('sub_admin_update_bank', { p_id: s.id, p_account_name: name.value, p_bsb: bsb.value, p_account_number: acc.value, p_reason: reason.value });
      if (r.error) return fail(r.error);
      name.value = bsb.value = acc.value = reason.value = '';
      toast(r.data && r.data.changed ? 'Bank details updated and recorded in history.' : 'No changes.');
    } }, [el('div', { style: 'font-size:11px;color:#888', text: 'Replace bank details (only if the subcontractor asked for it):' }), name, bsb, acc, reason,
      el('button', { type: 'submit', style: BTN_G, text: 'Save bank details' })]));
  }

  // History for one subcontractor. Bank values in the log are masked (•••123).
  async function historyPanel(s, out) {
    out.textContent = 'Loading…';
    var r = await db.from('sub_audit').select('at,actor,action,old_data,new_data,reason').eq('subcontractor_id', s.id).order('at', { ascending: false }).limit(100);
    if (r.error) { out.textContent = 'Error loading history.'; return; }
    out.textContent = '';
    if (!r.data.length) out.appendChild(el('div', { style: 'font-size:12px;color:#999', text: 'No history.' }));
    r.data.forEach(function (a) {
      var who = a.actor ? 'admin ' + String(a.actor).slice(0, 8) : 'worker/system';
      var change = a.new_data && a.action !== 'day_adjusted' ? ' · ' + JSON.stringify(a.old_data || {}) + ' → ' + JSON.stringify(a.new_data) : '';
      out.appendChild(el('div', { style: 'font-size:11px;color:#555;border-top:1px solid #f0f0f0;padding:3px 0', text:
        SubShared.sydneyDateTime(a.at) + ' · ' + a.action + ' (' + who + ')' + (a.reason ? ' · reason: ' + a.reason : '') + change }));
    });
  }

  async function newLink(s, out) {
    var bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
    var token = b64url(bytes);                       // 43 chars, 256 bits
    var hash = await sha256hex(token);               // only the hash is stored
    var r = await db.rpc('sub_admin_create_link', { p_subcontractor_id: s.id, p_token_hash: hash });
    if (r.error) return fail(r.error);
    var url = portalUrl + '#t=' + token;
    out.textContent = '';
    var inp = el('input', { style: INPUT + ';width:100%', readonly: 'readonly', value: url });
    out.appendChild(el('div', { style: 'background:#fff7e0;padding:8px;border-radius:6px;margin-top:6px;font-size:12px' }, [
      el('div', { text: 'Copy this link now and send it only to ' + s.display_name + '. It will not be shown again. Any older link stopped working.' }),
      inp,
      el('button', { style: BTN_G, text: 'Copy', onclick: function () {
        inp.select();
        var manual = function () { toast('Could not copy automatically. The link is selected: copy it by hand.', true); };
        if (!navigator.clipboard) return manual();
        navigator.clipboard.writeText(url).then(function () { toast('Copied.'); }, manual);
      } })
    ]));
    token = null;
    // refresh link status without wiping the one-time link box
    var l = await db.from('sub_links').select('id,subcontractor_id,created_at,expires_at,revoked_at,last_used_at,last_activity_at').is('revoked_at', null);
    if (!l.error) cache.links = l.data;
  }

  // ------------------------------------------------------------------ main
  async function refresh() {
    if (!root) return;
    root.textContent = 'Loading…';
    try { await loadAll(); } catch (e) { root.textContent = 'Could not load subcontractor data: ' + ((e && e.message) || 'error'); return; }
    root.textContent = '';
    var tabs = ['Records', 'Subcontractors'];
    var current = root.dataset.view || 'Records';
    var nav = el('div', { style: 'margin-bottom:10px' }, tabs.map(function (t) {
      return el('button', { style: t === current ? BTN_G : BTN, text: t, onclick: function () { root.dataset.view = t; refresh(); } });
    }).concat([el('button', { style: BTN, text: '🔄', onclick: refresh })]));
    var body = el('div');
    root.appendChild(nav); root.appendChild(body);
    if (current === 'Records') renderInvoices(body);
    else renderSubs(body);
  }

  window.SubAdmin = {
    init: function (client, element, opts) {
      db = client; root = element;
      portalUrl = (opts && opts.portalUrl) || new URL('subcontractor.html', location.href).href.split('#')[0];
      return refresh();
    },
    refresh: refresh
  };
})();
