import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";
import webpush from "npm:web-push@3.6.7";
import * as kv from "./kv_store.tsx";

const app = new Hono();
const prefix = "/make-server-3a123995";
const adminClient = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const normalizePhone = (phone: string) => phone.replace(/\D/g, "");
const legacyAccountEmail = (phone: string, role: string) => `${role}_phone_${normalizePhone(phone)}@loyaltyhub.local`;

const authenticatedUser = async (c: any) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await adminClient().auth.getUser(token);
  return error ? null : data.user;
};

const checkRateLimit = async (bucket: string, identifier: string, limit: number, windowMs: number) => {
  const key = `rate:${bucket}:${identifier}`;
  const now = Date.now();
  const current = await kv.get(key);
  if (!current || current.resetAt <= now) {
    await kv.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= limit) return false;
  await kv.set(key, { ...current, count: current.count + 1 });
  return true;
};

type NotificationCategory = "loyaltyActivity" | "businessUpdates" | "businessOperations";
type NotificationPayload = {
  type: "points_changed" | "reward_claimed" | "reward_verified" | "member_joined" | "business_broadcast" | "nfc_points_claimed";
  category: NotificationCategory;
  title: string;
  body: string;
  businessId?: number;
  businessName?: string;
  claimCode?: string;
  data?: Record<string, string | number | boolean>;
};

const notificationDefaults = (role: string) => ({
  pushEnabled: false,
  loyaltyActivity: role === "customer",
  businessUpdates: role === "customer",
  businessOperations: role === "business",
  updatedAt: new Date().toISOString(),
});

const getNotificationPreferences = async (userId: string, role: string) => ({
  ...notificationDefaults(role),
  ...(await kv.get(`notification-preferences:${userId}`) ?? {}),
});

const hashText = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const resolveCustomerUser = async (phone: string) => {
  const login = await kv.get(`login:customer:${normalizePhone(phone)}`);
  return login?.userId ? { userId: String(login.userId) } : null;
};

const saveInboxNotification = async (userId: string, payload: NotificationPayload) => {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const key = `notification:${userId}:${Date.now()}:${id}`;
  const notification = { id, userId, ...payload, readAt: null, createdAt, _key: key };
  await kv.set(key, notification);
  const retained = await kv.getByPrefix(`notification:${userId}:`);
  const overflow = retained.sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(100).filter((item: any) => item._key);
  if (overflow.length > 0) background(Promise.all(overflow.map((item: any) => kv.del(item._key))));
  return notification;
};

const configureWebPush = () => {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT") || "https://www.perklyn.in";
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return true;
};

const sendPushesToUser = async (userId: string, notification: any) => {
  if (!configureWebPush()) return { attempted: 0, delivered: 0, removed: 0 };
  const subscriptions = await kv.getByPrefix(`push-subscription:${userId}:`);
  let delivered = 0;
  let removed = 0;
  for (let start = 0; start < subscriptions.length; start += 25) {
    const batch = subscriptions.slice(start, start + 25);
    const results = await Promise.allSettled(batch.map(async (stored: any) => {
      try {
        await webpush.sendNotification(
          { endpoint: stored.endpoint, keys: stored.keys },
          JSON.stringify({
            id: notification.id,
            type: notification.type,
            title: notification.title,
            body: notification.body,
            tag: `perklyn-${notification.id}`,
            url: `/?notification=${notification.id}`,
            businessId: notification.businessId,
            createdAt: notification.createdAt,
          }),
        );
        delivered += 1;
      } catch (error: any) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          await kv.del(`push-subscription:${userId}:${stored.id}`);
          removed += 1;
          return;
        }
        throw error;
      }
    }));
    results.forEach((result) => {
      if (result.status === "rejected") console.log("Push delivery failed", result.reason?.statusCode ?? "unknown");
    });
  }
  return { attempted: subscriptions.length, delivered, removed };
};

const dispatchNotification = async (userId: string, role: string, payload: NotificationPayload) => {
  const preferences = await getNotificationPreferences(userId, role);
  if (!preferences[payload.category]) return null;
  const notification = await saveInboxNotification(userId, payload);
  const delivery = preferences.pushEnabled
    ? await sendPushesToUser(userId, notification)
    : { attempted: 0, delivered: 0, removed: 0 };
  return { notification, delivery };
};

const background = (promise: Promise<unknown>) => {
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(promise);
  else promise.catch((error) => console.log("Background notification failed", error));
};

const indexBusinessMember = async (businessId: number, customer: { phone: string; name?: string }, customerUserId?: string) => {
  const normalizedPhone = normalizePhone(customer.phone);
  if (!normalizedPhone) return;
  const key = `business-member:${businessId}:${normalizedPhone}`;
  const existing = await kv.get(key);
  await kv.set(key, {
    businessId,
    phone: customer.phone,
    normalizedPhone,
    customerName: customer.name ?? existing?.customerName ?? "Perklyn member",
    customerUserId: customerUserId ?? existing?.customerUserId,
    joinedAt: existing?.joinedAt ?? new Date().toISOString(),
  });
};

const ownedBusiness = async (businessId: number, userId: string) => {
  const business = await kv.get(`business:${businessId}`);
  return business?._ownerId === userId ? business : null;
};

const validNfcToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);
const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const nfcRpc = async (name: string, parameters: Record<string, unknown>) => {
  const { data, error } = await adminClient().rpc(name, parameters);
  if (error) throw error;
  return data;
};
const currentNfcIssue = async (card: any) => {
  const active = await kv.get(`nfc-active:${card.id}`);
  const issue = active?.currentIssueKey ? await kv.get(active.currentIssueKey) : null;
  if (issue?.status === "pending" && new Date(issue.expiresAt).getTime() <= Date.now()) {
    const result = await nfcRpc("perklyn_cancel_nfc_issue", {
      p_active_key: `nfc-active:${card.id}`,
      p_issue_key: active.currentIssueKey,
      p_owner_id: card.ownerId,
    });
    return result?.issue ?? { ...issue, status: "expired" };
  }
  return issue;
};

const reconcileNfcClaim = async (issue: any, balance: number, nfcPoints: number) => {
  if (await kv.get(`nfc-reconciled:${issue.id}`)) return;
  const ownerState = await kv.get(`state:${issue.ownerId}`) ?? {};
  const customers = Array.isArray(ownerState.customers) ? ownerState.customers : [];
  const customer = {
    id: Date.now(),
    name: issue.claimedCustomerName,
    phone: issue.claimedCustomerPhone,
    points: balance,
    nfcPoints,
    reward: "Welcome reward",
    joined: "Just now",
  };
  ownerState.customers = customers.some((item: any) => normalizePhone(item.phone) === normalizePhone(customer.phone))
    ? customers.map((item: any) => normalizePhone(item.phone) === normalizePhone(customer.phone) ? { ...item, points: balance, nfcPoints } : item)
    : [customer, ...customers];
  const activity = {
    id: `nfc:${issue.id}`,
    businessId: issue.businessId,
    customerName: issue.claimedCustomerName,
    phone: issue.claimedCustomerPhone,
    type: "nfc_issued",
    source: "nfc",
    points: issue.amount,
    description: issue.reason ? `NFC points issued: ${issue.reason}` : "Points issued by NFC",
    occurredAt: issue.claimedAt,
  };
  const activities = Array.isArray(ownerState.activities) ? ownerState.activities : [];
  ownerState.activities = activities.some((item: any) => item.id === activity.id) ? activities : [activity, ...activities];
  await kv.set(`state:${issue.ownerId}`, ownerState);
  await kv.set(`audit:${issue.businessId}:nfc:${issue.id}`, activity);
  await indexBusinessMember(Number(issue.businessId), { phone: issue.claimedCustomerPhone, name: issue.claimedCustomerName }, issue.claimedByUserId);
  await kv.set(`nfc-reconciled:${issue.id}`, { reconciledAt: new Date().toISOString() });
};

