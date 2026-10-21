import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { projectId, publicAnonKey } from "../utils/supabase/info";

const globalSupabase = globalThis as unknown as {
  loyaltyHubSupabase?: SupabaseClient;
};

export const supabase = globalSupabase.loyaltyHubSupabase ?? createClient(
  `https://${projectId}.supabase.co`,
  publicAnonKey,
  {
    auth: {
      storageKey: "loyaltyhub-auth-token",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);

globalSupabase.loyaltyHubSupabase = supabase;

const apiBase = `https://${projectId}.supabase.co/functions/v1/make-server-3a123995`;

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.session?.access_token ?? publicAnonKey}`,
      ...(options.headers ?? {}),
    },
  });
  const responseText = await response.text();
  const body = (() => {
    try {
      return JSON.parse(responseText);
    } catch {
      return {};
    }
  })();
  if (
    (response.status === 404 && (body.code === "NOT_FOUND" || responseText.includes("Not Found"))) ||
    (response.status === 520 && responseText.includes("Origin is disallowed"))
  ) {
    throw new Error("The deployed Perklyn server is out of date. Redeploy the Supabase edge function from Make Settings, then try again.");
  }
  if (!response.ok) throw new Error(body.error ?? "The server request failed.");
  return body as T;
}
