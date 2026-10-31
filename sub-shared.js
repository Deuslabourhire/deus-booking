// Shared by subcontractor.html (worker) and subcontractor-admin.js (Admin/CRM):
//   SubShared.fillDuration(select, maxMinutes, value)  — duration list in 10-minute steps
//   SubShared.openInvoice(data)                         — on-screen invoice with Print / Save as PDF
// Invoices made in Admin from sent days (data.grouped) show ONE line per day (date, work, time,
// hours, the day's amount including travel) and the totals. Older records keep their original
// layout (days + ONE travel-time line). Never rates or bank details. All text is set with textContent.
(function () {
  'use strict';

  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) e.style.cssText = style;
    if (text != null) e.textContent = text;
    return e;
  }
  function money(n) { return '$' + Number(n || 0).toFixed(2); }
  // Amount of one day: work + travel (lists from the database also carry it as "amount").
  function dayAmount(d) { return d.amount != null ? Number(d.amount) : Number(d.labour_amount || 0) + Number(d.travel_amount || 0); }
  function label(min) {
    if (!min) return 'None';
    var h = Math.floor(min / 60), m = min % 60;
    return (h ? h + ' h' : '') + (h && m ? ' ' : '') + (m ? m + ' min' : '');
  }

  // 0 to maxMinutes in 10-minute steps (the database enforces the same rule). A value saved
  // earlier outside the list is kept as an extra option, so an old day can be saved unchanged.
  function fillDuration(select, maxMinutes, value) {
    var v = Number(value || 0);
    select.textContent = '';
    for (var m = 0; m <= maxMinutes; m += 10) select.appendChild(new Option(label(m), String(m)));
    if (v % 10 !== 0 || v > maxMinutes) select.appendChild(new Option(label(v), String(v)));
    select.value = String(v);
  }

  var STYLE_ID = 'sub-invoice-print-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      '#subInvoiceView{position:fixed;inset:0;background:rgba(0,0,0,.45);overflow:auto;z-index:9999;padding:16px}' +
      '#subInvoiceView .siv-sheet{background:#fff;color:#111;max-width:760px;margin:0 auto;padding:28px;border-radius:8px;font-family:Arial,sans-serif;font-size:13px}' +
      '#subInvoiceView table{border-collapse:collapse;width:100%}' +
      '#subInvoiceView th,#subInvoiceView td{padding:6px 4px;border-bottom:1px solid #e5e5e5;text-align:left}' +
      '' +
      '#subInvoiceView .siv-bar{max-width:760px;margin:0 auto 10px;display:flex;gap:8px;justify-content:flex-end}' +
      '#subInvoiceView .siv-bar button{padding:10px 14px;border-radius:8px;border:none;font-size:14px;cursor:pointer}' +
      '@media print{body>*:not(#subInvoiceView){display:none!important}' +
      '#subInvoiceView{position:static;background:#fff;padding:0;overflow:visible}' +
      '#subInvoiceView .siv-bar{display:none}#subInvoiceView .siv-sheet{max-width:none;padding:0;border-radius:0}}';
    document.head.appendChild(s);
  }

  // data: { invoice_number, submitted_at, status, paid_at, payment_number, payment_method, payment_reference,
  //         worker{full_name,address,email,phone,abn,gst_registered}, company{name,abn,address},
  //         days[{work_date, role|job_type, start_time, finish_time, break_minutes, travel_minutes, work_hours, labour_amount, travel_amount, amount?}],
  //         labour_total, travel_total, subtotal, gst_amount, total, declaration_text, declaration_accepted_at,
  //         grouped (true = invoice made in Admin from sent days: one line per day) }
  function openInvoice(data) {
    ensureStyle();
    var old = document.getElementById('subInvoiceView'); if (old) old.remove();
    var w = data.worker || {}, c = data.company || {};
    var wrap = el('div'); wrap.id = 'subInvoiceView';
    var bar = el('div'); bar.className = 'siv-bar';
    var printBtn = el('button', 'background:#1a8a1a;color:#fff', 'Print / Save as PDF');
    printBtn.onclick = function () { window.print(); };
    var closeBtn = el('button', 'background:#eee;color:#111', 'Close');
    closeBtn.onclick = function () { wrap.remove(); };
    bar.appendChild(printBtn); bar.appendChild(closeBtn);
    var sheet = el('div'); sheet.className = 'siv-sheet';

    var head = el('div', 'display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px');
    var left = el('div');
    left.appendChild(el('div', 'font-size:22px;font-weight:bold', 'INVOICE'));
    left.appendChild(el('div', 'font-size:15px;margin-top:2px', data.invoice_number));
    left.appendChild(el('div', 'color:#666;margin-top:2px', 'Submitted ' + sydneyDate(data.submitted_at)));
    var st = el('div', 'text-align:right');
    var paid = data.status === 'paid';
    st.appendChild(el('div', 'display:inline-block;padding:4px 10px;border:2px solid ' + (paid ? '#1a8a1a;color:#1a8a1a' : '#b45309;color:#b45309') +
      ';font-weight:bold;border-radius:6px', String(data.status || '').toUpperCase()));
    if (paid) {
      st.appendChild(el('div', 'margin-top:4px', 'Paid ' + (data.paid_at || '') + (data.payment_method ? ' · ' + data.payment_method : '')));
      if (data.payment_number) st.appendChild(el('div', null, 'Payment ' + data.payment_number));
      if (data.payment_reference) st.appendChild(el('div', null, 'Ref. ' + data.payment_reference));
    }
    head.appendChild(left); head.appendChild(st); sheet.appendChild(head);

    var parties = el('div', 'display:flex;gap:24px;flex-wrap:wrap;margin-bottom:18px');
    function party(title, lines) {
      var b = el('div', 'flex:1;min-width:220px');
      b.appendChild(el('div', 'font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.5px', title));
      lines.filter(Boolean).forEach(function (t, i) { b.appendChild(el('div', i === 0 ? 'font-weight:bold' : null, t)); });
      return b;
    }
    parties.appendChild(party('From (subcontractor)', [w.full_name, w.abn ? 'ABN ' + w.abn : '',
      w.gst_registered ? 'Registered for GST' : 'Not registered for GST', w.address, w.email, w.phone]));
    parties.appendChild(party('To', [c.name, c.abn ? 'ABN ' + c.abn : '', c.address]));
    sheet.appendChild(parties);

    var t = el('table');
    var hr = el('tr');
    if (data.grouped) {
      [['Date'], ['Work'], ['Time'], ['Hours', 1], ['Amount', 1]].forEach(function (h) { hr.appendChild(el('th', h[1] ? 'text-align:right' : null, h[0])); });
      t.appendChild(hr);
      (data.days || []).forEach(function (d) {
        var tr = el('tr');
        tr.appendChild(el('td', null, d.work_date));
        var work = el('td', null, d.role || d.job_type || '');
        var extra = [];
        if (Number(d.break_minutes)) extra.push('unpaid break ' + label(Number(d.break_minutes)));
        if (Number(d.travel_minutes)) extra.push('incl. travel ' + label(Number(d.travel_minutes)));
        if (extra.length) work.appendChild(el('div', 'font-size:11px;color:#666', extra.join(' · ')));
        tr.appendChild(work);
        tr.appendChild(el('td', null, String(d.start_time).slice(0, 5) + '–' + String(d.finish_time).slice(0, 5)));
        tr.appendChild(el('td', 'text-align:right', Number(d.work_hours).toFixed(2) + ' h'));
        tr.appendChild(el('td', 'text-align:right', money(dayAmount(d))));
        t.appendChild(tr);
      });
    } else {
      // Older records keep their original layout.
      [['Date'], ['Role'], ['Time'], ['Unpaid break'], ['Hours', 1], ['Amount', 1]].forEach(function (h) { hr.appendChild(el('th', h[1] ? 'text-align:right' : null, h[0])); });
      t.appendChild(hr);
      var travelMin = 0;
      (data.days || []).forEach(function (d) {
        travelMin += Number(d.travel_minutes || 0);
        var tr = el('tr');
        tr.appendChild(el('td', null, d.work_date));
        tr.appendChild(el('td', null, d.role || d.job_type || ''));
        tr.appendChild(el('td', null, String(d.start_time).slice(0, 5) + '–' + String(d.finish_time).slice(0, 5)));
        tr.appendChild(el('td', null, label(Number(d.break_minutes || 0))));
        tr.appendChild(el('td', 'text-align:right', Number(d.work_hours).toFixed(2) + ' h'));
        tr.appendChild(el('td', 'text-align:right', money(d.labour_amount)));
        t.appendChild(tr);
      });
      if (Number(data.travel_total) > 0 || travelMin > 0) {
        var trv = el('tr');
        trv.appendChild(el('td', null, 'Travel time'));
        trv.appendChild(el('td')); trv.appendChild(el('td')); trv.appendChild(el('td'));
        trv.appendChild(el('td', 'text-align:right', label(travelMin)));
        trv.appendChild(el('td', 'text-align:right', money(data.travel_total)));
        t.appendChild(trv);
      }
    }
    sheet.appendChild(t);

    var tot = el('div', 'margin-left:auto;max-width:280px;margin-top:12px');
    function line(k, v, strong) {
      var l = el('div', 'display:flex;justify-content:space-between;padding:3px 0' + (strong ? ';font-weight:bold;font-size:15px;border-top:2px solid #111;margin-top:4px;padding-top:6px' : ''));
      l.appendChild(el('span', null, k)); l.appendChild(el('span', null, v)); tot.appendChild(l);
    }
    line('Subtotal', money(data.subtotal));
    line('GST', money(data.gst_amount));
    line('Total', money(data.total), true);
    sheet.appendChild(tot);

    if (data.declaration_text) {
      sheet.appendChild(el('p', 'font-size:11px;color:#555;margin-top:20px;border-top:1px solid #eee;padding-top:8px',
        'Declaration accepted ' + sydneyDateTime(data.declaration_accepted_at) + ': ' + data.declaration_text));
    }
    sheet.appendChild(el('p', 'font-size:11px;color:#888', 'Payment record — not a tax invoice.'));

    wrap.appendChild(bar); wrap.appendChild(sheet);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
  }

  // In-page dialog instead of the browser's prompt()/confirm(): those can be silenced by the
  // browser ("prevent this page from creating additional dialogs"), and then a button seems
  // to do nothing. Resolves to { value } when confirmed, or null when cancelled.
  //   opts: { title, message, confirmText, cancelText, danger, reason: { label, placeholder, minLength } }
  function dialog(opts) {
    return new Promise(function (resolve) {
      var old = document.getElementById('subDialog'); if (old) old.remove();
      var wrap = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px');
      wrap.id = 'subDialog';
      var box = el('div', 'background:#fff;color:#111;border-radius:12px;max-width:460px;width:100%;padding:18px;font-family:Arial,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25)');
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
      box.appendChild(el('div', 'font-size:17px;font-weight:bold;margin-bottom:8px', opts.title || 'Confirm'));
      if (opts.message) box.appendChild(el('div', 'font-size:14px;line-height:1.4;white-space:pre-line;margin-bottom:10px', opts.message));
      var input = null, err = el('div', 'color:#b91c1c;font-size:13px;min-height:18px;margin-top:4px');
      if (opts.reason) {
        box.appendChild(el('label', 'display:block;font-size:13px;font-weight:bold;margin-bottom:4px', opts.reason.label || 'Reason (required)'));
        input = document.createElement('textarea');
        input.rows = 3; input.maxLength = 500; input.placeholder = opts.reason.placeholder || '';
        input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;border:1px solid #bbb;border-radius:8px;font-size:14px;font-family:inherit';
        box.appendChild(input); box.appendChild(err);
      }
      var buttons = el('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px');
      var cancel = el('button', 'padding:10px 14px;border-radius:8px;border:1px solid #ccc;background:#fff;font-size:14px;cursor:pointer', opts.cancelText || 'Go back');
      var ok = el('button', 'padding:10px 14px;border-radius:8px;border:none;color:#fff;font-size:14px;cursor:pointer;background:' + (opts.danger ? '#b91c1c' : '#1a8a1a'), opts.confirmText || 'Confirm');
      cancel.type = 'button'; ok.type = 'button';
      buttons.appendChild(cancel); buttons.appendChild(ok); box.appendChild(buttons);
      wrap.appendChild(box);
      function close(result) { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(result); }
      function submit() {
        if (input) {
          var v = input.value.trim(), min = opts.reason.minLength || 3;
          if (v.length < min) { err.textContent = 'Please write a reason (at least ' + min + ' characters).'; input.focus(); return; }
          return close({ value: v });
        }
        close({ value: true });
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        else if (e.key === 'Enter' && (!input || e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      }
      cancel.onclick = function () { close(null); };
      ok.onclick = submit;
      wrap.addEventListener('click', function (e) { if (e.target === wrap) close(null); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(wrap);
      (input || ok).focus();
    });
  }

  // In-page message (replaces alert()). Stays 8 s; click to close.
  function toast(message, isError) {
    var t = document.getElementById('subToast');
    if (!t) {
      t = el('div', 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:min(560px,calc(100% - 32px));z-index:10001;' +
        'padding:12px 16px;border-radius:10px;font-family:Arial,sans-serif;font-size:14px;line-height:1.4;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer;color:#fff');
      t.id = 'subToast'; t.setAttribute('role', 'status');
      t.onclick = function () { t.style.display = 'none'; };
      document.body.appendChild(t);
    }
    t.textContent = message;
    t.style.background = isError ? '#b91c1c' : '#14532d';
    t.style.display = 'block';
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.style.display = 'none'; }, 8000);
  }

  // Sydney time, like sub_today() in the database. Timestamps arrive in UTC, so cutting the text gives the wrong day.
  var SYDNEY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Australia/Sydney', dateStyle: 'short', timeStyle: 'short' });
  // 'YYYY-MM-DD HH:MM', or '' when there is no valid value.
  function sydneyDateTime(v) {
    var d = new Date(v);
    return v == null || v === '' || isNaN(d) ? '' : SYDNEY.format(d);
  }
  // 'YYYY-MM-DD'. Without an argument: today.
  function sydneyDate(v) { return sydneyDateTime(v === undefined ? Date.now() : v).slice(0, 10); }
  // Calendar arithmetic on 'YYYY-MM-DD', so no time zone can move the day.
  function addDays(ymd, n) {
    var d = new Date(ymd + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  window.SubShared = { fillDuration: fillDuration, openInvoice: openInvoice, durationLabel: label, dayAmount: dayAmount,
    dialog: dialog, toast: toast, sydneyDateTime: sydneyDateTime, sydneyDate: sydneyDate, addDays: addDays };
})();