const validRfidIdentifier = (value: string) => /^[A-Za-z0-9:_-]{4,80}$/.test(value);
const maskRfidIdentifier = (value: string) => value.length <= 6 ? `••${value.slice(-2)}` : `${value.slice(0, 3)}••••${value.slice(-3)}`;
const maskPhone = (value: string) => {
  const digits = normalizePhone(value);
  return digits.length < 5 ? "••••" : `${digits.slice(0, 2)}${"•".repeat(Math.max(4, digits.length - 4))}${digits.slice(-2)}`;
};
const rfidCardKey = async (businessId: number, identifier: string) => `rfid-card:${businessId}:${await hashText(identifier.trim().toUpperCase())}`;
const reconcileRfidTransaction = async (card: any, transaction: any, balance: number) => {
  const ownerState = await kv.get(`state:${card.ownerId}`) ?? {};
  ownerState.customers = (ownerState.customers ?? []).map((customer: any) =>
    String(customer.id) === String(card.customerId) ? { ...customer, points: balance } : customer
  );
  const activities = Array.isArray(ownerState.activities) ? ownerState.activities : [];
  if (!activities.some((activity: any) => activity.id === transaction.id)) ownerState.activities = [transaction, ...activities];
  await kv.set(`state:${card.ownerId}`, ownerState);
};

const getBusinessAudience = async (businessId: number) => {
  const indexed = await kv.getByPrefix(`business-member:${businessId}:`);
  const members = new Map<string, any>();
  indexed.forEach((member: any) => members.set(member.normalizedPhone, member));
  const legacy = await kv.getByPrefix("pending:");
  await Promise.all(legacy.filter((membership: any) => Number(membership.business?.id) === businessId).map(async (membership: any) => {
    const normalizedPhone = normalizePhone(membership.phone);
    if (members.has(normalizedPhone) && members.get(normalizedPhone)?.customerUserId) return;
    const login = await resolveCustomerUser(membership.phone);
    const member = {
      businessId,
      phone: membership.phone,
      normalizedPhone,
      customerName: membership.customerName,
      customerUserId: login?.userId,
      joinedAt: membership.updatedAt ?? new Date().toISOString(),
    };
    members.set(normalizedPhone, member);
    await indexBusinessMember(businessId, { phone: membership.phone, name: membership.customerName }, login?.userId);
  }));
  const audience = [];
  for (const member of members.values()) {
    const userId = member.customerUserId ?? (await resolveCustomerUser(member.phone))?.userId;
    if (!userId) continue;
    const preferences = await getNotificationPreferences(userId, "customer");
    if (preferences.businessUpdates) audience.push({ ...member, customerUserId: userId });
  }
  return audience;
};

app.use("*", logger(console.log));
app.use("/*", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  exposeHeaders: ["Content-Length"],
  maxAge: 600,
}));
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
});
app.onError((error: any, c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Content-Type", "application/json");
  const databaseSetupMissing =
    error?.code === "PGRST202" ||
    String(error?.message ?? "").includes("perklyn_create_nfc_issue") ||
    String(error?.message ?? "").includes("perklyn_claim_nfc_issue") ||
    String(error?.message ?? "").includes("perklyn_cancel_nfc_issue") ||
    String(error?.message ?? "").includes("perklyn_activate_rfid_card") ||
    String(error?.message ?? "").includes("perklyn_rfid_points_transaction");
  if (databaseSetupMissing) {
    console.log("NFC database functions are not installed", error?.code ?? "missing_rpc");
    return c.json({ error: "NFC database setup is incomplete. Apply the latest Supabase migration, then redeploy the Edge Function." }, 503);
  }
  console.log("Unhandled server request failed", error?.code ?? error?.name ?? "unknown");
  return c.json({ error: "The Perklyn server could not complete this request. Try again shortly." }, 500);
});

app.get(`${prefix}/health`, (c) => c.json({ status: "ok" }));

app.post(`${prefix}/signup`, async (c) => {
  try {
    const body = await c.req.json();
    const { role, name, businessName = "", phone, email, password, authorizationCode = "" } = body;
    if (!["customer", "business"].includes(role) || !name || !phone || !email || !password) return c.json({ error: "Missing required account information." }, 400);
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return c.json({ error: "Enter a valid recovery email address." }, 400);
    if (!await checkRateLimit("signup", `${role}:${normalizePhone(phone)}`, 5, 60 * 60 * 1000)) return c.json({ error: "Too many signup attempts for this phone number. Try again later." }, 429);
    if (await kv.get(`login:${role}:${normalizePhone(phone)}`)) return c.json({ error: "An account already exists for this phone number." }, 409);
    if (password.length < 10) return c.json({ error: "Password must contain at least 10 characters." }, 400);
    if (role === "business") {
      const configuredCode = Deno.env.get("BUSINESS_AUTH_CODE");
      if (!configuredCode || authorizationCode !== configuredCode) return c.json({ error: "The business authorization code is invalid." }, 403);
    }
    const { data, error } = await adminClient().auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
      user_metadata: { role, name, phone, email: normalizedEmail, businessName },
    });
    if (error) {
      const duplicate = error.message.toLowerCase().includes("already");
      return c.json({ error: duplicate ? "An account already exists for this email address." : error.message }, duplicate ? 409 : 400);
    }
    const profile = { id: data.user.id, role, name, phone, email: normalizedEmail, businessName, createdAt: new Date().toISOString() };
    await kv.mset(
      [`profile:${data.user.id}`, `login:${role}:${normalizePhone(phone)}`],
      [profile, { email: normalizedEmail, userId: data.user.id }],
    );
    return c.json({ profile });
  } catch (error) {
    console.log("Signup error", error);
    return c.json({ error: "Unable to create the account." }, 500);
  }
});

app.post(`${prefix}/login`, async (c) => {
  const { role = "", phone: suppliedPhone = "", password = "" } = await c.req.json();
  const phone = normalizePhone(suppliedPhone);
  if (!["customer", "business"].includes(role) || !phone) return c.json({ error: "Role and phone number are required." }, 400);
  if (!password) return c.json({ error: "Password is required." }, 400);
  if (!await checkRateLimit("login", `${role}:${phone}`, 20, 15 * 60 * 1000)) return c.json({ error: "Too many login attempts. Try again later." }, 429);
  const login = await kv.get(`login:${role}:${phone}`);
  let { data, error } = await adminClient().auth.signInWithPassword({
    email: login?.email ?? legacyAccountEmail(phone, role),
    password,
  });
  if (error && !login) {
    const legacyResult = await adminClient().auth.signInWithPassword({
      email: `phone_${phone}@loyaltyhub.local`,
      password,
    });
    data = legacyResult.data;
    error = legacyResult.error;
  }
  if (error || !data.session) return c.json({ error: "The phone number or password is incorrect." }, 401);
  if (!login && data.user) {
    await kv.set(`login:${role}:${phone}`, { email: data.user.email, userId: data.user.id });
    if (role === "customer") {
      const memberships = await kv.getByPrefix(`pending:${phone}:`);
      await Promise.all(memberships.map((membership: any) => indexBusinessMember(Number(membership.business?.id), { phone: suppliedPhone, name: membership.customerName }, data.user.id)));
    }
  }
  return c.json({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token });
});

app.get(`${prefix}/push/config`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  return c.json({ publicKey: publicKey ?? "", supported: Boolean(publicKey && Deno.env.get("VAPID_PRIVATE_KEY")) });
});

