# Business POS Billing with GST and Loyalty Integration

## 1. Goal

Add a production-oriented billing workspace to the existing business portal. A business should be able to:

- Maintain a reusable product/service catalog.
- Add catalog items or one-off custom items to a cart.
- Create India GST-compliant retail bills.
- Accept cash, UPI, card, or split payments.
- Print an 80mm receipt and download/share an A4 PDF tax invoice.
- Link an existing loyalty customer or complete a walk-in sale.
- Automatically award loyalty points from the final paid total.
- Review past sales and issue credit notes for refunds.

The feature must integrate with the existing business ownership, customer memberships, points balances, notifications, activity history, purple/pink visual system, and Supabase Edge Function.

## 2. Confirmed Product Decisions

- Scope: POS billing with loyalty integration.
- Region: India GST billing.
- Items: reusable product/service catalog plus one-off custom items.
- Payments: cash, UPI, card, and split payments.
- Documents: 80mm print receipt and downloadable/shareable PDF tax invoice.
- Customers: walk-in and linked retail loyalty customers; no B2B buyer GSTIN/address workflow in version one.
- Pricing: each item can be GST-inclusive or GST-exclusive.
- Tax breakdown: CGST/SGST for intrastate sales and IGST for interstate sales.
- Loyalty: paid bills automatically earn points.
- Loyalty basis: final paid total, including GST, after discounts.
- Loyalty rounding: fractional points round down.
- Finalized invoices are immutable.
- Corrections/refunds use credit notes and reverse the corresponding loyalty points.
- No staff accounts, inventory purchasing/stock control, accounting ledger, recurring invoices, credit sales, or payment-gateway collection in version one.

## 3. Existing-System Integration

### Existing patterns to preserve

- The business dashboard is implemented in `BusinessDashboard` in `src/App.tsx`.
- Large operational tools such as RFID use a dedicated full-screen workspace; billing should follow that pattern rather than becoming another crowded modal.
- All authenticated server operations go through `apiRequest` and the Hono Supabase Edge Function.
- Business authorization is enforced with `ownedBusiness`.
- Loyalty membership balances are stored in `kv_store_3a123995` under `pending:<normalizedPhone>:<businessId>`.
- Business customer/activity mirrors are stored under `state:<ownerUserId>`.
- Customer notifications use `dispatchNotification`.

### Entry points

Add a **Billing / POS** action in both:

1. The business dashboard quick-action area.
2. The business `BottomIsland` action menu.

Both entry points open the same full-screen `BillingWorkspace`.

## 4. User Experience

## 4.1 Billing workspace navigation

Create `src/BillingWorkspace.tsx` with four top-level views:

1. **Checkout**
2. **Catalog**
3. **Sales**
4. **Settings**

Use the existing purple/pink glass theme, `Button`, `Icon`, responsive layout conventions, and workspace header pattern used by `RfidWorkspace`.

### Responsive behavior

- Desktop/tablet: two-column checkout with catalog/search on the left and cart/payment summary on the right.
- Mobile: catalog and cart stack vertically; keep a sticky cart summary/finalize action.
- Do not introduce nested viewport mockups or fixed desktop widths.
- Preserve keyboard operation and visible focus states.

## 4.2 Checkout

### Item selection

- Search catalog by name, SKU, barcode, HSN/SAC, or category.
- Support keyboard-wedge barcode scanners by buffering fast keyboard input and submitting on Enter, following the existing RFID reader pattern.
- Add a catalog item with one action.
- Add a custom item through a compact form requiring:
  - Item name
  - Product or service
  - HSN/SAC
  - Quantity and unit
  - Unit price
  - GST rate
  - Inclusive or exclusive tax mode

### Cart

Each line displays:

- Name and HSN/SAC
- Quantity controls
- Unit price
- Inclusive/exclusive indicator
- GST rate
- Optional line discount
- Taxable value
- Tax amount
- Line total
- Remove action

Support:

- Percentage or fixed line discount.
- Percentage or fixed cart discount.
- Cart discount allocation across lines in proportion to each line’s post-line-discount value.
- Deterministic paise allocation using a largest-remainder approach so allocated discounts and taxes exactly match invoice totals.

