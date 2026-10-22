# Perklyn NFC Point Issuance Plan

## Objective

Add a secure NFC point-issuance flow in which each business connects exactly one physical NFC card to its Perklyn business account, creates a one-time point issue valid for five minutes, and allows one signed-in customer to claim those points by tapping the card.

The claimed points must:

- Be credited to the correct business-specific customer balance.
- Never be claimable by more than one customer.
- Expire exactly five minutes after issue creation according to server time.
- Automatically connect the customer to the business if they are not already a member.
- Appear in the business portal only after a successful claim.
- Add to an `Issued by NFC` total for that customer.
- Be labeled as NFC-originated in customer activity/history.
- Never cross between businesses, even if multiple businesses issue points simultaneously.

## Confirmed Product Decisions

- One physical NFC card per business.
- One customer can claim each point issue.
- The customer sees a confirmation screen and must press `Claim points`.
- The claim must be completed within the original five-minute window; opening the NFC link does not reserve it.
- A customer who is not already connected is automatically joined to the business on successful claim.
- One active issue is allowed per NFC card at a time.
- The business must wait for the issue to be claimed, cancel it, or let it expire before creating another.
- Businesses can replace a lost or damaged card after an explicit confirmation.
- Replacing the card disables the old card and cancels its active issue when the new card is activated.
- The card uses a long, unguessable static Perklyn URL. The URL can technically be copied, but every point issue is one-time and expires in five minutes.
- Card setup uses Web NFC writing on supported Android Chrome/TWA devices.
- Unsupported devices receive a secure URL, QR code, and instructions for writing with NFC Tools or another NDEF-writing application.
- Point amount is an integer from 1 to 10,000.
- The business may add an optional internal reason.
- The business sees full live issue status: amount, reason, countdown, cancellation, claimed customer, and claimed time.
- Business reporting includes:
  - An `Issued by NFC` cumulative total for each customer.
  - An NFC source label on each claimed transaction.
- Unclaimed, cancelled, or expired issues do not affect customer totals or appear as issued transactions.

## Important NFC Architecture Constraint

The card will not be rewritten with a point amount for every issue. A browser/PWA cannot safely use a physical NFC tag as a mutable account balance.

Instead:

1. Perklyn writes one permanent secure URL to the business’s NFC card.
2. The URL identifies only that business card through a random secret token.
3. When the business issues points, the server creates a five-minute issue associated with that card.
4. A customer tap opens the permanent URL.
5. Perklyn resolves the card’s currently active server-side issue.
6. The customer confirms the claim.
7. A database transaction atomically marks the issue claimed and credits the customer.

This lets one physical card be reused indefinitely without rewriting it for each transaction.

## Platform Behavior

### Customer tap

The NFC card contains:

```text
https://www.perklyn.in/?nfc=<256-bit-random-token>
```

On Android with the installed Trusted Web Activity, the existing Digital Asset Links association should open Perklyn directly. Otherwise the URL opens the website.

The customer does not need Web NFC permission to tap an NDEF URL card; Android/iOS handles the URL at the operating-system level.

### Business card writing

Use the Web NFC `NDEFReader.write()` API when available:

- HTTPS only.
- Top-level page only.
- User gesture required.
- Primarily supported by Android Chrome and compatible Android TWA environments.
- NFC hardware and a writable NDEF tag are required.

No native Android NFC SDK is required for this version.

If Web NFC is unsupported, blocked, or the card is read-only:

- Show the secure provisioning URL once.
- Show a copy button.
- Show a QR code for transferring the URL to another device.
- Give concise instructions for writing it as a URL/NDEF record with NFC Tools.
- Let the business confirm activation after writing.

## Security Model and Limitations