app.post(`${prefix}/push/subscriptions`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (!await checkRateLimit("push-subscription", user.id, 20, 60 * 60 * 1000)) return c.json({ error: "Too many subscription changes. Try again later." }, 429);
  const { subscription, userAgent = "" } = await c.req.json();
  const endpoint = String(subscription?.endpoint ?? "");
  const p256dh = String(subscription?.keys?.p256dh ?? "");
  const auth = String(subscription?.keys?.auth ?? "");
  if (!endpoint.startsWith("https://") || endpoint.length > 4096 || !p256dh || p256dh.length > 512 || !auth || auth.length > 256) return c.json({ error: "Invalid push subscription." }, 400);
  const id = await hashText(endpoint);
  await kv.set(`push-subscription:${user.id}:${id}`, {
    id,
    userId: user.id,
    endpoint,
    keys: { p256dh, auth },
    userAgent: String(userAgent).slice(0, 300),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const profile = await kv.get(`profile:${user.id}`) ?? user.user_metadata ?? {};
  const preferences = await getNotificationPreferences(user.id, profile.role);
  await kv.set(`notification-preferences:${user.id}`, { ...preferences, pushEnabled: true, updatedAt: new Date().toISOString() });
  return c.json({ subscribed: true });
});

app.delete(`${prefix}/push/subscriptions`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { endpoint = "" } = await c.req.json();
  if (!endpoint) return c.json({ error: "Subscription endpoint is required." }, 400);
  await kv.del(`push-subscription:${user.id}:${await hashText(String(endpoint))}`);
  const remaining = await kv.getByPrefix(`push-subscription:${user.id}:`);
  if (remaining.length === 0) {
    const profile = await kv.get(`profile:${user.id}`) ?? user.user_metadata ?? {};
    const preferences = await getNotificationPreferences(user.id, profile.role);
    await kv.set(`notification-preferences:${user.id}`, { ...preferences, pushEnabled: false, updatedAt: new Date().toISOString() });
  }
  return c.json({ subscribed: remaining.length > 0 });
});

app.get(`${prefix}/notification-preferences`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const profile = await kv.get(`profile:${user.id}`) ?? user.user_metadata ?? {};
  return c.json({ preferences: await getNotificationPreferences(user.id, profile.role) });
});

app.put(`${prefix}/notification-preferences`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const profile = await kv.get(`profile:${user.id}`) ?? user.user_metadata ?? {};
  const current = await getNotificationPreferences(user.id, profile.role);
  const body = await c.req.json();
  const next: any = { ...current };
  for (const field of ["pushEnabled", "loyaltyActivity", "businessUpdates", "businessOperations"]) {
    if (typeof body[field] === "boolean") next[field] = body[field];
  }
  next.updatedAt = new Date().toISOString();
  await kv.set(`notification-preferences:${user.id}`, next);
  return c.json({ preferences: next });
});

app.get(`${prefix}/notifications`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 30)));
  const all = await kv.getByPrefix(`notification:${user.id}:`);
  const sorted = all.sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const notifications = sorted.slice(0, limit).map(({ _key, userId, ...notification }: any) => notification);
  return c.json({ notifications, unreadCount: sorted.filter((item: any) => !item.readAt).length });
});

app.post(`${prefix}/notifications/:id/read`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const all = await kv.getByPrefix(`notification:${user.id}:`);
  const notification = all.find((item: any) => item.id === id);
  if (!notification?._key) return c.json({ error: "Notification not found." }, 404);
  notification.readAt = notification.readAt ?? new Date().toISOString();
  await kv.set(notification._key, notification);
  const { _key, userId, ...safeNotification } = notification;
  return c.json({ notification: safeNotification });
});

app.post(`${prefix}/notifications/read-all`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const all = await kv.getByPrefix(`notification:${user.id}:`);
  const unread = all.filter((item: any) => !item.readAt && item._key);
  if (unread.length > 0) await kv.mset(unread.map((item: any) => item._key), unread.map((item: any) => ({ ...item, readAt: new Date().toISOString() })));
  return c.json({ updated: unread.length });
});

app.get(`${prefix}/business/:id/notification-audience`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const businessId = Number(c.req.param("id"));
  if (!await ownedBusiness(businessId, user.id)) return c.json({ error: "You do not own this business." }, 403);
  const audience = await getBusinessAudience(businessId);
  return c.json({ eligibleRecipients: audience.length });
});

app.get(`${prefix}/business/:id/campaigns`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const businessId = Number(c.req.param("id"));
  if (!await ownedBusiness(businessId, user.id)) return c.json({ error: "You do not own this business." }, 403);
  const campaigns = await kv.getByPrefix(`notification-campaign:${businessId}:`);
  return c.json({ campaigns: campaigns.sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 10) });
});

app.post(`${prefix}/business/:id/broadcast`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const businessId = Number(c.req.param("id"));
  const business = await ownedBusiness(businessId, user.id);
  if (!business) return c.json({ error: "You do not own this business." }, 403);
  if (!await checkRateLimit("broadcast-submit", user.id, 10, 60 * 60 * 1000)) return c.json({ error: "Too many notification requests. Try again later." }, 429);
  const body = await c.req.json();
  const title = String(body.title ?? "").trim();
  const message = String(body.body ?? "").trim();
  if (!title || !message) return c.json({ error: "A title and message are required." }, 400);
  if (title.length > 60 || message.length > 180) return c.json({ error: "Keep the title under 60 characters and the message under 180 characters." }, 400);
  const campaigns = await kv.getByPrefix(`notification-campaign:${businessId}:`);
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = campaigns.filter((campaign: any) => new Date(campaign.createdAt).getTime() >= oneDayAgo);
  if (recent.length >= 3) return c.json({ error: "This business has reached its limit of 3 notifications in 24 hours." }, 429);
  if (campaigns.some((campaign: any) => campaign.title === title && campaign.body === message && Date.now() - new Date(campaign.createdAt).getTime() < 60_000)) return c.json({ error: "This notification was already submitted." }, 409);
  const audience = await getBusinessAudience(businessId);
  if (audience.length === 0) return c.json({ error: "There are no opted-in members to notify yet." }, 400);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const campaignKey = `notification-campaign:${businessId}:${Date.now()}:${id}`;
  const campaign = {
    id,
    businessId,
    ownerId: user.id,
    title,
    body: message,
    status: "queued",
    eligibleRecipients: audience.length,
    inboxCreated: 0,
    pushesAttempted: 0,
    pushesDelivered: 0,
    invalidSubscriptionsRemoved: 0,
    createdAt,
  };
  await kv.set(campaignKey, campaign);
  background((async () => {
    const totals = { inboxCreated: 0, pushesAttempted: 0, pushesDelivered: 0, invalidSubscriptionsRemoved: 0 };
    await kv.set(campaignKey, { ...campaign, status: "sending" });
    for (const member of audience) {
      const result = await dispatchNotification(member.customerUserId, "customer", {
        type: "business_broadcast",
        category: "businessUpdates",
        title,
        body: message,
        businessId,
        businessName: business.name,
      });
      if (!result) continue;
      totals.inboxCreated += 1;
      totals.pushesAttempted += result.delivery.attempted;
      totals.pushesDelivered += result.delivery.delivered;
      totals.invalidSubscriptionsRemoved += result.delivery.removed;
    }
    await kv.set(campaignKey, {
      ...campaign,
      ...totals,
      status: totals.inboxCreated === audience.length ? "complete" : "partial",
      completedAt: new Date().toISOString(),
    });
  })());
  return c.json({ campaignId: id, eligibleRecipients: audience.length, status: "queued" }, 202);
});

app.get(`${prefix}/me`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const [profile, state] = await Promise.all([kv.get(`profile:${user.id}`), kv.get(`state:${user.id}`)]);
  return c.json({ profile: profile ?? user.user_metadata, state: state ?? null });
});

app.put(`${prefix}/state`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const state = await c.req.json();
  if (JSON.stringify(state).length > 1_000_000) return c.json({ error: "Account state is too large." }, 413);
  await kv.set(`state:${user.id}`, state);
  const profile = await kv.get(`profile:${user.id}`);
  if (profile?.role === "business" && Array.isArray(state.businesses)) {
    await Promise.all(state.businesses.map((business: any) => kv.set(`business:${business.id}`, { ...business, _ownerId: user.id })));
  }
  return c.json({ saved: true });
});