### Customer

- Default to **Walk-in customer**.
- Add `/billing/customers` search for existing customers belonging to the current business.
- Selecting a customer shows name, masked phone, current point balance, and projected points earned.
- Walk-in bills do not earn loyalty points.
- Linked customers earn points only after successful invoice finalization.

### Place of supply

- Default to the seller’s state from billing settings.
- Allow staff to choose another Indian state/UT.
- Same state code: split GST equally into CGST and SGST.
- Different state code: use IGST.

### Payment

Allow one or more payment rows:

- Cash
- UPI
- Card

Each row contains an amount and an optional reference for UPI/card.

Rules:

- Payment rows must be positive.
- Their sum must exactly equal the final invoice total.
- Finalize remains disabled until billing settings, cart, totals, customer selection, and payment allocation are valid.
- No invoice is created if payment validation fails.

### Completion

After finalization:

- Show invoice number, amount, payment breakdown, linked customer, and points awarded.
- Offer **Print receipt**, **Download PDF**, **New sale**, and **View invoice**.
- Update the existing business customer balance and activity state immediately.
- If a linked customer account exists, create an inbox/push notification describing the purchase points and new balance.

## 4.3 Catalog

Catalog list supports:

- Search and active/inactive filtering.
- Create, edit, deactivate, and reactivate.
- Product/service type.
- Name, category, SKU, optional barcode.
- HSN/SAC.
- Unit.
- Price in paise.
- GST rate.
- Inclusive/exclusive pricing.
- Active status.

Version-one GST rates:

- 0%
- 5%
- 12%
- 18%
- 28%

Do not hard-delete items referenced by invoices. Deactivation is the normal removal mechanism.

Barcode must be unique within one business when present.

## 4.4 Sales history

Provide:

- Date range
- Invoice number search
- Customer name/phone search
- Payment mode filter
- Status filter
- Total sales and refund summary for the current result set

Invoice detail includes:

- Seller details
- Invoice metadata
- Customer or walk-in label
- Place of supply
- Item snapshot
- Discount and tax breakdown
- Payment rows
- Loyalty points awarded/reversed
- Credit notes
- Print/download actions

## 4.5 Refunds and credit notes

- Final invoices cannot be edited or deleted.
- A refund creates a credit note.
- Support full or partial quantity refunds against remaining refundable quantities.
- Recalculate the tax reversal from the original invoice snapshots, not current catalog values.
- Record refund method and optional reference.
- Allocate the refundable amount across original split payments only as an informational record; no external payment refund is attempted.
- Reverse loyalty points using the same configured points-per-₹ rate and refunded final amount.
- Clamp the customer’s resulting point balance to zero.
- Store both requested reversal and actual reversed points when the customer no longer has enough points.
- Notify the linked customer of the refund and updated points balance.

## 5. GST Calculation Rules

All monetary values are integer paise. Never use binary floating-point for persisted totals.

Represent GST rates in basis points:

- 0% = `0`
- 5% = `500`
- 12% = `1200`
- 18% = `1800`
- 28% = `2800`

### Inclusive line

For a discounted inclusive amount:

- `taxable = round(inclusiveAmount * 10000 / (10000 + gstRateBps))`
- `tax = inclusiveAmount - taxable`

### Exclusive line

For a discounted exclusive amount:

- `taxable = exclusiveAmount`
- `tax = round(taxable * gstRateBps / 10000)`
- `lineTotal = taxable + tax`

### Intrastate split

- `cgst = floor(tax / 2)`
- `sgst = tax - cgst`
- `igst = 0`

### Interstate split

- `cgst = 0`
- `sgst = 0`
- `igst = tax`

### Loyalty

- `pointsAwarded = floor(finalPaidTotalPaise * pointsPerRupee / 100)`
- `pointsPerRupee` is configurable and may be fractional.
- Store the rate snapshot on the invoice so refunds use the original rule.

Implement one shared pure calculator in `src/billing/calculations.ts`. The Edge Function must independently validate/recalculate totals before persistence; never trust totals supplied by the client.

## 6. Supabase Data Model

Add a new migration after the existing migrations.

## 6.1 `billing_settings`

