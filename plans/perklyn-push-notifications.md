# Perklyn Push Notifications Plan

## Objective

Add reliable push notifications that work across the Perklyn website, installed PWA, and Android Trusted Web Activity while continuing to use the existing Supabase project and shared account data.

The feature will include:

- Browser-standard Web Push using VAPID and the existing Supabase Edge Function.
- Automatic notifications for core loyalty events.
- Business broadcasts to opted-in members.
- An in-app notification inbox so messages remain available when push is blocked, missed, or delivered on another device.
- Per-category notification preferences.
- Notification click-through into the relevant Perklyn content.

## Confirmed Product Decisions

- Delivery provider: self-hosted Web Push through Supabase.
- Automatic events:
  - Customer receives a notification when points are added or deducted.
  - Customer receives a notification when an in-store reward claim is verified.
  - Business receives a notification when a customer joins.
  - Business receives a notification when a customer creates a reward claim.
- Businesses can create simple broadcasts for all opted-in members of one owned business.
- Broadcast limits:
  - Maximum 3 broadcasts per business in any rolling 24-hour period.
  - Title maximum 60 characters.
  - Message maximum 180 characters.
- Notifications are stored in an in-app inbox in addition to device/browser push.
- Normal website deployments continue to update the PWA/TWA automatically; no native notification SDK is required.

## Current Architecture Constraints

- The React/Vite frontend is primarily implemented in `src/App.tsx`.
- Supabase access is wrapped by `src/supabase.ts`.
- The PWA service worker is `public/sw.js`.
- The backend is a Hono Supabase Edge Function in `supabase/functions/server/index.tsx`.
- Persistent application data is stored through `supabase/functions/server/kv_store.tsx`.
- Membership keys are currently phone-first: `pending:<normalizedPhone>:<businessId>`.
- New accounts have a lookup record at `login:<role>:<normalizedPhone>` containing `userId` and auth email; legacy accounts may not yet have this lookup.
- The frontend does not use a router. Notification navigation must therefore use URL query parameters and application state rather than introducing a routing migration solely for this feature.

## VAPID and Environment Configuration

Add these Supabase Edge Function environment variables:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT=https://www.perklyn.in`

Generate one stable VAPID key pair and retain it permanently. Rotating it invalidates existing browser subscriptions and requires users to opt in again.

The private key must never be returned to the browser, logged, committed, or included in Vercel. The public key can be returned by an authenticated configuration endpoint.

Use `npm:web-push` from the Deno Edge Function to send standards-based Web Push messages. Configure VAPID once per request scope through a small helper.

## Data Model in the Existing KV Store

### Push subscriptions

Key:

```text
push-subscription:<userId>:<subscriptionId>
```

Value:

```ts
{
  id: string;
  userId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent: string;
  createdAt: string;
  updatedAt: string;
}
```

`subscriptionId` is a SHA-256 hash of the endpoint, not the raw endpoint. The endpoint remains inside the protected value.

Support multiple subscriptions per user so desktop, mobile browser, installed PWA, and TWA can all receive notifications.

### Notification preferences

Key:

```text
notification-preferences:<userId>
```

Value:

```ts
{
  pushEnabled: boolean;
  loyaltyActivity: boolean;
  businessUpdates: boolean;
  businessOperations: boolean;
  updatedAt: string;
}
```

Defaults:

- Customer:
  - `pushEnabled`: false until a subscription is created.
  - `loyaltyActivity`: true.
  - `businessUpdates`: true.
  - `businessOperations`: false.
- Business:
  - `pushEnabled`: false until a subscription is created.
  - `loyaltyActivity`: false.
  - `businessUpdates`: false.
  - `businessOperations`: true.

Customers can disable promotional/business broadcasts independently while retaining point and reward activity notifications. Businesses can disable join/claim operations notifications.

### Inbox notifications

Key:

```text
notification:<userId>:<reverseTimestamp>:<notificationId>
```

Use a reverse-sortable timestamp segment or sort returned records by `createdAt` descending. Each value contains:

```ts
{
  id: string;
  userId: string;
  type:
    | "points_changed"
    | "reward_claimed"
    | "reward_verified"
    | "member_joined"
    | "business_broadcast";
  category: "loyaltyActivity" | "businessUpdates" | "businessOperations";
  title: string;
  body: string;
  businessId?: number;
  businessName?: string;
  claimCode?: string;
  data?: Record<string, string | number | boolean>;
  readAt: string | null;
  createdAt: string;
}
```

Retain the newest 100 notifications per user. When writing a notification, prune older records asynchronously or during inbox reads.

### Business membership reverse index

Add:

```text
business-member:<businessId>:<normalizedPhone>
```

Value:

```ts
{
  businessId: number;
  phone: string;
  normalizedPhone: string;
  customerName: string;
  customerUserId?: string;
  joinedAt: string;
}
```

Write/update this index from:

- `/pending-membership`
- `/join-business`
- customer login when a matching membership already exists

For pre-existing memberships, broadcast lookup must temporarily fall back to scanning `pending:` records and lazily write missing reverse-index records. This avoids breaking existing customers while moving future sends to the scalable index.

### Broadcast campaign record

Key:

```text
notification-campaign:<businessId>:<createdAt>:<campaignId>
```

Value:

```ts
{
  id: string;
  businessId: number;
  ownerId: string;
  title: string;
  body: string;
  status: "queued" | "sending" | "complete" | "partial" | "failed";
  eligibleRecipients: number;
  inboxCreated: number;
  pushesAttempted: number;
  pushesDelivered: number;
  invalidSubscriptionsRemoved: number;
  createdAt: string;
  completedAt?: string;
}
```

Keep recent campaign records for the business composer status/history. Do not promise exact device delivery; “delivered” means accepted by the push service.

## Backend Helpers

Add focused helpers in `supabase/functions/server/index.tsx` or a new adjacent `push.ts` module if the Edge Function bundler supports the local import cleanly:

- `normalizePushSubscription(input)`
- `subscriptionId(endpoint)`
- `getNotificationPreferences(userId, role)`
- `resolveCustomerUserId(phone)`
- `ensureBusinessMemberIndex(...)`
- `createInboxNotification(userId, payload)`
- `getUserSubscriptions(userId)`
- `sendWebPushToUser(userId, payload)`
- `dispatchNotification(userId, role, payload)`
- `dispatchBusinessBroadcast(ownerId, businessId, campaign)`
- `removeInvalidSubscription(userId, subscriptionId)`

`dispatchNotification` must:

1. Check category preferences.
2. Write the inbox record even when browser push is unavailable, unless that category is disabled.
3. Send push only when `pushEnabled` is true and at least one subscription exists.
4. Treat notification failures as best effort; they must not roll back points, memberships, or reward transactions.
5. Remove subscriptions when the push provider returns HTTP 404 or 410.
6. Avoid logging endpoints, encryption keys, message bodies, or other sensitive subscription data.

Use batches of at most 25 parallel push requests. For broadcasts, queue the asynchronous send work with `EdgeRuntime.waitUntil` when available and fall back to awaiting it in environments without that API. Return HTTP 202 once the campaign is accepted.

## API Changes

All notification APIs require an authenticated user unless noted otherwise.

### `GET /push/config`

Returns:

```json
{
  "publicKey": "<VAPID_PUBLIC_KEY>",
  "supported": true
}
```

Return `supported: false` with an actionable server configuration error if VAPID variables are missing.

### `POST /push/subscriptions`

Body:

```ts
{
  subscription: PushSubscriptionJSON;
  userAgent?: string;
}
```

Validate:

- HTTPS endpoint.
- Allowed endpoint/body lengths.
- Presence and size of `p256dh` and `auth`.
- Rate limit subscription writes.

Upsert by endpoint hash and set `pushEnabled: true`.

### `DELETE /push/subscriptions`

Body:

```ts
{ endpoint: string }
```

Delete only a subscription owned by the authenticated user. If no subscriptions remain, update `pushEnabled` to false.

### `GET /notification-preferences`

Return role-appropriate defaults merged with stored preferences.

### `PUT /notification-preferences`

