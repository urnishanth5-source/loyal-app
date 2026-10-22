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
  type: "points_changed" | "reward_claimed" | "reward_verified" | "member_joined" | "business_broadcast";
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