- `business_id bigint primary key`
- `owner_user_id uuid not null`
- `legal_name text not null`
- `gstin text not null`
- `address_line_1 text not null`
- `address_line_2 text`
- `city text not null`
- `state_name text not null`
- `state_code text not null`
- `postal_code text not null`
- `invoice_prefix text not null default 'INV'`
- `credit_note_prefix text not null default 'CN'`
- `points_per_rupee numeric(10,4) not null default 1`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Validation:

- GSTIN format validation in server code.
- State code must be a supported Indian state/UT code.
- Prefixes uppercase alphanumeric plus `-` or `/`, with a short maximum length.
- `points_per_rupee >= 0`.

## 6.2 `billing_document_counters`

- `business_id bigint`
- `fiscal_year text`
- `document_type text` (`invoice` or `credit_note`)
- `next_number bigint`
- Composite primary key across all three columns.

Invoice format:

`<PREFIX>/<FY>/<6-digit sequence>`

Fiscal year uses India’s April–March boundary, for example `2026-27`.

Allocate numbers under a row lock inside the finalization transaction. Failed requests must not consume a number unless the invoice transaction commits.

## 6.3 `billing_catalog_items`

- `id uuid primary key`
- `business_id bigint not null`
- `owner_user_id uuid not null`
- `item_type text not null`
- `name text not null`
- `category text`
- `sku text`
- `barcode text`
- `hsn_sac text not null`
- `unit text not null`
- `price_paise bigint not null`
- `gst_rate_bps integer not null`
- `price_includes_tax boolean not null`
- `active boolean not null default true`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Constraints:

- Positive price.
- Allowed item types and GST rates.
- Unique `(business_id, barcode)` when barcode is not null.
- Unique `(business_id, sku)` when SKU is not null.

## 6.4 `billing_invoices`

- `id uuid primary key`
- `business_id bigint not null`
- `owner_user_id uuid not null`
- `invoice_number text not null`
- `fiscal_year text not null`
- `status text not null` (`paid`, `partially_refunded`, `refunded`)
- `customer_id text`
- `customer_name text`
- `customer_phone text`
- `place_of_supply_code text not null`
- `subtotal_paise bigint not null`
- `line_discount_paise bigint not null`
- `cart_discount_paise bigint not null`
- `taxable_paise bigint not null`
- `cgst_paise bigint not null`
- `sgst_paise bigint not null`
- `igst_paise bigint not null`
- `total_paise bigint not null`
- `points_per_rupee_snapshot numeric(10,4) not null`
- `points_awarded integer not null`
- `points_reversed integer not null default 0`
- `idempotency_key uuid not null`
- Seller snapshot fields for legal name, GSTIN, address, and state
- `created_at timestamptz not null`

Constraints:

- Unique `(business_id, invoice_number)`.
- Unique `(business_id, idempotency_key)`.
- Totals nonnegative and internally consistent.

## 6.5 `billing_invoice_items`

Snapshot every billed line:

- `id uuid primary key`
- `invoice_id uuid not null`
- `catalog_item_id uuid`
- `line_number integer not null`
- `item_type text not null`
- `name text not null`
- `hsn_sac text not null`
- `unit text not null`
- `quantity numeric(14,3) not null`
- `unit_price_paise bigint not null`
- `price_includes_tax boolean not null`
- `gst_rate_bps integer not null`
- `line_discount_paise bigint not null`
- `allocated_cart_discount_paise bigint not null`
- `taxable_paise bigint not null`
- `cgst_paise bigint not null`
- `sgst_paise bigint not null`
- `igst_paise bigint not null`
- `total_paise bigint not null`

## 6.6 `billing_payments`

- `id uuid primary key`
- `invoice_id uuid not null`
- `payment_mode text not null`
- `amount_paise bigint not null`
- `reference text`
- `created_at timestamptz not null`

Allowed modes: `cash`, `upi`, `card`.

## 6.7 `billing_credit_notes`

- `id uuid primary key`
- `invoice_id uuid not null`
- `business_id bigint not null`
- `owner_user_id uuid not null`
- `credit_note_number text not null`
- `reason text not null`
- Refunded subtotal, discounts, taxable value, CGST, SGST, IGST, and total in paise
- `points_reversal_requested integer not null`
- `points_reversed integer not null`
- `idempotency_key uuid not null`
- `created_at timestamptz not null`