Allow only known boolean fields. Updating category preferences does not automatically request browser permission. Turning off the master push toggle unsubscribes the current device client-side and deletes that endpoint server-side.

### `GET /notifications?limit=30`

Return the newest notifications for the authenticated user, capped at 50 per request, plus:

```ts
{
  notifications: Notification[];
  unreadCount: number;
}
```

### `POST /notifications/:id/read`

Mark only the authenticated user’s notification as read.

### `POST /notifications/read-all`

Mark the current user’s latest retained notifications as read.

### `POST /business/:id/broadcast`

Business-only endpoint.

Body:

```ts
{
  title: string;
  body: string;
}
```

Validation and security:

- Confirm the user owns the business.
- Trim and reject empty title/body.
- Enforce 60/180-character limits.
- Enforce maximum 3 accepted broadcasts in a rolling 24-hour window.
- Rate limit repeated requests and reject duplicate payloads submitted within one minute.
- Resolve members only for the owned business.
- Include only customers with `businessUpdates` enabled.
- Create an inbox record for every eligible customer.
- Send push to all active subscriptions for those customers.
- Return campaign ID and eligible recipient count with HTTP 202.

### `GET /business/:id/campaigns`

Business-only endpoint returning the 10 most recent broadcasts for a business owned by the user.

## Automatic Event Hooks

### Point adjustment

After `/adjust-points` successfully persists the new balance:

- Resolve the customer user ID from `login:customer:<normalizedPhone>`.
- If found, create:
  - Positive delta title: `Points added at <businessName>`
  - Negative delta title: `Points updated at <businessName>`
  - Body includes absolute delta and new balance.
- Category: `loyaltyActivity`.
- Deep-link data: `businessId`, `balance`, and notification type.
- Do not fail the point operation if notification delivery fails.

### Customer joins a business

After `/join-business` creates a new membership:

- Notify the owning business user.
- Title: `New Perklyn member`
- Body: `<customerName> joined <businessName>.`
- Category: `businessOperations`.
- Do not notify again when the customer was already connected.

When a business manually adds a customer through `/pending-membership`, do not send “member joined” until the customer account is actually linked or the product explicitly introduces invitation notifications.

### Customer creates a reward claim

After `/claim-reward` persists the claim and deducts points:

- Notify the business owner.
- Title: `Reward claim ready`
- Body identifies the customer and reward.
- Include claim code in inbox detail data, but do not include the full code in lock-screen push text.
- Category: `businessOperations`.

The customer already sees the code in-app; no duplicate customer push is required at claim creation.

### Business verifies a claim

After `/verify-claim` marks the claim verified:

- Resolve the customer user ID from the claim phone.
- Notify the customer.
- Title: `Reward verified`
- Body: `<businessName> verified your <reward title>.`
- Category: `loyaltyActivity`.
- Include `businessId` and claim status in deep-link data.

## Legacy Account Repair

Update the existing `/login` flow so that, after successful authentication:

- If `login:<role>:<normalizedPhone>` does not exist, write it with the authenticated `userId` and actual auth email/legacy identifier.
- For customers, inspect existing phone-based memberships and populate `business-member` reverse-index entries with `customerUserId`.

This makes notification delivery work for existing accounts without requiring users to re-register.

## Frontend Push Subscription Module

Create `src/notifications.ts` for browser/service-worker integration:

- `isPushSupported()`
- `getNotificationPermission()`
- `requestAndSubscribeToPush()`
- `unsubscribeCurrentDevice()`
- `getCurrentPushSubscription()`
- `urlBase64ToUint8Array()`

Subscription flow:

1. Confirm service workers, `PushManager`, and `Notification` are supported.
2. Fetch `/push/config`.
3. Request browser permission only after a direct user click.
4. Wait for `navigator.serviceWorker.ready`.
5. Reuse an existing subscription or subscribe with `userVisibleOnly: true` and the VAPID public key.
6. POST the subscription to `/push/subscriptions`.
7. Return a clear UI state: enabled, denied, unsupported, or failed.

Never trigger the browser permission prompt automatically on page load.

## Service Worker Changes

Extend `public/sw.js` and increment its cache name.