app.post(`${prefix}/pending-membership`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const profile = await kv.get(`profile:${user.id}`);
  if (profile?.role !== "business") return c.json({ error: "Only businesses can add customers." }, 403);
  const { customer, business } = await c.req.json();
  if (!customer?.phone || !business?.id) return c.json({ error: "Customer phone and business are required." }, 400);
  const storedBusiness = await ownedBusiness(Number(business.id), user.id);
  if (!storedBusiness) return c.json({ error: "You do not own this business." }, 403);
  await kv.set(`pending:${normalizePhone(customer.phone)}:${business.id}`, {
    business: storedBusiness,
    ownerId: user.id,
    customerName: customer.name,
    phone: customer.phone,
    points: customer.points ?? 0,
    reward: customer.reward ?? "Welcome reward",
    updatedAt: new Date().toISOString(),
  });
  const customerLogin = await resolveCustomerUser(customer.phone);
  await indexBusinessMember(Number(business.id), { phone: customer.phone, name: customer.name }, customerLogin?.userId);
  return c.json({ saved: true });
});

app.post(`${prefix}/adjust-points`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const profile = await kv.get(`profile:${user.id}`);
  if (profile?.role !== "business") return c.json({ error: "Only businesses can adjust points." }, 403);
  if (!await checkRateLimit("points", user.id, 120, 60 * 1000)) return c.json({ error: "Too many point updates. Wait a moment and try again." }, 429);
  const { businessId, phone, delta } = await c.req.json();
  const amount = Number(delta);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) return c.json({ error: "Enter a valid point amount." }, 400);
  const business = await ownedBusiness(Number(businessId), user.id);
  if (!business) return c.json({ error: "You do not own this business." }, 403);
  const membershipKey = `pending:${normalizePhone(phone)}:${businessId}`;
  const membership = await kv.get(membershipKey);
  if (!membership || membership.ownerId !== user.id) return c.json({ error: "This customer is not connected to your business." }, 404);
  const balance = Math.max(0, Number(membership.points ?? 0) + amount);
  membership.points = balance;
  membership.updatedAt = new Date().toISOString();
  await kv.set(membershipKey, membership);
  const transaction = { id: crypto.randomUUID(), businessId, customerName: membership.customerName, phone: membership.phone, type: amount > 0 ? "issued" : "adjusted", points: Math.abs(amount), delta: amount, description: amount > 0 ? "Points issued by business" : "Manual point adjustment", occurredAt: new Date().toISOString() };
  await kv.set(`audit:${businessId}:${Date.now()}:${transaction.id}`, transaction);
  const ownerState = await kv.get(`state:${user.id}`) ?? {};
  ownerState.customers = (ownerState.customers ?? []).map((customer: any) => normalizePhone(customer.phone) === normalizePhone(phone) ? { ...customer, points: balance } : customer);
  ownerState.activities = [transaction, ...(ownerState.activities ?? [])];
  await kv.set(`state:${user.id}`, ownerState);
  const customerLogin = await resolveCustomerUser(phone);
  if (customerLogin) {
    background(dispatchNotification(customerLogin.userId, "customer", {
      type: "points_changed",
      category: "loyaltyActivity",
      title: amount > 0 ? `Points added at ${business.name}` : `Points updated at ${business.name}`,
      body: `${Math.abs(amount).toLocaleString()} points ${amount > 0 ? "added" : "deducted"}. New balance: ${balance.toLocaleString()} points.`,
      businessId: Number(businessId),
      businessName: business.name,
      data: { balance, delta: amount },
    }));
  }
  return c.json({ balance, transaction });
});

app.get(`${prefix}/pending-memberships`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const profile = await kv.get(`profile:${user.id}`);
  if (!profile?.phone) return c.json({ memberships: [] });
  const memberships = await kv.getByPrefix(`pending:${normalizePhone(profile.phone)}:`);
  const hydrated = await Promise.all(memberships.map(async (membership: any) => ({ ...membership, business: await kv.get(`business:${membership.business.id}`) ?? membership.business })));
  return c.json({ memberships: hydrated });
});

app.get(`${prefix}/customer-balance`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const profile = await kv.get(`profile:${user.id}`);
  if (profile?.role !== "business") return c.json({ error: "Only businesses can view customer balances." }, 403);
  const businessId = Number(c.req.query("businessId"));
  const phone = c.req.query("phone") ?? "";
  if (!businessId || !phone) return c.json({ error: "Business and customer phone are required." }, 400);
  if (!await ownedBusiness(businessId, user.id)) return c.json({ error: "You do not own this business." }, 403);
  const membership = await kv.get(`pending:${normalizePhone(phone)}:${businessId}`);
  if (!membership || membership.ownerId !== user.id) return c.json({ error: "Customer membership not found." }, 404);
  const ownerState = await kv.get(`state:${user.id}`) ?? {};
  const activities = (ownerState.activities ?? []).filter((activity: any) => Number(activity.businessId) === businessId && normalizePhone(activity.phone) === normalizePhone(phone));
  return c.json({ balance: Number(membership.points ?? 0), updatedAt: membership.updatedAt, activities });
});

app.get(`${prefix}/business/:id`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const business = await kv.get(`business:${c.req.param("id")}`);
  if (!business) return c.json({ error: "This business QR code is not active." }, 404);
  return c.json({ business });
});

app.post(`${prefix}/join-business`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const profile = await kv.get(`profile:${user.id}`);
  if (profile?.role !== "customer") return c.json({ error: "Only customers can join businesses." }, 403);
  const { businessId } = await c.req.json();
  const business = await kv.get(`business:${businessId}`);
  if (!business) return c.json({ error: "This business QR code is not active." }, 404);
  const key = `pending:${normalizePhone(profile.phone)}:${business.id}`;
  const existing = await kv.get(key);
  if (!existing) {
    await kv.set(key, { business, ownerId: business._ownerId, customerName: profile.name, phone: profile.phone, points: 0, reward: "Welcome reward", updatedAt: new Date().toISOString() });
    if (business._ownerId) {
      const ownerState = await kv.get(`state:${business._ownerId}`) ?? {};
      const customers = Array.isArray(ownerState.customers) ? ownerState.customers : [];
      if (!customers.some((customer: any) => normalizePhone(customer.phone) === normalizePhone(profile.phone))) {
        ownerState.customers = [{ id: Date.now(), name: profile.name, phone: profile.phone, points: 0, reward: "Welcome reward", joined: "Just now" }, ...customers];
        await kv.set(`state:${business._ownerId}`, ownerState);
      }
    }
    await indexBusinessMember(Number(business.id), { phone: profile.phone, name: profile.name }, user.id);
    if (business._ownerId) {
      background(dispatchNotification(String(business._ownerId), "business", {
        type: "member_joined",
        category: "businessOperations",
        title: "New Perklyn member",
        body: `${profile.name} joined ${business.name}.`,
        businessId: Number(business.id),
        businessName: business.name,
      }));
    }
  } else {
    await indexBusinessMember(Number(business.id), { phone: profile.phone, name: profile.name }, user.id);
  }
  return c.json({ business, membership: existing ?? { points: 0, reward: "Welcome reward" } });
});

app.get(`${prefix}/nfc/card`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const businessId = Number(c.req.query("businessId"));
  if (!await ownedBusiness(businessId, user.id)) return c.json({ error: "You do not own this business." }, 403);
  const mapping = await kv.get(`nfc-card-business:${businessId}`);
  const card = mapping?.cardId ? await kv.get(`nfc-card:${mapping.cardId}`) : null;
  const provisions = await kv.getByPrefix("nfc-provision:");
  await Promise.all(provisions.filter((item: any) => new Date(item.expiresAt).getTime() <= Date.now()).map((item: any) => kv.del(`nfc-provision:${item.id}`)));
  const provision = provisions.find((item: any) =>
    Number(item.businessId) === businessId &&
    item.ownerId === user.id &&
    new Date(item.expiresAt).getTime() > Date.now()
  );
  return c.json({
    card: card?.status === "active" ? { id: card.id, status: card.status, activatedAt: card.activatedAt } : null,
    provision: provision ? {
      id: provision.id,
      writeUrl: provision.writeUrl,
      expiresAt: provision.expiresAt,
      replacing: Boolean(provision.replacingCardId),
    } : null,
  });
});