## 6.8 `billing_credit_note_items`

- Credit-note line ID
- Credit note ID
- Original invoice item ID
- Refunded quantity
- Snapshot of reversed discount, taxable value, taxes, and total

## 6.9 Access control

- Enable RLS on every billing table.
- Revoke direct access from `public`, `anon`, and `authenticated`.
- Edge Function service-role operations are the only application access path.
- Every endpoint must verify `ownedBusiness` before reading or mutating billing data.
- Never accept `owner_user_id` from the browser.

## 7. Atomic Database Operations

Add security-definer RPCs available only to `service_role`.

## 7.1 `perklyn_finalize_billing_invoice`

Within one database transaction:

1. Lock/allocate the invoice counter.
2. Reject duplicate idempotency keys by returning the existing invoice.
3. Insert invoice, item snapshots, and payment rows.
4. If linked customer:
   - Lock the membership KV row.
   - Add awarded points.
   - Append a billing activity to the membership and business state.
   - Update the customer mirror in `state:<ownerUserId>`.
5. Return invoice and new loyalty balance.

The Edge Function sends validated canonical totals and snapshots to the RPC.

## 7.2 `perklyn_create_billing_credit_note`

Within one database transaction:

1. Lock the invoice and prior credit-note rows.
2. Reject quantities exceeding remaining refundable quantities.
3. Lock/allocate the credit-note counter.
4. Insert credit note and item rows.
5. Update invoice refund status and points reversed.
6. If linked customer, reverse points and update membership/business state.
7. Return credit note and new loyalty balance.

Both RPCs must be idempotent.

## 8. Edge Function API

Add routes under the existing prefix.

### Settings

- `GET /billing/settings?businessId=...`
- `PUT /billing/settings`

### Catalog

- `GET /billing/catalog?businessId=...&query=...&status=...`
- `POST /billing/catalog`
- `PUT /billing/catalog/:id`

No hard-delete endpoint; use `active: false`.

### Customers

- `GET /billing/customers?businessId=...&query=...`

Return only customers belonging to the business with masked phone, current points, and stable customer ID. Full phone may be returned only after explicit selection if required for invoice linking.

### Quote and invoices

- `POST /billing/quote`
  - Validates catalog/custom items.
  - Recalculates discounts and GST.
  - Returns canonical line and invoice totals plus projected points.
- `POST /billing/invoices`
  - Repeats validation/calculation server-side.
  - Validates exact payment allocation.
  - Calls the finalization RPC.
- `GET /billing/invoices?businessId=...&from=...&to=...&query=...&status=...&paymentMode=...&cursor=...`
- `GET /billing/invoices/:id?businessId=...`
- `POST /billing/invoices/:id/credit-notes`

Use cursor pagination for sales history.

### Validation and limits

- Maximum 100 lines per invoice.
- Maximum safe monetary total defined in server constants.
- Quantity precision limited to three decimals.
- Field lengths constrained.
- Rate-limit quote, finalization, and refund endpoints separately.
- Sanitize text before document generation.

## 9. Frontend Types and Modules

Create:

- `src/billing/types.ts`
- `src/billing/calculations.ts`
- `src/billing/format.ts`
- `src/billing/invoicePdf.ts`
- `src/BillingWorkspace.tsx`

Keep billing logic out of the already-large `App.tsx`.

`BusinessDashboard` only owns:

- `showBilling`
- Opening/closing the workspace
- Passing the current merchant
- Updating existing customer/activity state after a completed sale or refund

## 10. PDF and Printing

Add `pdf-lib` for deterministic downloadable PDFs without rendering the UI to a canvas.

### A4 PDF

Include:

- Seller legal details and GSTIN
- Tax invoice number/date
- Place of supply
- Walk-in or customer name/phone
- Item table with HSN/SAC, quantity, rate, discount, taxable value, GST, total
- CGST/SGST or IGST summary
- Payment summary
- Total in numbers and Indian-numbering words
- Loyalty points awarded/reversed
- “Computer generated invoice” footer

### 80mm receipt

