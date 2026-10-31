// The official Terms & Conditions and Service Agreement: the only copy. The booking page shows this
// text to the client, and every signed document is built from it. Changing it changes a legal text.
(function () {
  'use strict';
  var tc = `DEUS LABOUR HIRE
Moving & Cleaning Services
Email: deus.labour.hire@gmail.com

TERMS AND CONDITIONS – REMOVAL SERVICES

Acceptance of Terms
By booking or accepting our services, the client confirms that they have read, understood, and agreed to these Terms and Conditions.

Duty of Care
Deus Labour Hire Pty Ltd will take reasonable care when handling and transporting the client's belongings. However, removal services involve inherent risks and minor damage may occasionally occur despite reasonable care.

Condition of Goods
The client confirms that all items provided for transport are in a condition suitable for removal unless otherwise disclosed prior to the move.

Client Packing Responsibility
Items packed by the client are transported at the client's risk unless damage is directly caused by proven negligence during handling by our staff.

Fragile and High-Risk Items
Fragile items including televisions, glass items, artwork, mirrors, marble, antiques and electronics require special care and must be disclosed before the move.

Television and Electronic Equipment
Modern televisions are extremely fragile and may suffer internal panel damage even when handled with reasonable care. Televisions should ideally be transported in original packaging.

Disclosure of High-Value Items
Items valued above $800 must be disclosed prior to the move.

Safe Transport and Additional Trips
If fragile items cannot be safely transported due to limited truck space, Deus Labour Hire may transport them in a separate load.

Refusal to Move Unsafe Items
Deus Labour Hire reserves the right to refuse items considered unsafe for transport.

Pre-Existing Damage
Deus Labour Hire is not responsible for items that were already damaged before the move.

Liability for Loss or Damage
If damage occurs due to negligence during the service, liability will be assessed based on the fair market value of the item at the time of the move considering age, condition and depreciation. Nothing in these Terms and Conditions excludes, restricts or modifies any rights that the client may have under the Australian Consumer Law.

Transit Insurance
Deus Labour Hire holds Public Liability Insurance through AIG Australia Limited subject to the policy terms and conditions.

Insurance Claims
If a claim is submitted to the insurer the final decision regarding compensation will be determined by the insurance company.

Claims Procedure
Any claim must be reported within 24 hours after completion of the move and include photographs and a description of the damage.

Resolution of Claims
Resolution may include repair, replacement with the same model, similar second-hand replacement or payment of the fair market value.

Access and Safety
The client must ensure safe access to the property. Additional charges may apply for stairs or restricted access.

Heavy Items
Items over 100kg must be disclosed before the move.

Payment Terms
Payment is due upon completion of the service unless otherwise agreed.

Governing Law
These Terms and Conditions are governed by the laws of Australia.`;

  var sa = `DEUS LABOUR HIRE
Moving & Cleaning Services
Email: deus.labour.hire@gmail.com

SERVICE AGREEMENT – REMOVAL SERVICES

Acceptance and Scope
By booking or accepting our services, the client confirms they have read, understood, and agreed to these Terms and Conditions. Deus Labour Hire Pty Ltd will take reasonable care when handling and transporting the client's belongings. Removal services involve inherent risks and minor damage may occasionally occur despite reasonable care. These Terms are governed by the laws of Australia.

Client Responsibilities
Items packed by the client are transported at the client's risk unless damage is directly caused by proven negligence. The client confirms all goods are suitable for removal unless disclosed prior to the move. The client must ensure safe access to the property. Items over 100kg must be disclosed before the move. Items valued above $800 must be disclosed before the move.

Fragile and Special Items
Fragile items including televisions, glass items, artwork, mirrors, marble, antiques and electronics must be disclosed before the move. Modern televisions are extremely fragile and may suffer internal panel damage even when handled with reasonable care and should ideally be transported in original packaging. If fragile items cannot be safely transported due to limited truck space, Deus Labour Hire may transport them in a separate load. Deus Labour Hire reserves the right to refuse items considered unsafe for transport.

Liability and Insurance
Deus Labour Hire is not responsible for items that were already damaged before the move. If damage occurs due to negligence, liability will be assessed based on the fair market value of the item considering age, condition and depreciation. Deus Labour Hire holds Public Liability Insurance through AIG Australia Limited subject to policy terms. Any claim must be reported within 24 hours and must include photos and description of the damage. Nothing in these terms excludes the client's rights under Australian Consumer Law.

Payment and Additional Fees
Payment is due upon completion of the service unless otherwise agreed. Additional charges may apply for stairs, restricted access or long carrying distances.

Company Representative: Deus Labour Hire Pty Ltd`;

  function esc(s) {
    return s.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  // For signed documents: the first two blocks are the letterhead and the title, each later block is
  // a heading followed by its text (a block with one line is plain text).
  function toHtml(text) {
    return text.split('\n\n').slice(2).map(function (block) {
      var lines = block.split('\n');
      if (lines.length === 1) return '<p>' + esc(lines[0]) + '</p>';
      return '<h3>' + esc(lines[0]) + '</h3><p>' + esc(lines.slice(1).join(' ')) + '</p>';
    }).join('');
  }
  window.DEUS_TERMS = { tc: tc, sa: sa, toHtml: toHtml };
})();