app.post(`${prefix}/nfc/card/provision`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { businessId: rawBusinessId, replaceExisting = false } = await c.req.json();
  const businessId = Number(rawBusinessId);
  if (!await ownedBusiness(businessId, user.id)) return c.json({ error: "You do not own this business." }, 403);
  if (!await checkRateLimit("nfc-provision", `${user.id}:${businessId}`, 5, 60 * 60 * 1000)) return c.json({ error: "Too many card setup attempts. Try again later." }, 429);
  const mapping = await kv.get(`nfc-card-business:${businessId}`);
  if (mapping?.cardId && !replaceExisting) return c.json({ error: "This business already has an NFC card." }, 409);
  const provisions = await kv.getByPrefix("nfc-provision:");
  const existing = provisions.find((item: any) => Number(item.businessId) === businessId && item.ownerId === user.id && new Date(item.expiresAt).getTime() > Date.now());
  if (existing) return c.json({ provision: { id: existing.id, writeUrl: existing.writeUrl, expiresAt: existing.expiresAt, replacing: Boolean(existing.replacingCardId) } });
  const id = crypto.randomUUID();
  const pendingCardId = crypto.randomUUID();
  const rawToken = randomToken();
  const tokenHash = await hashText(rawToken);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const writeUrl = `https://www.perklyn.in/?nfc=${rawToken}`;
  await kv.set(`nfc-provision:${id}`, {
    id,
    businessId,
    ownerId: user.id,
    pendingCardId,
    rawToken,
    tokenHash,
    writeUrl,
    replacingCardId: mapping?.cardId,
    createdAt,
    expiresAt,
  });
  return c.json({ provision: { id, writeUrl, expiresAt, replacing: Boolean(mapping?.cardId) } }, 201);
});

app.delete(`${prefix}/nfc/card/provision`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { businessId, provisionId } = await c.req.json();
  if (!await ownedBusiness(Number(businessId), user.id)) return c.json({ error: "You do not own this business." }, 403);
  const provision = await kv.get(`nfc-provision:${provisionId}`);
  if (provision?.ownerId === user.id && Number(provision.businessId) === Number(businessId)) await kv.del(`nfc-provision:${provisionId}`);
  return c.json({ cancelled: true });
});

app.post(`${prefix}/nfc/card/activate`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { businessId: rawBusinessId, provisionId } = await c.req.json();
  const businessId = Number(rawBusinessId);
  if (!await ownedBusiness(businessId, user.id)) return c.json({ error: "You do not own this business." }, 403);
  if (!await checkRateLimit("nfc-activate", `${user.id}:${businessId}`, 10, 60 * 60 * 1000)) return c.json({ error: "Too many activation attempts. Try again later." }, 429);
  const provision = await kv.get(`nfc-provision:${provisionId}`);
  if (!provision || provision.ownerId !== user.id || Number(provision.businessId) !== businessId) return c.json({ error: "Card setup was not found." }, 404);
  if (new Date(provision.expiresAt).getTime() <= Date.now()) {
    await kv.del(`nfc-provision:${provisionId}`);
    return c.json({ error: "This card setup expired. Start again." }, 410);
  }
  const currentMapping = await kv.get(`nfc-card-business:${businessId}`);
  if (currentMapping?.cardId && currentMapping.cardId !== provision.replacingCardId) {
    return c.json({ error: "Another NFC card was activated for this business. Start replacement setup to change it." }, 409);
  }
  if (provision.replacingCardId && currentMapping?.cardId !== provision.replacingCardId) {
    return c.json({ error: "The active NFC card changed during setup. Start again." }, 409);
  }
  const activatedAt = new Date().toISOString();
  const card = {
    id: provision.pendingCardId,
    businessId,
    ownerId: user.id,
    tokenHash: provision.tokenHash,
    status: "active",
    createdAt: provision.createdAt,
    activatedAt,
  };
  await kv.mset(
    [`nfc-card:${card.id}`, `nfc-card-token:${card.tokenHash}`, `nfc-active:${card.id}`],
    [card, { cardId: card.id, businessId, ownerId: user.id }, { cardId: card.id, businessId, ownerId: user.id, status: "active", updatedAt: activatedAt }],
  );
  if (provision.replacingCardId) {
    const oldCard = await kv.get(`nfc-card:${provision.replacingCardId}`);
    const oldActive = await kv.get(`nfc-active:${provision.replacingCardId}`);
    if (oldActive?.currentIssueKey) {
      await nfcRpc("perklyn_cancel_nfc_issue", {
        p_active_key: `nfc-active:${provision.replacingCardId}`,
        p_issue_key: oldActive.currentIssueKey,
        p_owner_id: user.id,
      });
    }
    if (oldCard) {
      await kv.set(`nfc-card:${oldCard.id}`, { ...oldCard, status: "disabled", disabledAt: activatedAt, replacedByCardId: card.id });
      await kv.del(`nfc-card-token:${oldCard.tokenHash}`);
    }
  }
  await kv.set(`nfc-card-business:${businessId}`, { businessId, cardId: card.id, ownerId: user.id, status: "active", activatedAt });
  await kv.del(`nfc-provision:${provisionId}`);
  return c.json({ card: { id: card.id, status: card.status, activatedAt } });
});

app.post(`${prefix}/nfc/issues`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  const businessId = Number(body.businessId);
  const amount = Number(body.amount);
  const reason = String(body.reason ?? "").trim();
  if (!await ownedBusiness(businessId, user.id)) return c.json({ error: "You do not own this business." }, 403);
  if (!Number.isInteger(amount) || amount < 1 || amount > 10_000) return c.json({ error: "Enter between 1 and 10,000 points." }, 400);
  if (reason.length > 100 || /[\u0000-\u001f\u007f]/.test(reason)) return c.json({ error: "Keep the reason under 100 characters." }, 400);
  if (!await checkRateLimit("nfc-issue", `${user.id}:${businessId}`, 30, 60 * 60 * 1000)) return c.json({ error: "This business has reached its hourly NFC issue limit." }, 429);
  const mapping = await kv.get(`nfc-card-business:${businessId}`);
  const card = mapping?.cardId ? await kv.get(`nfc-card:${mapping.cardId}`) : null;
  if (!card || card.status !== "active" || card.ownerId !== user.id) return c.json({ error: "Connect an active NFC card first." }, 400);
  const id = crypto.randomUUID();
  const issue = { id, cardId: card.id, businessId, ownerId: user.id, amount, ...(reason ? { reason } : {}) };
  const result = await nfcRpc("perklyn_create_nfc_issue", {
    p_active_key: `nfc-active:${card.id}`,
    p_issue_key: `nfc-issue:${id}`,
    p_issue_value: issue,
  });
  if (result?.result === "active_issue_exists") return c.json({ error: "An NFC issue is already active.", issue: result.issue, serverNow: new Date().toISOString() }, 409);
  if (result?.result !== "created") return c.json({ error: "The NFC card is not active." }, 409);
  return c.json({ issue: result.issue, serverNow: result.serverNow }, 201);
});

