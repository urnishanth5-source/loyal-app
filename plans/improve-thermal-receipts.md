# Improve GST Thermal Receipts

## Goal

Replace the current minimal 80 mm receipt with a polished, full GST thermal receipt and support both 80 mm and 58 mm paper. Make both layouts available immediately after checkout and when reprinting an invoice from Sales history.

## Confirmed Product Decisions

- Use a fixed, improved standard template rather than adding receipt-template settings or per-print editing.
- Support two explicit paper sizes: 80 mm and 58 mm.
- Show full GST receipt detail.
- Allow historical invoices to be reprinted from the invoice detail view.
- Printing must not edit or recalculate a finalized invoice.
- No logo, QR code, barcode, configurable footer, or receipt preview is in scope.

## Current Behavior

- `BillingWorkspace.tsx` builds a minimal receipt as an inline HTML string.
- Only 80 mm is supported.
- Thermal printing is available only on the checkout success screen.
- The receipt omits seller address, date/time, customer, rates, discounts, GST breakdown, payment information, and invoice status.
- Historical invoice details already include the invoice, item rows, payments, and credit notes.
- Finalized invoices store a `seller_snapshot`, so historical reprints can use the seller details that applied when the invoice was created rather than current Billing Settings.

## Implementation

### 1. Add a reusable thermal-receipt module

Create `src/billing/receiptPrint.ts` with:

- A `ThermalReceiptWidth` type limited to `58 | 80`.
- A normalized `ThermalReceiptData` interface containing:
  - seller legal name, GSTIN, and complete address;
  - invoice number, creation date, status, place of supply, customer name, and customer phone;
  - normalized calculated line items;
  - subtotal, line discount, bill/cart discount, taxable amount, CGST, SGST, IGST, and grand total;
  - payment rows and references;
  - loyalty points awarded and reversed;
  - refunded amount and related credit-note numbers when present.
- A pure `buildThermalReceiptHtml(data, width)` function.
- A `printThermalReceipt(data, width)` function that opens the print window, writes the generated document, waits until it is ready, focuses it, and invokes browser printing.
- A boolean/result return for popup-blocked failures so `BillingWorkspace` can show a useful message.

All interpolated seller, customer, item, reference, and invoice text must be HTML-escaped before insertion into the print document. Numeric values must use the existing INR formatter and quantities must preserve fractional values without unnecessary trailing zeros.

### 2. Build a full GST receipt layout

Both layouts will contain the same information, with width-specific presentation:

1. Centered seller header:
   - legal business name;
   - address lines, city, state, and PIN;
   - GSTIN when configured;
   - `TAX INVOICE`.
2. Invoice metadata:
   - invoice number;
   - localized invoice date and time;
   - customer name or `Walk-in`;
   - masked customer phone when present;
   - place-of-supply code when available.
3. Item section:
   - item name;
   - HSN/SAC and GST rate;
   - quantity and unit;
   - unit rate;
   - line amount.
4. Totals section:
   - subtotal;
   - line-item discount only when nonzero;
   - bill/cart discount only when nonzero;
   - taxable amount;
   - nonzero CGST/SGST or IGST rows;
   - emphasized grand total.
5. Payment section:
   - each payment mode and amount;
   - reference when present.
6. Loyalty and footer:
   - points awarded;
   - points reversed when nonzero;
   - `Thank you`.

For 80 mm, use a compact multi-column item grid with enough room for item names and right-aligned amounts. For 58 mm, place each item name on its own line and use a compact second line for quantity × rate, GST/HSN, and amount to avoid clipped columns.

Use print CSS with:

- `@page` set to the selected paper width and automatic height;
- small thermal-printer-safe margins;
- black text on white, no decorative backgrounds;
- a common monospace/system fallback stack;
- dashed separators, tabular numbers, and controlled wrapping;
- no fixed viewport height, preventing the large blank area from being part of the receipt content.

### 3. Handle paid and refunded historical invoices correctly

- Paid invoices print normally.
- Partially refunded or refunded invoices display a prominent uppercase status near the invoice metadata.
- Show the refunded amount and credit-note number(s) beneath the original invoice total.
- Continue to identify the document as the original tax invoice; do not present a reprint as a new invoice or as a credit note.
- Use `seller_snapshot` from the historical invoice, falling back to current settings only if an older record lacks a usable snapshot.

### 4. Normalize current and historical invoice data

In `src/BillingWorkspace.tsx`:

- Replace the inline `printReceipt` HTML builder with calls to the receipt module.
- Add a small adapter for the just-completed invoice using:
  - `lastInvoice`;
  - current calculated `totals`;
  - current `payments`;
  - the finalized customer fields on `lastInvoice`;
  - current settings, which match the seller snapshot at creation time.
- Add a historical-invoice adapter using:
  - `selectedSale.invoice`;
  - `selectedSale.items`;
  - `selectedSale.payments`;
  - `selectedSale.creditNotes`;
  - `selectedSale.invoice.seller_snapshot`.
- Convert backend snake_case money and line fields to numbers once in the adapter rather than inside the HTML builder.
- Reuse these normalized values for both paper widths so the layouts cannot disagree on accounting amounts.

### 5. Update print actions

On the checkout success screen:

- Replace `Print 80mm receipt` with:
  - `Print 80 mm`;
  - `Print 58 mm`.
- Keep `Download PDF` and `New sale` unchanged.

In the historical invoice detail actions:

- Add `Print 80 mm` and `Print 58 mm` alongside the existing PDF, edit, and refund actions.
- Disable or hide print actions while invoice data is being refreshed/edited so a stale draft is not printed.
- Printing from Sales history must always use the persisted invoice data returned by the server.

If a popup is blocked, leave the invoice screen intact and show a message asking the user to allow popups for printing.

## Files

- Add `src/billing/receiptPrint.ts`.
- Add `src/billing/receiptPrint.test.ts`.
- Update `src/BillingWorkspace.tsx`.
- Update `src/index.css` only if the in-app action rows need responsive wrapping for the two print buttons; all receipt-specific CSS remains inside the generated print document.
- No Supabase migration or Edge Function change is required.

## Edge Cases

- Long business, customer, and product names wrap rather than overlap amounts.
- Missing GSTIN, address line 2, customer, phone, payment reference, or zero-value tax/discount fields are omitted cleanly.
- Fractional quantities and non-`unit` units remain visible.
- CGST/SGST and IGST are mutually represented according to persisted totals.
- Mixed payment modes print as separate rows.
- Special characters in names cannot inject markup into the print window.
- The rupee symbol has a font fallback; amounts remain aligned on both widths.
- Refunded invoices clearly show status and refund information.
- Popup blocking produces an app message instead of failing silently.

## Verification

### Automated

- Unit-test `buildThermalReceiptHtml` for:
  - full 80 mm paid GST invoice;
  - compact 58 mm invoice;
  - omitted zero-value optional rows;
  - split payments;
  - refunded status and credit-note details;
  - HTML escaping of seller, customer, item, and payment-reference text.
- Run `pnpm test`.
- Run `pnpm run build`.

### Manual

- Complete a sale and verify both print actions open the browser print dialog.
- Check print previews at exactly 80 mm and 58 mm with no horizontal clipping.
- Verify a long item name and fractional quantity wrap correctly.
- Verify totals, discounts, GST, payment split, and loyalty points match the finalized invoice/PDF.
- Open a historical paid invoice and print both widths.
- Open a partially refunded or refunded invoice and verify status, refunded amount, and credit-note number are visible.
- Confirm historical seller details come from the invoice snapshot.
- Block popups and confirm the app displays a recovery message.
