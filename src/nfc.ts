import { apiRequest } from "./supabase";

const TOKEN_KEY = "perklyn:nfc-claim-token";

export type NfcClaimPreview = {
  status: "ready" | "no_active_issue" | "expired" | "claimed" | "cancelled" | "invalid_card";
  businessName?: string;
  amount?: number;
  issueId?: string;
  expiresAt?: string;
  serverNow: string;
};

export type NfcClaimResult = {
  business: Record<string, unknown>;
  amount: number;
  balance: number;
  nfcPoints: number;
  membershipCreated: boolean;
};

export function captureNfcToken() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("nfc");
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    url.searchParams.delete("nfc");
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

export const getNfcToken = () => sessionStorage.getItem(TOKEN_KEY);
export const clearNfcToken = () => sessionStorage.removeItem(TOKEN_KEY);
export const supportsNfcWriting = () => "NDEFReader" in window;

export async function writeNfcUrl(url: string) {
  const Reader = (window as unknown as { NDEFReader?: new () => { write: (message: unknown) => Promise<void> } }).NDEFReader;
  if (!Reader) throw new Error("Web NFC writing is not supported on this device.");
  await new Reader().write({ records: [{ recordType: "url", data: url }] });
}

export const previewNfcClaim = (token: string) =>
  apiRequest<NfcClaimPreview>("/nfc/claim-preview", { method: "POST", body: JSON.stringify({ token }) });

export const claimNfcPoints = (token: string) =>
  apiRequest<NfcClaimResult>("/nfc/claim", { method: "POST", body: JSON.stringify({ token }) });