app.get(`${prefix}/nfc/issues/current`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const businessId = Number(c.req.query("businessId"));
  if (!await ownedBusiness(businessId, user.id)) return c.json({ error: "You do not own this business." }, 403);
  const mapping = await kv.get(`nfc-card-business:${businessId}`);
  const card = mapping?.cardId ? await kv.get(`nfc-card:${mapping.cardId}`) : null;
  const issue = card ? await currentNfcIssue(card) : null;
  if (issue?.status === "claimed" && !await kv.get(`nfc-reconciled:${issue.id}`)) {
    const membership = await kv.get(`pending:${normalizePhone(issue.claimedCustomerPhone)}:${businessId}`);
    if (membership) await reconcileNfcClaim(issue, Number(membership.points ?? 0), Number(membership.nfcPoints ?? 0));
  }
  return c.json({ card: card ? { id: card.id, status: card.status, activatedAt: card.activatedAt } : null, issue, serverNow: new Date().toISOString() });
});

app.post(`${prefix}/nfc/issues/:id/cancel`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const issue = await kv.get(`nfc-issue:${c.req.param("id")}`);
  if (!issue || !await ownedBusiness(Number(issue.businessId), user.id) || issue.ownerId !== user.id) return c.json({ error: "NFC issue not found." }, 404);
  const result = await nfcRpc("perklyn_cancel_nfc_issue", {
    p_active_key: `nfc-active:${issue.cardId}`,
    p_issue_key: `nfc-issue:${issue.id}`,
    p_owner_id: user.id,
  });
  if (result?.result !== "cancelled") return c.json({ error: `This issue is already ${result?.result ?? "closed"}.`, issue: result?.issue }, 409);
  return c.json({ issue: result.issue, serverNow: result.serverNow });
});

app.post(`${prefix}/nfc/claim-preview`, async (c) => {
  const { token: rawToken = "" } = await c.req.json();
  const token = String(rawToken);
  if (!validNfcToken(token)) return c.json({ status: "invalid_card", serverNow: new Date().toISOString() });
  const tokenHash = await hashText(token);
  if (!await checkRateLimit("nfc-preview", tokenHash, 120, 15 * 60 * 1000)) return c.json({ error: "Too many card checks. Try again shortly." }, 429);
  const lookup = await kv.get(`nfc-card-token:${tokenHash}`);
  const card = lookup?.cardId ? await kv.get(`nfc-card:${lookup.cardId}`) : null;
  if (!card || card.status !== "active") return c.json({ status: "invalid_card", serverNow: new Date().toISOString() });
  const business = await kv.get(`business:${card.businessId}`);
  const issue = await currentNfcIssue(card);
  const status = !issue ? "no_active_issue" : issue.status === "pending" ? "ready" : issue.status;
  return c.json({
    status,
    businessName: business?.name ?? "Perklyn business",
    ...(issue ? { amount: issue.amount, issueId: issue.id, expiresAt: issue.expiresAt } : {}),
    serverNow: new Date().toISOString(),
  });
});

app.post(`${prefix}/nfc/claim`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Sign in with a customer account to claim these points." }, 401);
  const profile = await kv.get(`profile:${user.id}`) ?? user.user_metadata ?? {};
  if (profile.role !== "customer") return c.json({ error: "A customer account is required to claim NFC points." }, 403);
  const { token: rawToken = "" } = await c.req.json();
  const token = String(rawToken);
  if (!validNfcToken(token)) return c.json({ error: "This NFC card is not valid." }, 400);
  const tokenHash = await hashText(token);
  if (!await checkRateLimit("nfc-claim-user", user.id, 10, 5 * 60 * 1000) || !await checkRateLimit("nfc-claim-token", tokenHash, 20, 5 * 60 * 1000)) return c.json({ error: "Too many claim attempts. Try again shortly." }, 429);
  const lookup = await kv.get(`nfc-card-token:${tokenHash}`);
  const card = lookup?.cardId ? await kv.get(`nfc-card:${lookup.cardId}`) : null;
  const active = card ? await kv.get(`nfc-active:${card.id}`) : null;
  if (!card || card.status !== "active" || !active?.currentIssueKey) return c.json({ error: "No points are ready on this card." }, 409);
  const business = await kv.get(`business:${card.businessId}`);
  if (!business || business._ownerId !== card.ownerId) return c.json({ error: "This NFC card is no longer connected." }, 409);
  const membershipKey = `pending:${normalizePhone(profile.phone)}:${card.businessId}`;
  const seed = {
    business,
    ownerId: card.ownerId,
    customerName: profile.name,
    phone: profile.phone,
    points: 0,
    nfcPoints: 0,
    reward: "Welcome reward",
  };
  const result = await nfcRpc("perklyn_claim_nfc_issue", {
    p_active_key: `nfc-active:${card.id}`,
    p_issue_key: active.currentIssueKey,
    p_membership_key: membershipKey,
    p_membership_seed: seed,
    p_claimant_user_id: user.id,
  });
  if (result?.result !== "claimed") return c.json({ error: result?.result === "expired" ? "This point issue has expired." : result?.result === "claimed" ? "These points were already claimed." : "These points are no longer available.", status: result?.result }, 409);
  await reconcileNfcClaim(result.issue, Number(result.balance), Number(result.nfcPoints));
  if (!await kv.get(`nfc-notified:${result.issue.id}`)) {
    await kv.set(`nfc-notified:${result.issue.id}`, { createdAt: new Date().toISOString() });
    background(Promise.all([
      dispatchNotification(user.id, "customer", {
        type: "points_changed",
        category: "loyaltyActivity",
        title: `NFC points added at ${business.name}`,
        body: `${result.issue.amount.toLocaleString()} points added. New balance: ${Number(result.balance).toLocaleString()} points.`,
        businessId: Number(card.businessId),
        businessName: business.name,
        data: { balance: Number(result.balance), delta: Number(result.issue.amount), source: "nfc" },
      }),
      dispatchNotification(String(card.ownerId), "business", {
        type: "nfc_points_claimed",
        category: "businessOperations",
        title: "NFC points claimed",
        body: `${profile.name} claimed ${Number(result.issue.amount).toLocaleString()} NFC points.`,
        businessId: Number(card.businessId),
        businessName: business.name,
      }),
    ]));
  }
  const { _ownerId, ...businessSummary } = business;
  return c.json({
    business: businessSummary,
    amount: Number(result.issue.amount),
    balance: Number(result.balance),
    nfcPoints: Number(result.nfcPoints),
    membershipCreated: Boolean(result.membershipCreated),
  });
});

app.get(`${prefix}/rfid/cards`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const businessId = Number(c.req.query("businessId"));
  if (!await ownedBusiness(businessId, user.id)) return c.json({ error: "You do not own this business." }, 403);
  const cards = await kv.getByPrefix(`rfid-card:${businessId}:`);
  return c.json({
    cards: cards
      .filter((card: any) => card.ownerId === user.id)
      .sort((a: any, b: any) => String(b.activatedAt).localeCompare(String(a.activatedAt)))
      .map(({ identifierHash, phone, _key, ...card }: any) => ({ ...card, maskedPhone: maskPhone(phone ?? "") })),
  });
});

app.get(`${prefix}/rfid/customers`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const businessId = Number(c.req.query("businessId"));
  const query = String(c.req.query("query") ?? "").trim().toLowerCase();
  if (!await ownedBusiness(businessId, user.id)) return c.json({ error: "You do not own this business." }, 403);
  if (!query) return c.json({ customers: [] });
  const state = await kv.get(`state:${user.id}`) ?? {};
  const customers = (state.customers ?? []).filter((customer: any) =>
    `${customer.id} ${customer.name} ${customer.phone}`.toLowerCase().includes(query)
  ).slice(0, 20);
  const verified = [];
  for (const customer of customers) {
    const membership = await kv.get(`pending:${normalizePhone(customer.phone)}:${businessId}`);
    if (membership?.ownerId === user.id) verified.push({ ...customer, points: Number(membership.points ?? 0) });
  }
  return c.json({ customers: verified });
});

