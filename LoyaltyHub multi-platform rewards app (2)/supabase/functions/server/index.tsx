import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";
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

const ownedBusiness = async (businessId: number, userId: string) => {
  const business = await kv.get(`business:${businessId}`);
  return business?._ownerId === userId ? business : null;
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
  return c.json({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token });
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
  if (!await ownedBusiness(Number(businessId), user.id)) return c.json({ error: "You do not own this business." }, 403);
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
  return c.json({ claim });
});

Deno.serve(app.fetch);
