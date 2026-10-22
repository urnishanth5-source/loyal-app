import { apiRequest } from "./supabase";

export type NotificationPreferences = {
  pushEnabled: boolean;
  loyaltyActivity: boolean;
  businessUpdates: boolean;
  businessOperations: boolean;
  updatedAt?: string;
};

export type PerklynNotification = {
  id: string;
  type: "points_changed" | "reward_claimed" | "reward_verified" | "member_joined" | "business_broadcast";
  category: "loyaltyActivity" | "businessUpdates" | "businessOperations";
  title: string;
  body: string;
  businessId?: number;
  businessName?: string;
  readAt: string | null;
  createdAt: string;
};

export type NotificationCampaign = {
  id: string;
  title: string;
  body: string;
  status: "queued" | "sending" | "complete" | "partial" | "failed";
  eligibleRecipients: number;
  inboxCreated: number;
  pushesDelivered: number;
  createdAt: string;
};

export const isPushSupported = () =>
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

export const getNotificationPermission = () =>
  isPushSupported() ? Notification.permission : "unsupported";

const urlBase64ToUint8Array = (value: string) => {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
};

export async function subscribeCurrentDevice() {
  if (!isPushSupported()) throw new Error("Push notifications are not supported on this device.");
  const config = await apiRequest<{ publicKey: string; supported: boolean }>("/push/config");
  if (!config.supported || !config.publicKey) throw new Error("Push notifications are not configured on the server yet.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked in your browser settings." : "Notification permission was not granted.");
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.publicKey),
  });
  await apiRequest("/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({ subscription: subscription.toJSON(), userAgent: navigator.userAgent }),
  });
  return subscription;
}

export async function unsubscribeCurrentDevice() {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await apiRequest("/push/subscriptions", {
    method: "DELETE",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}

export async function currentDeviceIsSubscribed() {
  if (!isPushSupported()) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return false;
  return Boolean(await registration.pushManager.getSubscription());
}