### Push event

- Parse JSON payload safely.
- Use fallback title/body when payload is malformed.
- Display:
  - Perklyn icon: `/icons/perklyn-192.png`
  - Maskable/badge-compatible icon where supported.
  - `tag` based on notification ID to prevent accidental duplicates.
  - `data.url` as `/?notification=<notificationId>`.
- Do not display sensitive claim codes or phone numbers in lock-screen text.

### Notification click

- Close the notification.
- Find an existing same-origin Perklyn window and focus it, navigating to `data.url`.
- Otherwise open a new window at `data.url`.

Keep existing network-first fetch behavior so ordinary Vercel deployments remain automatically visible in the installed app.

## Frontend UI

### Permission prompt

After authenticated account load, show a non-blocking notification enable card when:

- Push is supported.
- Permission is `default`.
- The current account has not dismissed the soft prompt recently.

The card explains the value and provides:

- `Enable notifications`
- `Not now`

Persist prompt dismissal locally for 7 days. Only `Enable notifications` triggers the browser permission request.

If permission is denied, show instructions in Settings rather than repeatedly prompting.

### Notification bell and inbox

Add a bell action to `DashboardHeader` for both roles:

- Unread badge capped at `9+`.
- Opens a responsive notification panel.
- Fetches newest notifications on open and periodically while the app is focused.
- Supports mark-one-read and mark-all-read.
- Displays empty, loading, error, unsupported, and offline states.

Inbox item behavior:

- `points_changed` and `reward_verified`: open the associated customer business card when available.
- `member_joined` and `reward_claimed`: open the relevant business dashboard context; if the exact panel cannot be restored, open the notification detail and leave the user on the business dashboard.
- `business_broadcast`: open the associated business card for customers.
- Missing/deleted business data falls back to the inbox detail without crashing.

Because there is no router, use:

```text
/?notification=<notificationId>
```

On authenticated load, resolve the notification ID through the inbox API, mark it read, open the inbox panel, and then select the relevant business when present. Remove the query parameter with `history.replaceState` after it is consumed.

### Notification settings

Extend settings into role-aware notification controls:

Customer:

- Device push master state.
- Loyalty activity toggle.
- Business offers and updates toggle.

Business:

- Device push master state.
- New members and reward claims toggle.

Display browser-specific denied/unsupported guidance and a per-device unsubscribe action.

### Business broadcast composer

Add `Send notification` to the business dashboard primary actions and bottom island.

Composer contents:

- Selected owned business, fixed to the current business in the current single-business UI.
- Title input with live `0/60` counter.
- Message textarea with live `0/180` counter.
- Preview styled like an Android notification.
- Estimated eligible member count fetched from the server or returned by a lightweight audience endpoint.
- Send confirmation stating the number of recipients and that only opted-in members receive push.
- Disabled submit while sending.
- Success state with queued recipient count.
- Error states for rate limit, no eligible members, offline mode, and server failure.
- Recent campaign list showing status and accepted counts.

Do not allow arbitrary URLs, HTML, images, scripts, phone numbers from member records, or custom actions in business-authored pushes.

## Notification Payload Contract

Use a single payload shape between the Edge Function and service worker:

```ts
{
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  tag: string;
  url: string;
  businessId?: number;
  createdAt: string;
}
```

Keep payloads small and avoid confidential data because push-service payloads and lock-screen notifications should be treated as externally visible.

## Failure Modes and Required Behavior

- Browser unsupported: inbox remains available; settings explain that device push is unavailable.
- Permission denied: do not reprompt automatically; inbox continues to work.
- Subscription expired: remove it on HTTP 404/410 and continue other devices.
- Push provider error: record campaign as partial/failed; never roll back loyalty operations.
- Customer has no authenticated account: skip inbox/push until the phone is linked; do not expose account existence to the business UI.
- Customer has multiple devices: send to all active subscriptions; create only one inbox record.
- Duplicate subscription: endpoint hash upsert prevents duplicates.
- Duplicate business submit: reject same business/title/body within one minute.
- No eligible broadcast recipients: return a clear 400 response without consuming the daily quota.
- Offline client: cached app opens; inbox refresh and subscription operations show offline state and retry when online.
- Legacy customer: repair login and membership indexes during successful login.
- Missing VAPID configuration: subscription configuration endpoint reports unavailable; core app remains functional.