app.post(`${prefix}/rfid/cards/activate`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  const businessId = Number(body.businessId);
  const identifier = String(body.cardIdentifier ?? "").trim().toUpperCase();
  const customerId = String(body.customerId ?? "");
  const reassign = body.reassign === true;
  const replaceCardId = String(body.replaceCardId ?? "");
  if (!await ownedBusiness(businessId, user.id)) return c.json({ error: "You do not own this business." }, 403);
  if (!validRfidIdentifier(identifier)) return c.json({ error: "The reader returned an invalid card identifier." }, 400);
  if (!await checkRateLimit("rfid-activate", `${user.id}:${businessId}`, 40, 60 * 60 * 1000)) return c.json({ error: "Too many card activation attempts." }, 429);
  const state = await kv.get(`state:${user.id}`) ?? {};
  const customer = (state.customers ?? []).find((item: any) => String(item.id) === customerId);
  if (!customer) return c.json({ error: "Select an existing customer from this business." }, 404);
  const membership = await kv.get(`pending:${normalizePhone(customer.phone)}:${businessId}`);
  if (!membership || membership.ownerId !== user.id) return c.json({ error: "This customer does not belong to the current business." }, 403);
  const key = await rfidCardKey(businessId, identifier);
  const now = new Date().toISOString();
  const card = {
    id: crypto.randomUUID(),
    businessId,
    ownerId: user.id,
    customerId,
    customerName: customer.name,
    phone: customer.phone,
    identifierHash: key.split(":").at(-1),
    maskedIdentifier: maskRfidIdentifier(identifier),
    status: "active",
    activatedAt: now,
    lastScannedAt: null,
  };
  let replacement: any = null;
  if (replaceCardId) {
    const allCards = await kv.getByPrefix(`rfid-card:${businessId}:`);
    replacement = allCards.find((item: any) => item.id === replaceCardId && item.ownerId === user.id);
    if (!replacement || String(replacement.customerId) !== customerId || replacement.status !== "active") {
      return c.json({ error: "The active replacement card does not match this customer." }, 400);
    }
  }
  const result = await nfcRpc("perklyn_activate_rfid_card", {
    p_card_key: key,
    p_card_value: card,
    p_customer_id: customerId,
    p_reassign: reassign,
  });
  if (result?.result === "already_linked") {
    return c.json({
      error: "This card is already linked to another customer.",
      conflict: {
        cardId: result.card?.id,
        customerName: result.card?.customerName,
        maskedIdentifier: result.card?.maskedIdentifier,
        status: result.card?.status,
      },
    }, 409);
  }
  if (result?.result === "already_active") return c.json({ error: "This card is already active for the selected customer.", card: result.card }, 409);
  if (result?.result === "inactive_card") return c.json({ error: `This card is ${result.card?.status ?? "inactive"}. Secure reassignment confirmation is required.` }, 409);
  if (replacement) {
    const oldKey = `rfid-card:${businessId}:${replacement.identifierHash}`;
    await kv.set(oldKey, { ...replacement, status: "replaced", replacedAt: now, replacedByCardId: card.id });
  }
  return c.json({ card: result.card, message: "Loyalty card activated successfully." }, 201);
});

app.post(`${prefix}/rfid/cards/scan`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { businessId: rawBusinessId, cardIdentifier: rawIdentifier } = await c.req.json();
  const businessId = Number(rawBusinessId);
  const identifier = String(rawIdentifier ?? "").trim().toUpperCase();
  const business = await ownedBusiness(businessId, user.id);
  if (!business) return c.json({ error: "You do not own this business." }, 403);
  if (!validRfidIdentifier(identifier)) return c.json({ status: "scan_failed", error: "The reader returned an invalid card identifier." }, 400);
  if (!await checkRateLimit("rfid-scan", `${user.id}:${businessId}`, 240, 60 * 60 * 1000)) return c.json({ error: "Too many card scans. Wait a moment." }, 429);
  const key = await rfidCardKey(businessId, identifier);
  const card = await kv.get(key);
  if (!card || card.ownerId !== user.id) return c.json({ status: "not_registered", error: "This card is not registered to this business." }, 404);
  if (card.status !== "active") return c.json({ status: card.status, error: `This card is ${card.status} and cannot be used.` }, 409);
  const membership = await kv.get(`pending:${normalizePhone(card.phone)}:${businessId}`);
  if (!membership || membership.ownerId !== user.id) return c.json({ status: "customer_lookup_failed", error: "The linked customer membership could not be verified." }, 409);
  const scannedAt = new Date().toISOString();
  await kv.set(key, { ...card, lastScannedAt: scannedAt });
  const ownerState = await kv.get(`state:${user.id}`) ?? {};
  const lastTransaction = (ownerState.activities ?? []).find((activity: any) =>
    Number(activity.businessId) === businessId && normalizePhone(activity.phone) === normalizePhone(card.phone)
  );
  return c.json({
    status: "detected",
    card: { id: card.id, maskedIdentifier: card.maskedIdentifier, status: card.status, lastScannedAt: scannedAt },
    customer: {
      id: card.customerId,
      name: card.customerName,
      maskedPhone: maskPhone(card.phone),
      points: Number(membership.points ?? 0),
    },
    rewards: (business.rewards ?? []).map((reward: any) => ({ ...reward, available: reward.active !== false })),
    lastTransaction: lastTransaction ?? null,
  });
});

app.post(`${prefix}/rfid/cards/:id/block`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { businessId: rawBusinessId } = await c.req.json();
  const businessId = Number(rawBusinessId);
  if (!await ownedBusiness(businessId, user.id)) return c.json({ error: "You do not own this business." }, 403);
  const cards = await kv.getByPrefix(`rfid-card:${businessId}:`);
  const card = cards.find((item: any) => item.id === c.req.param("id") && item.ownerId === user.id);
  if (!card) return c.json({ error: "RFID card not found." }, 404);
  if (card.status !== "active") return c.json({ error: `This card is already ${card.status}.` }, 409);
  const blocked = { ...card, status: "blocked", blockedAt: new Date().toISOString() };
  await kv.set(`rfid-card:${businessId}:${card.identifierHash}`, blocked);
  return c.json({ card: blocked });
});

app.post(`${prefix}/rfid/transactions/add`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  const businessId = Number(body.businessId);
  const points = Number(body.points);
  const operationId = String(body.operationId ?? "");
  const business = await ownedBusiness(businessId, user.id);
  if (!business) return c.json({ error: "You do not own this business." }, 403);
  if (!await checkRateLimit("rfid-transaction", `${user.id}:${businessId}`, 120, 60 * 1000)) return c.json({ error: "Too many RFID transactions. Wait a moment." }, 429);
  if (!Number.isInteger(points) || points < 1 || points > 1_000_000) return c.json({ error: "Enter a valid positive number of points." }, 400);
  if (!/^[0-9a-f-]{36}$/i.test(operationId)) return c.json({ error: "Invalid transaction request." }, 400);
  const cards = await kv.getByPrefix(`rfid-card:${businessId}:`);
  const card = cards.find((item: any) => item.id === body.cardId && item.ownerId === user.id);
  if (!card || card.status !== "active") return c.json({ error: "Scan an active card before adding points." }, 409);
  const transaction = {
    id: `rfid:${operationId}`,
    businessId,
    customerName: card.customerName,
    phone: card.phone,
    type: "issued",
    source: "rfid",
    points,
    delta: points,
    purchaseAmount: body.purchaseAmount ? Number(body.purchaseAmount) : null,
    description: String(body.note ?? "").trim().slice(0, 180) || "Points added by RFID card",
    cardId: card.id,
  };
  const result = await nfcRpc("perklyn_rfid_points_transaction", {
    p_membership_key: `pending:${normalizePhone(card.phone)}:${businessId}`,
    p_transaction_key: `rfid-transaction:${businessId}:${operationId}`,
    p_delta: points,
    p_transaction_value: transaction,
  });
  if (!["completed", "duplicate"].includes(result?.result)) return c.json({ error: "Unable to update this customer balance." }, 409);
  await reconcileRfidTransaction(card, result.transaction, Number(result.balance));
  const customerLogin = await resolveCustomerUser(card.phone);
  if (customerLogin && result.result === "completed") background(dispatchNotification(customerLogin.userId, "customer", {
    type: "points_changed",
    category: "loyaltyActivity",
    title: `Points added at ${business.name}`,
    body: `${points.toLocaleString()} points added by loyalty card. New balance: ${Number(result.balance).toLocaleString()} points.`,
    businessId,
    businessName: business.name,
    data: { balance: Number(result.balance), delta: points, source: "rfid" },
  }));
  return c.json({ balance: Number(result.balance), transaction: result.transaction });
});