- Render a dedicated print-only receipt component.
- Use `@media print` with an 80mm page size.
- Hide application navigation and controls during printing.
- Include concise item, tax, payment, invoice, and loyalty information.

Document values must come from persisted invoice snapshots, never current catalog values.

## 11. Failure Modes and Recovery

- Missing billing setup: block checkout and link to Settings.
- Edge Function unavailable/outdated: show the existing redeploy guidance.
- Duplicate finalize click/network retry: return the existing invoice via idempotency key.
- Catalog price changes during checkout: server response is authoritative; show changed lines and require confirmation before payment finalization.
- Payment mismatch: do not create an invoice.
- Customer membership removed between quote/finalize: offer walk-in checkout or require customer reselection.
- Loyalty notification failure: invoice remains successful; notification runs in the existing background mechanism.
- PDF generation failure: invoice remains stored; allow retry from Sales history.
- Refund exceeds remaining quantity: reject without partial mutation.
- Customer has fewer points than required reversal: reduce balance to zero, record actual reversal, and preserve an audit discrepancy field.

## 12. Migration and Deployment

1. Add the billing migration with tables, constraints, indexes, RLS, grants, and RPCs.
2. Apply the migration in Supabase.
3. Deploy the updated Edge Function from Make Settings.
4. Deploy the frontend.
5. Configure each business’s billing settings before its first invoice.

No seed invoices should be created in production. Development fixtures may be added only to local/test helpers.

## 13. Verification Strategy

### Calculation tests

Add Vitest and focused tests for:

- Inclusive GST at every supported rate.
- Exclusive GST at every supported rate.
- Intrastate CGST/SGST split with odd-paisa tax.
- Interstate IGST.
- Quantity with three-decimal precision.
- Line and cart discounts.
- Proportional discount allocation and rounding.
- Final total and split-payment equality.
- Points from final paid total and floor rounding.
- Full and partial refund calculations.

### Server integration tests

Verify against a non-production Supabase project:

- Business ownership isolation.
- Catalog uniqueness and deactivation.
- Atomic invoice numbering.
- Duplicate idempotency request.
- Concurrent finalization.
- Linked and walk-in invoices.
- Loyalty balance/activity updates.
- Customer notification creation.
- Full/partial credit notes.
- Refund overrun rejection.
- RLS/direct-client denial.

### UI verification

- Desktop, tablet, and mobile checkout layouts.
- Keyboard and barcode-scanner flow.
- Empty/loading/error states.
- Settings-required state.
- Exact split-payment validation.
- Invoice completion flow.
- Sales filters and pagination.
- Credit-note flow.
- 80mm print preview.
- A4 PDF content and totals.
- Existing RFID, NFC, rewards, notifications, and manual points workflows remain functional.

### Required commands

- Use the repository’s `pnpm build`.
- Run the added billing calculation tests.
- Do not start another development server; use the existing supervised server.

## 14. Delivery Sequence

1. Shared billing types and pure GST/discount calculator.
2. Supabase schema, RLS, counters, and atomic RPCs.
3. Edge Function settings/catalog/customer/quote endpoints.
4. Checkout UI and payment finalization.
5. Loyalty state/activity/notification integration.
6. Catalog management.
7. Sales history and invoice detail.
8. PDF and 80mm printing.
9. Credit notes and point reversal.
10. Responsive/accessibility polish and full regression verification.

## 15. Acceptance Criteria

- A business cannot finalize billing until valid GST seller settings exist.
- A bill can contain catalog and custom items with mixed GST rates and inclusive/exclusive pricing.
- Server and client totals match exactly in paise.
- Intrastate and interstate GST breakdowns are correct.
- Cash, UPI, card, and split payments are supported and must total the invoice amount.
- Finalized invoices receive unique fiscal-year invoice numbers and cannot be edited/deleted.
- Linked customers receive points based on the final paid total; walk-ins do not.
- Finalization is idempotent and cannot double-award points.
- Receipts print correctly at 80mm and invoices download as A4 PDF.
- Partial/full refunds create immutable credit notes and reverse tax and loyalty values.
- Business owners can view only their own catalog, settings, invoices, payments, and credit notes.
- Existing loyalty features continue to work without regression.
