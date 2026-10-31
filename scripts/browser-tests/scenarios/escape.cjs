// Stored-XSS scenario: every free-text field carries an image whose error handler sets a flag.
const X = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
module.exports = async ({ run, open, sleep }) => {
  await open('admin.html');
  
  await run(`(() => {
    const X = ${JSON.stringify(X)};
    const today = new Date();
    const ymd = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-15';
    calDate = new Date(today.getFullYear(), today.getMonth());
    bookings = [{ id: 'b1', name: 'Ana ' + X, phone: X, email: X, date: ymd, start_time: '09:00', pickup_address: X, dropoff_address: X,
                  notes: X, status: 'upcoming', signature_name: X, signed_date: ymd }];
    renderAll();
    openDayModal(15);
    invoicesListCache = [{ id: 'i1', invoice_number: X, customer_snapshot: { name: X }, total_amount: 1, status: 'draft', effective_status: X, issued_date: X, due_date: X }];
    renderInvoicesList();
    quotesListCache = [{ id: 'q1', contact_name: X, contact_email: X, status: 'sent', created_at: '2026-10-31T00:00:00Z', lead_id: 'l1' }];
    quotesLeadSourceMap = new Map([['l1', X]]);
    renderQuotesList();
    document.getElementById('inv_payments_body').innerHTML = renderInvoicePaymentsBody([{ amount: 1, method: X, reference: X, status: 'completed', paid_at: '2026-10-31', notes: X }], 1);
    document.getElementById('inv_payment_detail_body').innerHTML = renderPaymentDetailBody({ id: X, amount: 1, method: X, reference: X, status: X, notes: X });
    drawParticipants = [X]; drawHistory = [{ name: X, date: X }]; renderDraw(); renderDrawHistory();
    ['inv_client', 'inv_pickup', 'inv_dropoff', 'inv_phone', 'inv_email', 'inv_desc', 'inv_discount_desc'].forEach((i) => { document.getElementById(i).value = X; });
    document.getElementById('inv_start').value = '09:00'; document.getElementById('inv_finish').value = '10:00'; document.getElementById('inv_discount_value').value = '1';
    addInvExtra(); const row = document.getElementById('inv_extras').lastElementChild; row.querySelector('[id$="d"]').value = X; row.querySelector('[id$="a"]').value = '5';
    generateAdminInvoice();
    return 1;
  })()`);
  await sleep(1200);
  const fired = await run('window.__xss || 0');
  const shown = await run(`document.getElementById('clientList').textContent.includes('onerror')`);
  const imgs = await run(`document.querySelectorAll('img[src="x"]').length`);
  
  if (fired > 0 || imgs > 0 || !shown) throw new Error(`injection ran: fired ${fired}, imgs ${imgs}, shown ${shown}`);
};