- Generate tokens with at least 32 cryptographically random bytes and encode them as base64url.
- Store only a SHA-256 hash for active token lookup.
- During provisioning, store the raw token temporarily for no more than 30 minutes so the authenticated owner can write/copy it.
- Remove the raw token when activation completes or provisioning expires.
- Never log the raw token.
- Remove the `nfc` query parameter from browser history immediately after reading it and retain the token only in `sessionStorage` for the active claim flow.
- Use POST bodies, not query strings, when sending tokens to the Edge Function.
- Rate-limit token preview and claim endpoints.
- Never return customer identity in public preview responses.
- A copied NFC URL can be used remotely while an issue is active. The long token, one-time claim, five-minute expiry, and explicit customer confirmation reduce this risk but do not provide cryptographic anti-cloning.
- Strong anti-cloning would require secure NFC hardware and a native cryptographic challenge/response implementation, which is explicitly out of scope.

## Database Transaction Requirement

The current KV helper performs independent upserts and cannot guarantee that two simultaneous customers will not both claim the same issue.

Add:

```text
supabase/migrations/<timestamp>_nfc_point_issuance.sql
```

The migration will create transaction-safe PostgreSQL functions operating on `kv_store_3a123995`.

Execution permissions:

- Functions use `SECURITY DEFINER`.
- Set an explicit safe `search_path`.
- Revoke execution from `PUBLIC`, `anon`, and `authenticated`.
- Grant execution only to `service_role`.
- The Edge Function authenticates and authorizes users before invoking the functions.

### `perklyn_create_nfc_issue`

Parameters:

```text
p_active_key text
p_issue_key text
p_issue_value jsonb
```

Behavior:

1. Lock the card’s active-state row with `SELECT ... FOR UPDATE`.
2. Verify the card is active.
3. If a current issue exists, lock it.
4. If the current issue is pending and unexpired, return `active_issue_exists`.
5. If it is pending but expired, mark it expired.
6. Insert the new issue row.
7. Update the card’s active-state row with the new issue key.
8. Return the created issue.

This prevents duplicate issue creation from double clicks or concurrent requests.

### `perklyn_claim_nfc_issue`

Parameters:

```text
p_active_key text
p_issue_key text
p_membership_key text
p_membership_seed jsonb
p_claimant_user_id uuid
```

Behavior in one database transaction:

1. Lock the card active-state row.
2. Verify the requested issue is still the card’s current issue.
3. Lock the issue row.
4. Reject if status is claimed, cancelled, expired, or not pending.
5. Compare `expiresAt` against database `now()`, not browser time.
6. Mark expired and return `expired` when necessary.
7. Mark the issue claimed with:
   - `claimedByUserId`
   - `claimedAt`
   - Customer name and phone needed for business reporting
8. Lock or create the membership row:

```text
pending:<normalizedPhone>:<businessId>
```

9. Increase both:
   - `points`
   - `nfcPoints`
10. Preserve the business-specific membership structure and set `updatedAt`.
11. Return:
   - Issue ID and status
   - Business ID and owner ID
   - Claimed point amount
   - New balance
   - New cumulative NFC total
   - Whether a membership was created

The row lock guarantees exactly one claimant can succeed.

### `perklyn_cancel_nfc_issue`

Parameters:

```text
p_active_key text
p_issue_key text
p_owner_id uuid
```

Behavior:

1. Lock active and issue rows.
2. Confirm the issue belongs to the owner.
3. Cancel only when status is pending.
4. Reject claimed issues.
5. Mark the issue cancelled with server timestamp.

## KV Data Model

### Business-to-card mapping

Key:

```text
nfc-card-business:<businessId>
```

Value:

```ts
{
  businessId: number;
  cardId: string;
  ownerId: string;
  status: "active";
  activatedAt: string;
}
```

Exactly one active mapping may exist for a business.

### Card record

Key:

```text
nfc-card:<cardId>
```

Value:

```ts
{
  id: string;
  businessId: number;
  ownerId: string;
  tokenHash: string;
  status: "active" | "disabled";
  createdAt: string;
  activatedAt: string;
  disabledAt?: string;
  replacedByCardId?: string;
}
```

### Active token lookup

Key:

```text
nfc-card-token:<sha256Token>
```

Value:

```ts
{
  cardId: string;
  businessId: number;
  ownerId: string;
}
```

Delete this lookup when the card is replaced/disabled so the old physical card immediately stops resolving.

### Pending provisioning

Key:

```text
nfc-provision:<provisionId>
```

Value:

```ts
{
  id: string;
  businessId: number;
  ownerId: string;
  pendingCardId: string;
  rawToken: string;
  tokenHash: string;
  writeUrl: string;
  replacingCardId?: string;
  expiresAt: string;
  createdAt: string;
}
```

Provisioning expires after 30 minutes. It does not disable the current card until the new card is activated.

### Card active-state row

Key:

```text
nfc-active:<cardId>
```

Value:

```ts
{
  cardId: string;
  businessId: number;
  ownerId: string;
  currentIssueKey?: string;
  updatedAt: string;
}
```

This is the row locked by the database functions.

### Point issue

Key:

```text
nfc-issue:<issueId>
```

Value:

```ts
{
  id: string;
  cardId: string;
  businessId: number;
  ownerId: string;
  amount: number;
  reason?: string;
  status: "pending" | "claimed" | "expired" | "cancelled";
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
  claimedByUserId?: string;
  claimedCustomerName?: string;
  claimedCustomerPhone?: string;
  reconciledAt?: string;
}
```

Issue records remain as audit history.

### Reconciliation marker

Key:

```text
nfc-reconciled:<issueId>
```

Used to make post-claim business reporting, audit events, reverse membership indexing, and notifications idempotent.

## Backend API

All business management endpoints require an authenticated business user and verify ownership with `ownedBusiness`.

### `GET /nfc/card?businessId=<id>`

Returns the business’s current active card status and any unexpired pending provisioning. It never returns another business’s card.

### `POST /nfc/card/provision`

Body:

```ts
{
  businessId: number;
  replaceExisting?: boolean;
}
```

Behavior:

- Verify business ownership.
- Enforce one non-expired provisioning session per business.
- Generate card ID, 256-bit token, token hash, and write URL.
- If an active card exists, require `replaceExisting: true`.
- Do not disable the existing card yet.
- Save pending provisioning for 30 minutes.
- Return provisioning ID, write URL, expiry, and whether this is a replacement.
- Rate limit provisioning/replacement attempts.

### `POST /nfc/card/activate`

Body:

```ts
{
  businessId: number;
  provisionId: string;
}
```

Behavior:

- Verify owner and unexpired provisioning.
- Create the new card, token lookup, active-state row, and business mapping.
- If replacing:
  - Disable old card.
  - Delete old token lookup.
  - Cancel any pending old-card issue transactionally.
  - Mark replacement relationship.
- Delete the provisioning record/raw token.
- Return active card metadata.

### `DELETE /nfc/card/provision`

Cancel the owner’s pending provisioning and delete its raw token.

### `POST /nfc/issues`

Body:

```ts
{
  businessId: number;
  amount: number;
  reason?: string;
}
```

Validation:

- Integer amount from 1 to 10,000.
- Trim reason and limit to 100 characters.
- Business owns an active NFC card.
- Rate limit issue creation.

Call `perklyn_create_nfc_issue`. Return:

- Issue ID
- Amount/reason
- Server `createdAt`
- Server `expiresAt`
- `serverNow`

If another issue is pending, return HTTP 409 with the current issue rather than replacing it.

### `GET /nfc/issues/current?businessId=<id>`

Business-only.

Returns:

- Active card state.
- Current issue status.
- `serverNow`.
- Claimed customer details only to the owning business.

If a claimed issue is not reconciled, call the idempotent reconciliation helper before returning.

### `POST /nfc/issues/:id/cancel`

Business-only.

Verify ownership and call `perklyn_cancel_nfc_issue`. Return the cancelled issue.

### `POST /nfc/claim-preview`

Public endpoint using the anon bearer token accepted by the existing API wrapper.

Body:

```ts
{ token: string }
```

Behavior:

- Hash token and resolve active card.
- Rate limit by token hash and available client identifier.
- Return only:
  - Business name
  - Point amount
  - Issue ID
  - Status
  - Expires at
  - Server now
- Never expose owner ID, customer information, raw membership keys, internal reason, or token hash.
- Return explicit statuses:
  - `ready`
  - `no_active_issue`
  - `expired`
  - `claimed`
  - `cancelled`
  - `invalid_card`

### `POST /nfc/claim`

Customer-authenticated endpoint.

Body:

```ts
{ token: string }
```

Behavior:

1. Confirm authenticated profile role is customer.
2. Resolve active card and issue from token hash.
3. Load business and construct membership seed.
4. Call `perklyn_claim_nfc_issue`.
5. On success:
   - Ensure `business-member:<businessId>:<phone>` reverse index exists.
   - Reconcile business state and audit history.
   - Create `nfc_issued` activity exactly once using issue ID as the stable ID.
   - Add/update the customer in owner state with:
     - New balance
     - Cumulative `nfcPoints`
   - Send the existing customer point-change notification with NFC source.
   - Send a business operations inbox/push notification that the NFC issue was claimed.
6. Return:
   - Business summary
   - Claimed amount
   - New business-specific balance
   - New cumulative NFC total
   - Whether the customer was auto-joined

Never roll back the already committed balance because a notification fails.

## Idempotent Post-Claim Reconciliation

Create `reconcileNfcClaim(issue)`:

1. Check `nfc-reconciled:<issueId>`.
2. Load owner state.
3. Add/update the customer by normalized phone.
4. Set `points` to the authoritative membership balance.
5. Set `nfcPoints` to the authoritative membership NFC total.
6. Add one activity with stable ID `nfc:<issueId>` only if absent.
7. Activity:

```ts
{
  id: `nfc:${issueId}`;
  businessId: number;
  customerName: string;
  phone: string;
  type: "nfc_issued";
  source: "nfc";
  points: number;
  description: reason
    ? `NFC points issued: ${reason}`
    : "Points issued by NFC";
  occurredAt: claimedAt;
}
```

8. Save owner state.
9. Write audit record using the issue ID.
10. Write reconciliation marker.

Invoke after successful claim and whenever the business polls a claimed-but-unreconciled issue. This repairs temporary Edge Function failures without double-counting.

## Frontend URL and Authentication Flow

### Token capture

At application startup:

1. Read `nfc` from `window.location.search`.
2. Save it to `sessionStorage` under a Perklyn-specific key.
3. Immediately remove it from the address bar using `history.replaceState`.
4. Do not write it to localStorage or logs.

### Public claim landing

Before authentication:

- POST token to `/nfc/claim-preview`.
- Show business name, point amount, and server-synchronized countdown.
- Show `Sign in to claim`.
- Preserve token in sessionStorage.
- Guide the user into customer sign-in.
- Do not permit business accounts to claim.

If the customer is not signed in before expiry, the issue expires. The initial tap does not reserve it.

### Authenticated confirmation

After customer sign-in:

- Re-fetch preview from server.
- Show:
  - Business name
  - Point amount
  - Countdown
  - `Claim points` button
- Disable claim when expired or already claimed.
- On success:
  - Merge/add the business into the customer wallet.
  - Update balance.
  - Show an explicit success screen.
  - Clear token from sessionStorage.
- On failure:
  - Display server-authoritative claimed/expired/cancelled/invalid status.
  - Never optimistically add points.

If a business account is active, show `A customer account is required` with a sign-out/switch-account action while the same countdown continues.

## Business Portal UI

### Primary action

Add:

```text
Issue points by NFC
```

to:

- Business dashboard action row.
- Bottom island quick actions.

### No card connected

Show setup panel:

- Explanation that one reusable NFC card is linked to this business.
- `Set up NFC card`.
- Web NFC support status.
- Card-writing flow or manual fallback.

### Provisioning flow

1. Request provisioning URL from server.
2. If Web NFC supported:
   - Button: `Write Perklyn card`.
   - Call `NDEFReader.write()` only from button click.
   - Write one URL record.
   - Show success/failure.
3. Manual fallback:
   - Copy secure URL.
   - QR code.
   - NFC Tools instructions.
4. Button: `I wrote the card — activate`.
5. Activation confirms the card for the business.

If activation is not completed within 30 minutes, discard provisioning and require a new token.

### Active card and issue creation

Show:

- Card status: connected.
- Point input, integer 1–10,000.
- Optional internal reason, maximum 100 characters.
- `Issue points for 5 minutes`.
- Replace-card action behind a warning/confirmation.

### Pending issue