app.post(`${prefix}/rfid/transactions/redeem`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  const businessId = Number(body.businessId);
  const operationId = String(body.operationId ?? "");
  const business = await ownedBusiness(businessId, user.id);
  if (!business) return c.json({ error: "You do not own this business." }, 403);
  if (!await checkRateLimit("rfid-transaction", `${user.id}:${businessId}`, 120, 60 * 1000)) return c.json({ error: "Too many RFID transactions. Wait a moment." }, 429);
  if (!/^[0-9a-f-]{36}$/i.test(operationId)) return c.json({ error: "Invalid redemption request." }, 400);
  const reward = (business.rewards ?? []).find((item: any) => String(item.id) === String(body.rewardId));
  if (!reward || reward.active === false) return c.json({ error: "This reward is inactive or unavailable." }, 409);
  const cost = Number(reward.points);
  if (!Number.isInteger(cost) || cost < 1) return c.json({ error: "This reward has an invalid point cost." }, 409);
  const cards = await kv.getByPrefix(`rfid-card:${businessId}:`);
  const card = cards.find((item: any) => item.id === body.cardId && item.ownerId === user.id);
  if (!card || card.status !== "active") return c.json({ error: "Scan an active card before redeeming a reward." }, 409);
  const transaction = {
    id: `rfid:${operationId}`,
    businessId,
    customerName: card.customerName,
    phone: card.phone,
    type: "claimed",
    source: "rfid",
    points: cost,
    delta: -cost,
    rewardId: reward.id,
    rewardTitle: reward.title,
    description: `RFID reward redeemed: ${reward.title}`,
    cardId: card.id,
  };
  const result = await nfcRpc("perklyn_rfid_points_transaction", {
    p_membership_key: `pending:${normalizePhone(card.phone)}:${businessId}`,
    p_transaction_key: `rfid-transaction:${businessId}:${operationId}`,
    p_delta: -cost,
    p_transaction_value: transaction,
  });
  if (result?.result === "insufficient_points") return c.json({ error: `This customer needs ${cost - Number(result.balance)} more points.` }, 409);
  if (!["completed", "duplicate"].includes(result?.result)) return c.json({ error: "Unable to redeem this reward." }, 409);
  await reconcileRfidTransaction(card, result.transaction, Number(result.balance));
  return c.json({ balance: Number(result.balance), transaction: result.transaction, reward: { id: reward.id, title: reward.title, points: cost } });
});

app.get(`${prefix}/claim-capabilities`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ verificationCodes: true, expiresInHours: 24 });
});

app.post(`${prefix}/claim-reward`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const profile = await kv.get(`profile:${user.id}`);
  if (profile?.role !== "customer") return c.json({ error: "Only customers can claim rewards." }, 403);
  if (!await checkRateLimit("claim", user.id, 20, 60 * 1000)) return c.json({ error: "Too many claim attempts. Wait a moment and try again." }, 429);
  const { businessId, rewardId } = await c.req.json();
  const membership = await kv.get(`pending:${normalizePhone(profile.phone)}:${businessId}`);
  if (!membership) return c.json({ error: "You are not connected to this business." }, 404);
  const business = await kv.get(`business:${businessId}`);
  const reward = business?.rewards?.find((item: any) => String(item.id) === String(rewardId));
  if (!reward) return c.json({ error: "This reward is no longer available." }, 404);
  const title = String(reward.title);
  const points = Number(reward.points);
  if (!Number.isFinite(points) || points <= 0 || membership.points < points) return c.json({ error: "You do not have enough points." }, 400);
  membership.points -= points;
  membership.updatedAt = new Date().toISOString();
  await kv.set(`pending:${normalizePhone(profile.phone)}:${businessId}`, membership);
  const claimCode = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const claim = { code: claimCode, businessId, ownerId: membership.ownerId, customerName: profile.name, phone: profile.phone, rewardId, title, points, status: "pending", createdAt: new Date().toISOString(), expiresAt };
  await kv.set(`claim:${claimCode}`, claim);
  if (membership.ownerId) {
    const ownerState = await kv.get(`state:${membership.ownerId}`) ?? {};
    ownerState.customers = (ownerState.customers ?? []).map((customer: any) => normalizePhone(customer.phone) === normalizePhone(profile.phone) ? { ...customer, points: membership.points } : customer);
    ownerState.activities = [{
      id: Date.now(),
      businessId,
      customerName: profile.name,
      phone: profile.phone,
      type: "claimed",
      points,
      description: `Reward claimed: ${title}`,
      occurredAt: new Date().toISOString(),
    }, ...(ownerState.activities ?? [])];
    await kv.set(`state:${membership.ownerId}`, ownerState);
    background(dispatchNotification(String(membership.ownerId), "business", {
      type: "reward_claimed",
      category: "businessOperations",
      title: "Reward claim ready",
      body: `${profile.name} claimed ${title}. Open Perklyn to verify it in store.`,
      businessId: Number(businessId),
      businessName: business?.name,
      claimCode,
      data: { rewardTitle: title, points },
    }));
  }
  return c.json({ balance: membership.points, rewardId, claimCode, expiresAt });
});

app.post(`${prefix}/verify-claim`, async (c) => {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const profile = await kv.get(`profile:${user.id}`);
  if (profile?.role !== "business") return c.json({ error: "Only business owners can verify claim codes." }, 403);
  if (!await checkRateLimit("verify", user.id, 10, 5 * 60 * 1000)) return c.json({ error: "Too many verification attempts. Try again in a few minutes." }, 429);
  const { code } = await c.req.json();
  const normalizedCode = String(code ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!normalizedCode) return c.json({ error: "Enter a claim code." }, 400);
  const claim = await kv.get(`claim:${normalizedCode}`);
  if (!claim || claim.ownerId !== user.id) return c.json({ error: "This claim code is not valid for your business." }, 404);
  if (claim.status === "verified") return c.json({ error: "This claim code has already been verified." }, 409);
  if (new Date(claim.expiresAt).getTime() < Date.now()) {
    claim.status = "expired";
    await kv.set(`claim:${normalizedCode}`, claim);
    return c.json({ error: "This claim code expired after 24 hours." }, 410);
  }
  claim.status = "verified";
  claim.verifiedAt = new Date().toISOString();
  await kv.set(`claim:${normalizedCode}`, claim);
  const ownerState = await kv.get(`state:${user.id}`) ?? {};
  ownerState.activities = [{
    id: Date.now(),
    businessId: claim.businessId,
    customerName: claim.customerName,
    phone: claim.phone,
    type: "claimed",
    points: claim.points,
    description: `Reward verified in store: ${claim.title}`,
    occurredAt: new Date().toISOString(),
  }, ...(ownerState.activities ?? [])];
  await kv.set(`state:${user.id}`, ownerState);
  const business = await kv.get(`business:${claim.businessId}`);
  const customerLogin = await resolveCustomerUser(claim.phone);
  if (customerLogin) {
    background(dispatchNotification(customerLogin.userId, "customer", {
      type: "reward_verified",
      category: "loyaltyActivity",
      title: "Reward verified",
      body: `${business?.name ?? "The business"} verified your ${claim.title}.`,
      businessId: Number(claim.businessId),
      businessName: business?.name,
      data: { rewardTitle: claim.title, status: "verified" },
    }));
  }
  return c.json({ claim });
});

Deno.serve(app.fetch);