## Security and Privacy

- Authenticate every subscription, preference, inbox, campaign, and broadcast endpoint.
- Authorize business ownership server-side for broadcasts and campaign reads.
- Never accept a target user ID or recipient list from the business client.
- Never expose push endpoints or encryption keys in business APIs.
- Apply request size limits and rate limits.
- Escape all business-authored content by rendering it as text only.
- Store the minimum device metadata needed for support and cleanup.
- Provide unsubscribe and category controls.
- Mention push notifications and device subscription data in the Perklyn privacy policy before Play Store production release.

## Verification Plan

### Static/build verification

- Run `pnpm build`.
- Run `git diff --check`.
- Parse `public/manifest.webmanifest`.
- Run `node --check public/sw.js`.
- Verify icon and service-worker files remain in `dist`.

### Backend verification

- Verify VAPID environment variables are present.
- Deploy the updated Supabase Edge Function.
- Confirm `/push/config` returns only the public key.
- Confirm unauthenticated access to notification APIs is rejected.
- Confirm a business cannot broadcast for another owner’s business.
- Confirm daily limits and duplicate-send protection.
- Confirm malformed subscriptions are rejected.
- Confirm 404/410 push responses remove only the invalid subscription.

### Manual end-to-end matrix

Use separate customer and business accounts in separate browser profiles/devices:

1. Customer enables notifications and the subscription appears server-side.
2. Business enables operations notifications.
3. Customer joins a business; business receives push and inbox entry once.
4. Business adds points; customer receives the correct delta/new balance push and inbox entry.
5. Customer claims a reward; business receives a claim notification without exposing the claim code on the lock screen.
6. Business verifies the claim; customer receives a verified notification.
7. Business broadcasts a message; opted-in customer receives it and opted-out customer does not.
8. Broadcast appears once in each eligible inbox even for customers with multiple devices.
9. Clicking a push focuses an existing app window or opens Perklyn and displays the relevant inbox item/business.
10. Mark-one-read and mark-all-read update the badge.
11. Denied permission does not block inbox use or core loyalty flows.
12. Installed Android TWA receives pushes while closed and opens without a browser toolbar.
13. A normal website deployment still appears in the installed app without a new Play Store package.

### Browser coverage

- Chrome desktop.
- Chrome Android installed PWA.
- Android TWA/internal testing build.
- Edge desktop.
- Safari/iOS installed PWA where Web Push is supported; document that iOS requires home-screen installation and user permission.

## Deployment Sequence

1. Generate VAPID keys.
2. Add VAPID variables to the Supabase Edge Function environment.
3. Deploy backend subscription, inbox, broadcast, and automatic-event changes.
4. Deploy frontend/service-worker changes to Vercel.
5. Verify the live service worker has updated.
6. Test web and installed PWA subscriptions.
7. Build a new Android App Bundle only if PWABuilder/TWA packaging or native metadata changed; ordinary push logic and service-worker changes do not otherwise require a new bundle.
8. Test through Play Internal Testing.
9. Update privacy policy and Play Data Safety disclosures.
10. Roll out progressively after verifying rate limits and invalid-subscription cleanup.

## Expected Files to Change

- `src/App.tsx`
- `src/index.css`
- `src/main.tsx` only if notification bootstrap needs to be initialized there
- `src/notifications.ts` (new)
- `src/supabase.ts` only if a typed helper is needed
- `public/sw.js`
- `supabase/functions/server/index.tsx`
- Optional new server helper module adjacent to `index.tsx`
- Privacy/legal content files when those pages are added

## Out of Scope for This Version

- Scheduled campaigns.
- Customer segmentation beyond membership and opt-in status.
- Rich media pushes.
- Exact device-delivery or open-rate analytics.
- SMS, WhatsApp, or email campaign delivery.
- Admin moderation dashboard.
- Native Firebase/OneSignal SDK integration.
- Cross-business campaigns.