Show:

- Large amount.
- Server-synchronized countdown.
- Pending status.
- Cancel action.
- New issue controls disabled.
- Poll current issue every two seconds while the panel is open.

When countdown reaches zero, re-fetch server state before displaying expired.

### Claimed issue

Show:

- Success state.
- Claimed customer name.
- Claimed phone in owner-only business UI.
- Amount.
- Claimed time.
- Updated customer balance/NFC total.
- `Issue more points` action.

### Expired/cancelled issue

Show status and `Issue more points`.

## Business Reporting Changes

### Customer model

Extend:

```ts
type Customer = {
  // existing fields
  nfcPoints?: number;
};
```

Treat missing values as zero for existing customers.

### Activity model

Extend:

```ts
type Activity = {
  type: "issued" | "claimed" | "adjusted" | "nfc_issued";
  source?: "manual" | "nfc";
};
```

### Customer table

Add column:

```text
Issued by NFC
```

Behavior:

- Display `<amount> pts` only when `nfcPoints > 0`.
- Display an em dash for customers with no claimed NFC points.
- Do not count pending, cancelled, or expired issues.
- Maintain a readable mobile row layout.

### Customer detail and activity

- NFC transaction uses NFC/card icon styling.
- Label `Issued by NFC`.
- Positive point sign.
- Optional internal reason may be shown to the business.
- Customer-facing wallet activity should not expose the internal reason unless a later product decision makes it customer-visible.

### Summary/history calculations

- `Points issued` includes both `issued` and `nfc_issued`.
- History filters and totals include NFC transactions.
- Reward claim logic remains unchanged.

## Notifications

Extend notification types with:

```text
nfc_points_claimed
```

After claim reconciliation:

- Customer:
  - Existing `points_changed` notification.
  - Title: `NFC points added at <business>`
  - Body contains amount and new balance.
- Business:
  - `businessOperations` notification.
  - Title: `NFC points claimed`
  - Body identifies customer and amount.

Use issue-ID-based dedupe markers so retries do not create duplicate inbox entries or pushes.

## Rate Limits and Validation

- Provision card: maximum 5 attempts per business per hour.
- Activate card: maximum 10 attempts per business per hour.
- Create issue: maximum 30 issues per business per hour.
- Preview: maximum 120 requests per token hash per 15 minutes.
- Claim: maximum 10 attempts per customer per five minutes and maximum 20 per token hash per five minutes.
- Amount: integer 1–10,000.
- Reason: trimmed, maximum 100 characters, text only.
- Token: expected base64url shape and maximum length before hashing.
- Provisioning lifetime: 30 minutes.
- Claim lifetime: exactly 5 minutes from database/server creation time.

## Edge Cases

- Two customers claim simultaneously: SQL row lock permits one success; the other receives already claimed.
- Customer double taps Claim: first succeeds, second returns already claimed without duplicate points.
- Business double clicks Issue: transactional create returns the existing active issue.
- Customer taps with no active issue: show `No points are ready on this card`.
- Customer taps after expiry: mark/show expired; no credit.
- Customer logs in after expiry: no credit.
- Customer account is already joined: add points to existing membership.
- Customer is new to business: atomically create membership, add points, and add to owner customer list during reconciliation.
- Business account attempts claim: reject and offer account switch.
- Business A uses Business B token/card: ownership checks and card mapping prevent issue management; customer claim credits only the token’s mapped business.
- Old card after replacement: token lookup is removed and preview returns invalid card.
- Replacement activation fails: old card remains active.
- Active issue during replacement: old issue is cancelled only when the new card activates.
- NFC tag write fails/read-only tag: keep provisioning active and show retry/manual fallback.
- Unsupported iPhone/desktop writer: manual NFC Tools flow remains available.
- Lost browser state during setup: business can cancel/expire provisioning and generate a new one.
- App offline: show network-required state; never claim optimistically.
- Reconciliation fails after SQL claim: authoritative membership remains credited; later business polling retries reconciliation idempotently.
- Existing customers lack `nfcPoints`: treat as zero.

## Files Expected to Change

