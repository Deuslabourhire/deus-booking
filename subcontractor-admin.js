// Subcontractor work records — Admin/CRM module.
// Usage: SubAdmin.init(db, rootElement[, { portalUrl }])  — db = an admin-logged-in supabase-js v2 client.
// All worker-provided text is rendered with textContent (never innerHTML).
// Every write to records goes through audited SECURITY DEFINER RPCs; the database re-checks admin.
(function () {
  'use strict';

  var db = null, root = null, portalUrl = '', currentFilter = 'pending';
  var cache = { levels: [], jobs: [], rates: [], subs: [], links: [], invoices: [], alerts: [] };
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
  function toast(msg) { if (typeof window.showToast === 'function') window.showToast(msg); else alert(msg); }
  function fail(e) { toast('Error: ' + ((e && (e.message || e.code)) || 'unknown')); }
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
      db.from('sub_levels').select('*').order('sort_order').order('name'),
      db.from('sub_job_types').select('*').order('name'),
      db.from('sub_rates').select('*'),
      // bank details are NOT in this table; they are only fetched on demand via an audited RPC
      db.from('subcontractors').select('id,display_name,level_id,active,full_name,address,email,phone,abn,gst_registered,profile_updated_at').order('display_name'),
      db.from('sub_links').select('id,subcontractor_id,created_at,expires_at,revoked_at,last_used_at').is('revoked_at', null),
      db.from('sub_invoices').select('*').order('submitted_at', { ascending: false }).limit(200),
      db.from('sub_notifications').select('id,kind,subcontractor_id,created_at,details,email_status,worker_email_status,delivery_state,attempts,gave_up_reason').is('acknowledged_at', null).order('created_at', { ascending: false })
    ]);
    r.forEach(function (x) { if (x.error) throw x.error; });
    cache.levels = r[0].data; cache.jobs = r[1].data; cache.rates = r[2].data;
    cache.subs = r[3].data; cache.links = r[4].data; cache.invoices = r[5].data; cache.alerts = r[6].data;
  }
  function subName(id) { var s = cache.subs.find(function (x) { return x.id === id; }); return s ? (s.full_name || s.display_name) : '?'; }

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
    box.appendChild(head); box.appendChild(list);
    var rows = cache.invoices.filter(function (i) { return filter.value === 'all' || i.status === filter.value; });
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
        el('div', { text: String(a.created_at).slice(0, 16).replace('T', ' ') + ' · before: ' + [o.account_name, 'BSB ' + o.bsb, 'Acc ' + o.account_number].join(' ') +
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
    var card = el('div', { style: CARD }, [
      el('div', { style: 'display:flex;justify-content:space-between;gap:8px;cursor:pointer', onclick: function () { toggle(details, inv); } }, [
        el('div', null, [el('b', { text: inv.invoice_number }), ' · ', w.full_name || subName(inv.subcontractor_id),
          el('div', { style: 'font-size:11px;color:#888', text: String(inv.submitted_at).slice(0, 10) + ' · ABN ' + (w.abn || '-') + (inv.gst_registered ? ' · GST' : ' · no GST') })]),
        el('div', { style: 'text-align:right' }, [el('b', { text: money(inv.total) }), el('div', { style: 'font-size:11px', text: STATUS_LABEL[inv.status] })])
      ]),
      details
    ]);
    return card;
  }

  async function toggle(details, inv) {
    if (details.style.display === 'block') { details.style.display = 'none'; return; }
    details.textContent = 'Loading…'; details.style.display = 'block';
    var r = await db.from('sub_work_days').select('*').eq('invoice_id', inv.id).order('work_date').order('start_time');
    if (r.error) { details.textContent = 'Error loading days.'; return; }
    details.textContent = '';
    var w = inv.worker_snapshot || {};
    details.appendChild(el('div', { style: 'font-size:12px;color:#555;margin-bottom:6px', text:
      (w.address || '-') + ' · Email ' + (w.email || '-') + ' · Phone ' + (w.phone || '-') }));
    var editable = inv.status === 'pending' || inv.status === 'approved';
    r.data.forEach(function (d) { details.appendChild(dayRow(d, inv, editable)); });
    details.appendChild(el('div', { style: 'font-size:13px;margin:8px 0', text:
      'Labour ' + money(inv.labour_total) + ' · Travel ' + money(inv.travel_total) + ' · Subtotal ' + money(inv.subtotal) +
      ' · GST ' + money(inv.gst_amount) + ' · Total ' + money(inv.total) }));
    if (inv.paid_at) details.appendChild(el('div', { style: 'font-size:12px;color:#2a7a2a', text: 'Paid ' + inv.paid_at + ' · ' + (inv.payment_method || '') + ' · ' + (inv.payment_reference || '') }));
    details.appendChild(el('div', { style: 'font-size:11px;color:#555;margin:4px 0', text:
      'Declaration (' + (inv.declaration_version || '-') + ') accepted ' + String(inv.declaration_accepted_at || '').slice(0, 16).replace('T', ' ') + ': ' + (inv.declaration_text || '') }));
    if (inv.admin_notes) details.appendChild(el('div', { style: 'font-size:12px;color:#555', text: 'Notes: ' + inv.admin_notes }));
    details.appendChild(el('div', { style: 'font-size:11px;color:#999', text: 'E-mail copy: worker ' + (inv.worker_email_status || '-') + ' · admin ' + (inv.admin_email_status || '-') }));
    details.appendChild(statusActions(inv));
    var audit = await db.from('sub_audit').select('at,action,reason').eq('invoice_id', inv.id).order('at');
    if (!audit.error && audit.data.length) {
      details.appendChild(el('div', { style: 'font-size:11px;color:#888;margin-top:6px' }, audit.data.map(function (a) {
        return el('div', { text: String(a.at).slice(0, 16).replace('T', ' ') + ' · ' + a.action + (a.reason ? ' · ' + a.reason : '') });
      })));
    }
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
  function askReason(what) {
    var r = prompt('Reason for ' + what + ' (required, saved in history):');
    if (r === null) return null;
    if (r.trim().length < 3) { toast('A reason is required.'); return null; }
    return r.trim();
  }

  function jobName(id) { var j = cache.jobs.find(function (x) { return x.id === id; }); return j ? j.name : '?'; }

  function dayRow(d, inv, editable) {
    var row = el('div', { style: 'border-top:1px solid #f0f0f0;padding:6px 0;font-size:12px' }, [
      el('div', { text: d.work_date + ' · ' + jobName(d.job_type_id) + ' · ' + d.start_time.slice(0, 5) + '–' + d.finish_time.slice(0, 5) +
        ' (break ' + d.break_minutes + 'm) · ' + d.work_hours + 'h × ' + money(d.hourly_rate) + ' = ' + money(d.labour_amount) +
        ' · travel ' + d.travel_minutes + 'm × ' + money(d.travel_rate) + '/h = ' + money(d.travel_amount) + (d.admin_adjusted ? ' · ✎ adjusted' : '') }),
      d.notes ? el('div', { style: 'color:#888', text: d.notes }) : null
    ]);
    if (editable) row.appendChild(el('button', { style: BTN, text: 'Correct hours', onclick: function () { adjustForm(row, d, inv); } }));
    return row;
  }

  function adjustForm(row, d, inv) {
    if (row.querySelector('form')) return;
    var job = el('select', { style: INPUT }, cache.jobs.map(function (j) { return el('option', { value: j.id, text: j.name }); }));
    job.value = String(d.job_type_id);
    var st = el('input', { type: 'time', style: INPUT, value: d.start_time.slice(0, 5) });
    var fi = el('input', { type: 'time', style: INPUT, value: d.finish_time.slice(0, 5) });
    var br = el('input', { type: 'number', min: '0', style: INPUT + ';width:70px', value: d.break_minutes, title: 'Break (min)' });
    var tr = el('input', { type: 'number', min: '0', style: INPUT + ';width:70px', value: d.travel_minutes, title: 'Travel (min)' });
    var reason = el('input', { style: INPUT + ';width:100%', placeholder: 'Reason (required)' });
    var form = el('form', { style: 'margin-top:6px;background:#fafafa;padding:6px;border-radius:6px' }, [
      job, st, fi, 'break', br, 'travel', tr, reason,
      el('button', { type: 'submit', style: BTN_G, text: 'Save correction' })
    ]);
    form.onsubmit = async function (ev) {
      ev.preventDefault();
      var r = await db.rpc('sub_admin_adjust_day', { p_day_id: d.id, p_job_type_id: Number(job.value), p_start: st.value, p_finish: fi.value,
        p_break_minutes: Number(br.value || 0), p_travel_minutes: Number(tr.value || 0), p_reason: reason.value });
      if (r.error) return fail(r.error);
      toast('Correction saved.'); await refresh();
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
      var r = await db.rpc('sub_admin_set_status', Object.assign({ p_invoice_id: inv.id, p_status: status }, extra || {}));
      if (r.error) return fail(r.error);
      // Refusals that are recorded in history come back as { ok:false, error, message } (no exception).
      if (r.data && r.data.ok === false) { toast(r.data.message || r.data.error); await refresh(); return; }
      toast('Status: ' + STATUS_LABEL[status]); await refresh();
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
      // Mark as paid: date + method required, reference optional.
      var date = el('input', { type: 'date', style: INPUT, value: new Date().toISOString().slice(0, 10) });
      var method = el('select', { style: INPUT }, [el('option', { value: '', text: 'Payment method *' })]
        .concat(PAY_METHODS.map(function (m) { return el('option', { value: m, text: m }); })));
      var ref = el('input', { style: INPUT, placeholder: 'Reference (optional)', maxlength: '120' });
      box.appendChild(el('div', { style: 'margin:4px 0' }, [date, method, ref,
        el('button', { style: BTN_G, text: 'Mark as paid', onclick: function () {
          if (!date.value || !method.value) return toast('Payment date and method are required.');
          set('paid', { p_paid_at: date.value, p_payment_method: method.value, p_payment_reference: ref.value });
        } })]));
    }
    if (inv.status === 'approved') {
      box.appendChild(el('button', { style: BTN, text: 'Back to pending', onclick: function () { set('pending'); } }));
    }
    if (inv.status === 'pending' || inv.status === 'approved') {
      box.appendChild(el('button', { style: BTN + ';color:#b91c1c', text: 'Cancel record', onclick: function () {
        var note = askReason('cancelling this record (the days stay locked)'); if (!note) return;
        set('cancelled', { p_note: note });
      } }));
    }
    if (inv.status === 'paid') {
      box.appendChild(el('button', { style: BTN, text: 'Undo payment', onclick: function () {
        var note = askReason('undoing the payment'); if (!note) return;
        set('approved', { p_note: note });
      } }));
    }
    return box;
  }

  function exportCsv(filter) {
    var rows = cache.invoices.filter(function (i) { return filter === 'all' || i.status === filter; });
    var head = ['invoice_number', 'worker', 'abn', 'gst_registered', 'submitted_at', 'status', 'paid_at', 'payment_method',
      'payment_reference', 'expense_category', 'labour_total', 'travel_total', 'subtotal', 'gst_amount', 'total'];
    function q(v) { var s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }
    var lines = [head.join(',')].concat(rows.map(function (i) {
      var w = i.worker_snapshot || {};
      return [i.invoice_number, w.full_name, w.abn, i.gst_registered, i.submitted_at, i.status, i.paid_at, i.payment_method,
        i.payment_reference, i.expense_category, i.labour_total, i.travel_total, i.subtotal, i.gst_amount, i.total].map(q).join(',');
    }));
    var a = el('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: 'subcontractor-records-' + filter + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ------------------------------------------------------------------ subcontractors + links
  function renderSubs(box) {
    box.appendChild(el('b', { text: 'Subcontractors' }));
    var name = el('input', { style: INPUT, placeholder: 'Name (internal label)' });
    var level = el('select', { style: INPUT }, cache.levels.filter(function (l) { return l.active; }).map(function (l) { return el('option', { value: l.id, text: l.name }); }));
    box.appendChild(el('div', { style: 'margin:6px 0' }, [name, level, el('button', { style: BTN_G, text: '+ Add', onclick: async function () {
      if (!name.value.trim() || !level.value) return toast('Name and level are required.');
      var r = await db.rpc('sub_admin_create_subcontractor', { p_display_name: name.value.trim(), p_level_id: Number(level.value) });
      if (r.error) return fail(r.error); await refresh();
    } })]));
    cache.subs.forEach(function (s) {
      var link = cache.links.find(function (l) { return l.subcontractor_id === s.id; });
      var lvl = el('select', { style: INPUT }, cache.levels.map(function (l) { return el('option', { value: l.id, text: l.name }); }));
      lvl.value = String(s.level_id);
      lvl.onchange = async function () {
        var reason = askReason('changing the level'); if (!reason) { lvl.value = String(s.level_id); return; }
        var r = await db.rpc('sub_admin_update_subcontractor', { p_id: s.id, p_display_name: s.display_name, p_level_id: Number(lvl.value), p_active: s.active, p_reason: reason });
        if (r.error) return fail(r.error); toast('Level updated (applies to new days).'); await refresh();
      };
      var out = el('div');
      box.appendChild(el('div', { style: CARD }, [
        el('div', null, [el('b', { text: s.display_name }), s.full_name ? ' · ' + s.full_name : '', ' · ', s.active ? 'active' : 'INACTIVE']),
        el('div', { style: 'font-size:11px;color:#888', text: (s.address || 'no address') + ' · ABN ' + (s.abn || '-') + (s.gst_registered ? ' · GST' : ' · no GST') +
          ' · ' + (s.email || 'no email') + ' · ' + (s.phone || 'no phone') +
          ' · link: ' + (link ? 'active since ' + String(link.created_at).slice(0, 10) + (link.last_used_at ? ', last used ' + String(link.last_used_at).slice(0, 10) : ', never used') : 'none') }),
        el('div', null, [lvl,
          el('button', { style: BTN_G, text: link ? 'New link (replaces old)' : 'Create link', onclick: function () { newLink(s, out); } }),
          link ? el('button', { style: BTN + ';color:#b91c1c', text: 'Revoke link', onclick: async function () {
            if (!confirm('Revoke the link of ' + s.display_name + '? It stops working immediately.')) return;
            var r = await db.rpc('sub_admin_revoke_links', { p_subcontractor_id: s.id }); if (r.error) return fail(r.error);
            toast('Link revoked.'); await refresh();
          } }) : null,
          el('button', { style: BTN, text: s.active ? 'Deactivate' : 'Activate', onclick: async function () {
            var reason = askReason(s.active ? 'deactivating' : 'activating'); if (!reason) return;
            var r = await db.rpc('sub_admin_update_subcontractor', { p_id: s.id, p_display_name: s.display_name, p_level_id: s.level_id, p_active: !s.active, p_reason: reason });
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
        String(a.at).slice(0, 16).replace('T', ' ') + ' · ' + a.action + ' (' + who + ')' + (a.reason ? ' · reason: ' + a.reason : '') + change }));
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
      el('button', { style: BTN_G, text: 'Copy', onclick: function () { inp.select(); navigator.clipboard && navigator.clipboard.writeText(url); toast('Copied.'); } })
    ]));
    token = null;
    // refresh link status without wiping the one-time link box
    var l = await db.from('sub_links').select('id,subcontractor_id,created_at,expires_at,revoked_at,last_used_at').is('revoked_at', null);
    if (!l.error) cache.links = l.data;
  }

  // ------------------------------------------------------------------ rates
  function renderRates(box) {
    box.appendChild(el('b', { text: 'Rates (hourly, per job and level)' }));
    box.appendChild(el('div', { style: 'font-size:11px;color:#888;margin-bottom:6px', text:
      'Every change asks for a reason and is saved in History. New rates apply to days saved after the change.' }));
    var lvlName = el('input', { style: INPUT, placeholder: 'New level' });
    var jobNameIn = el('input', { style: INPUT, placeholder: 'New job type' });
    box.appendChild(el('div', null, [lvlName, el('button', { style: BTN, text: '+ Level', onclick: async function () {
      if (!lvlName.value.trim()) return; var reason = askReason('adding a level'); if (!reason) return;
      var r = await db.rpc('sub_admin_save_level', { p_id: null, p_name: lvlName.value.trim(), p_sort_order: 0, p_active: true, p_reason: reason });
      if (r.error) return fail(r.error); await refresh();
    } }), jobNameIn, el('button', { style: BTN, text: '+ Job', onclick: async function () {
      if (!jobNameIn.value.trim()) return; var reason = askReason('adding a job type'); if (!reason) return;
      var r = await db.rpc('sub_admin_save_job_type', { p_id: null, p_name: jobNameIn.value.trim(), p_active: true, p_reason: reason });
      if (r.error) return fail(r.error); await refresh();
    } })]));
    var table = el('table', { style: 'border-collapse:collapse;font-size:12px;margin-top:8px' });
    table.appendChild(el('tr', null, [el('th', { text: 'Job \\ Level', style: 'text-align:left;padding:4px' })].concat(cache.levels.map(function (l) {
      var act = el('input', { type: 'checkbox', title: 'Level active' }); act.checked = l.active;
      act.onchange = async function () {
        var reason = askReason((act.checked ? 'activating' : 'deactivating') + ' level ' + l.name); if (!reason) { act.checked = !act.checked; return; }
        var r = await db.rpc('sub_admin_save_level', { p_id: l.id, p_name: l.name, p_sort_order: l.sort_order, p_active: act.checked, p_reason: reason });
        if (r.error) { act.checked = !act.checked; return fail(r.error); } await refresh();
      };
      return el('th', { style: 'padding:4px' }, [l.name, ' ', act]);
    })).concat([el('th', { text: 'Active' })])));
    cache.jobs.forEach(function (j) {
      var tr = el('tr', null, [el('td', { text: j.name, style: 'padding:4px' })]);
      cache.levels.forEach(function (l) {
        var cur = cache.rates.find(function (r) { return r.job_type_id === j.id && r.level_id === l.id; });
        var original = cur ? String(cur.hourly_rate) : '';
        var inp = el('input', { type: 'number', min: '0', step: '0.01', style: INPUT + ';width:80px', value: original });
        inp.onchange = async function () {
          var reason = askReason('changing the rate ' + j.name + ' / ' + l.name); if (!reason) { inp.value = original; return; }
          var r = await db.rpc('sub_admin_set_rate', { p_job_type_id: j.id, p_level_id: l.id,
            p_hourly_rate: inp.value === '' ? null : Number(inp.value), p_reason: reason });
          if (r.error) { inp.value = original; return fail(r.error); }
          original = inp.value; toast(r.data && r.data.changed ? 'Rate saved and recorded in history.' : 'No change.');
        };
        tr.appendChild(el('td', null, [inp]));
      });
      var act = el('input', { type: 'checkbox' }); act.checked = j.active;
      act.onchange = async function () {
        var reason = askReason((act.checked ? 'activating' : 'deactivating') + ' job ' + j.name); if (!reason) { act.checked = !act.checked; return; }
        var r = await db.rpc('sub_admin_save_job_type', { p_id: j.id, p_name: j.name, p_active: act.checked, p_reason: reason });
        if (r.error) { act.checked = !act.checked; return fail(r.error); }
      };
      tr.appendChild(el('td', { style: 'text-align:center' }, [act]));
      table.appendChild(tr);
    });
    box.appendChild(table);
    box.appendChild(el('button', { style: BTN + ';margin-top:8px', text: 'Configuration history', onclick: async function () {
      var out = this.nextSibling || box.appendChild(el('div'));
      out.textContent = 'Loading…';
      var r = await db.from('sub_audit').select('at,actor,action,old_data,new_data,reason')
        .in('action', ['level_created', 'level_updated', 'job_type_created', 'job_type_updated', 'rate_changed'])
        .order('at', { ascending: false }).limit(100);
      if (r.error) { out.textContent = 'Error loading history.'; return; }
      out.textContent = '';
      r.data.forEach(function (a) {
        out.appendChild(el('div', { style: 'font-size:11px;color:#555;border-top:1px solid #f0f0f0;padding:3px 0', text:
          String(a.at).slice(0, 16).replace('T', ' ') + ' · ' + a.action + ' · by ' + String(a.actor || '').slice(0, 8) +
          ' · ' + JSON.stringify(a.old_data || {}) + ' → ' + JSON.stringify(a.new_data || {}) + (a.reason ? ' · reason: ' + a.reason : '') }));
      });
      if (!r.data.length) out.textContent = 'No configuration changes yet.';
    } }));
    box.appendChild(el('div'));
  }

  // ------------------------------------------------------------------ main
  async function refresh() {
    if (!root) return;
    root.textContent = 'Loading…';
    try { await loadAll(); } catch (e) { root.textContent = 'Could not load subcontractor data: ' + ((e && e.message) || 'error'); return; }
    root.textContent = '';
    var tabs = ['Records', 'Subcontractors', 'Rates'];
    var current = root.dataset.view || 'Records';
    var nav = el('div', { style: 'margin-bottom:10px' }, tabs.map(function (t) {
      return el('button', { style: t === current ? BTN_G : BTN, text: t, onclick: function () { root.dataset.view = t; refresh(); } });
    }).concat([el('button', { style: BTN, text: '🔄', onclick: refresh })]));
    var body = el('div');
    root.appendChild(nav); root.appendChild(body);
    if (current === 'Records') renderInvoices(body);
    else if (current === 'Subcontractors') renderSubs(body);
    else renderRates(body);
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