- `src/App.tsx`
- `src/index.css`
- New `src/nfc.ts` for Web NFC feature detection, NDEF writing, token session handling, and claim API helpers
- `src/notifications.ts` for new notification type/deep-link support
- `public/sw.js` only if NFC notification click behavior needs an additional URL target
- `supabase/functions/server/index.tsx`
- Optional new `supabase/functions/server/nfc.ts` to keep transaction/reconciliation logic isolated
- New `supabase/migrations/<timestamp>_nfc_point_issuance.sql`

Do not modify `kv_store.tsx` unless a small RPC helper is needed. Direct service-role Supabase RPC calls can be localized to the NFC server module.

## Verification Strategy

### Static checks

- `pnpm build`
- `git diff --check`
- Service-worker syntax check if modified.
- SQL migration syntax/review in Supabase before production.

### API and authorization checks

- Business cannot inspect, issue, cancel, replace, or activate another business’s card.
- Customer cannot call business NFC management endpoints.
- Business cannot claim customer points.
- Public preview returns no private owner/customer data.
- Invalid/oversized tokens are rejected before lookup.
- Old token stops working after card replacement.

### Atomicity tests

Use two authenticated customer sessions and send claim requests concurrently:

- Exactly one receives success.
- Exactly one membership balance increment occurs.
- Exactly one `nfcPoints` increment occurs.
- Exactly one activity/audit record exists.
- Issue status is claimed once.

Repeat with double-click requests from one customer.

### Expiry tests

- Claim at 4:59 succeeds if server receives it before expiry.
- Claim at or after 5:00 fails.
- Changing device clock does not change outcome.
- Login completed after expiry fails.

### Physical NFC tests

- Write a blank NDEF card from supported Android Chrome.
- Write using installed Perklyn TWA if Web NFC is available there.
- Use manual NFC Tools fallback.
- Tap card with Android while app installed; verify app-link opening.
- Tap card without app; verify website opening.
- Tap with iPhone; verify website opening.
- Test a read-only or incompatible tag and verify clear recovery guidance.

### Reporting tests

- Pending issue does not change customer table.
- Cancelled issue does not change customer table.
- Expired issue does not change customer table.
- Claimed issue updates balance and `Issued by NFC`.
- Existing manual point totals remain correct.
- History labels NFC source.
- Auto-joined customer appears once.

### Card isolation tests

Provision cards for two businesses:

- Each business sees only its own card/status.
- Each token resolves to the correct business.
- Simultaneous issues do not interfere.
- Replacing one card does not affect the other business.

## Deployment Sequence

1. Add and review the SQL migration.
2. Apply the migration to the Supabase project before deploying endpoints.
3. Deploy the updated Supabase Edge Function.
4. Verify transaction RPCs with test accounts.
5. Deploy frontend changes through GitHub/Vercel.
6. Hard-refresh/reopen installed PWA/TWA to load the new UI.
7. Provision a test NFC card.
8. Complete concurrency, expiry, replacement, and cross-business isolation tests.
9. Test on Play Internal Testing build.

Ordinary website/PWA changes do not require a new Android App Bundle because the package ID, domain, and native permissions are unchanged. If Web NFC writing is not available inside the TWA on a target device, the external NFC Tools fallback remains the supported setup path.

## Success Criteria

- One active NFC card is uniquely bound to each business.
- A business can issue 1–10,000 points for exactly five minutes.
- One and only one customer can claim.
- Unauthenticated customers can sign in and continue if time remains.
- New customers are auto-joined.
- Claims are atomic under concurrent requests.
- Claimed points update the correct business-specific balance.
- Only claimed issues contribute to `Issued by NFC`.
- Business activity clearly identifies NFC issuance.
- Old/replaced cards cannot claim or issue.
- Business cards and issues never cross between businesses.
- The flow works from the website, installed PWA, and Android TWA, with manual writing fallback where Web NFC is unavailable.

## Out of Scope

- Multi-use or unlimited-claim issues.
- Multiple NFC cards per business.
- Cryptographic anti-cloning secure NFC tags.
- Native Android NFC SDK integration.
- Offline claims.
- Customer-to-customer transfers.
- NFC-based reward redemption.
- Scheduled NFC issues.
