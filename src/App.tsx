import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { apiRequest, supabase } from "./supabase";
import {
  currentDeviceIsSubscribed,
  getNotificationPermission,
  isPushSupported,
  NotificationCampaign,
  NotificationPreferences,
  PerklynNotification,
  subscribeCurrentDevice,
  unsubscribeCurrentDevice,
} from "./notifications";
import {
  captureNfcToken,
  claimNfcPoints,
  clearNfcToken,
  getNfcToken,
  NfcClaimPreview,
  previewNfcClaim,
  supportsNfcWriting,
  writeNfcUrl,
} from "./nfc";

type Portal = "signin" | "business" | "customer";
type Role = "customer" | "business";

type Profile = {
  name: string;
  phone: string;
  isNew: boolean;
};

type Customer = {
  id: number;
  name: string;
  phone: string;
  points: number;
  reward: string;
  joined: string;
  nfcPoints?: number;
};

type Business = {
  id: number;
  name: string;
  category: string;
  points: number;
  color: string;
  accent: string;
  logo: string;
  reward: string;
  rewards: Reward[];
  progress: number;
  transactions?: Activity[];
};

type Reward = {
  id: number;
  title: string;
  points: number;
  description: string;
};

type Claim = {
  id: number;
  businessId: number;
  rewardId: number;
  title: string;
  points: number;
  claimedAt: string;
  claimCode?: string;
  expiresAt?: string;
};

type Activity = {
  id: number | string;
  businessId: number;
  customerName: string;
  phone: string;
  type: "issued" | "claimed" | "adjusted" | "nfc_issued";
  source?: "manual" | "nfc";
  points: number;
  description: string;
  occurredAt: string;
};

const cardColors = [
  { name: "Royal green", value: "from-[#0d4e3a] to-[#073127]" },
  { name: "Emerald", value: "from-[#0f6a4f] to-[#073b30]" },
  { name: "Forest", value: "from-[#476c3e] to-[#25492e]" },
  { name: "Midnight", value: "from-[#183d3d] to-[#102526]" },
  { name: "Sapphire", value: "from-[#254f68] to-[#142d42]" },
  { name: "Plum", value: "from-[#66405d] to-[#35243a]" },
];

type ServerMembership = {
  business: Business;
  points: number;
  reward: string;
  transactions?: Activity[];
};

function mergeMembershipBusinesses(current: Business[], memberships: ServerMembership[]) {
  const pendingBusinesses = memberships.map((membership) => ({
    ...membership.business,
    points: membership.points,
    reward: membership.reward,
    progress: 0,
    transactions: membership.transactions ?? [],
  }));
  const merged = [
    ...current.map((business) => pendingBusinesses.find((pending) => pending.id === business.id) ?? business),
    ...pendingBusinesses.filter((pending) => !current.some((business) => business.id === pending.id)),
  ];
  return JSON.stringify(merged) === JSON.stringify(current) ? current : merged;
}

const countryCallingCodes = `
Afghanistan|+93
Albania|+355
Algeria|+213
Andorra|+376
Angola|+244
Antigua and Barbuda|+1 268
Argentina|+54
Armenia|+374
Australia|+61
Austria|+43
Azerbaijan|+994
Bahamas|+1 242
Bahrain|+973
Bangladesh|+880
Barbados|+1 246
Belarus|+375
Belgium|+32
Belize|+501
Benin|+229
Bhutan|+975
Bolivia|+591
Bosnia and Herzegovina|+387
Botswana|+267
Brazil|+55
Brunei|+673
Bulgaria|+359
Burkina Faso|+226
Burundi|+257
Cabo Verde|+238
Cambodia|+855
Cameroon|+237
Canada|+1
Central African Republic|+236
Chad|+235
Chile|+56
China|+86
Colombia|+57
Comoros|+269
Congo, Democratic Republic|+243
Congo, Republic|+242
Costa Rica|+506
Côte d’Ivoire|+225
Croatia|+385
Cuba|+53
Cyprus|+357
Czechia|+420
Denmark|+45
Djibouti|+253
Dominica|+1 767
Dominican Republic|+1 809
Ecuador|+593
Egypt|+20
El Salvador|+503
Equatorial Guinea|+240
Eritrea|+291
Estonia|+372
Eswatini|+268
Ethiopia|+251
Fiji|+679
Finland|+358
France|+33
Gabon|+241
Gambia|+220
Georgia|+995
Germany|+49
Ghana|+233
Greece|+30
Grenada|+1 473
Guatemala|+502
Guinea|+224
Guinea-Bissau|+245
Guyana|+592
Haiti|+509
Honduras|+504
Hungary|+36
Iceland|+354
India|+91
Indonesia|+62
Iran|+98
Iraq|+964
Ireland|+353
Israel|+972
Italy|+39
Jamaica|+1 876
Japan|+81
Jordan|+962
Kazakhstan|+7
Kenya|+254
Kiribati|+686
Korea, North|+850
Korea, South|+82
Kosovo|+383
Kuwait|+965
Kyrgyzstan|+996
Laos|+856
Latvia|+371
Lebanon|+961
Lesotho|+266
Liberia|+231
Libya|+218
Liechtenstein|+423
Lithuania|+370
Luxembourg|+352
Madagascar|+261
Malawi|+265
Malaysia|+60
Maldives|+960
Mali|+223
Malta|+356
Marshall Islands|+692
Mauritania|+222
Mauritius|+230
Mexico|+52
Micronesia|+691
Moldova|+373
Monaco|+377
Mongolia|+976
Montenegro|+382
Morocco|+212
Mozambique|+258
Myanmar|+95
Namibia|+264
Nauru|+674
Nepal|+977
Netherlands|+31
New Zealand|+64
Nicaragua|+505
Niger|+227
Nigeria|+234
North Macedonia|+389
Norway|+47
Oman|+968
Pakistan|+92
Palau|+680
Palestine|+970
Panama|+507
Papua New Guinea|+675
Paraguay|+595
Peru|+51
Philippines|+63
Poland|+48
Portugal|+351
Qatar|+974
Romania|+40
Russia|+7
Rwanda|+250
Saint Kitts and Nevis|+1 869
Saint Lucia|+1 758
Saint Vincent and the Grenadines|+1 784
Samoa|+685
San Marino|+378
São Tomé and Príncipe|+239
Saudi Arabia|+966
Senegal|+221
Serbia|+381
Seychelles|+248
Sierra Leone|+232
Singapore|+65
Slovakia|+421
Slovenia|+386
Solomon Islands|+677
Somalia|+252
South Africa|+27
South Sudan|+211
Spain|+34
Sri Lanka|+94
Sudan|+249
Suriname|+597
Sweden|+46
Switzerland|+41
Syria|+963
Taiwan|+886
Tajikistan|+992
Tanzania|+255
Thailand|+66
Timor-Leste|+670
Togo|+228
Tonga|+676
Trinidad and Tobago|+1 868
Tunisia|+216
Türkiye|+90
Turkmenistan|+993
Tuvalu|+688
Uganda|+256
Ukraine|+380
United Arab Emirates|+971
United Kingdom|+44
United States|+1
Uruguay|+598
Uzbekistan|+998
Vanuatu|+678
Vatican City|+39
Venezuela|+58
Vietnam|+84
Yemen|+967
Zambia|+260
Zimbabwe|+263
`.trim().split("\n").map((entry) => {
  const [country, dial] = entry.split("|");
  return { country, dial };
});

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    back: <><path d="m15 18-6-6 6-6" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    building: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h2M14 7h2M8 11h2M14 11h2M9 21v-5h6v5" /></>,
    card: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>,
    gift: <><rect x="3" y="8" width="18" height="13" rx="2" /><path d="M12 8v13M3 12h18M12 8H7.5a2.5 2.5 0 1 1 2.45-3c.3 1.3 2.05 3 2.05 3ZM12 8h4.5A2.5 2.5 0 1 0 14.05 5C13.75 6.3 12 8 12 8Z" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3" /><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /></>,
    minus: <path d="M5 12h14" />,
    nfc: <><path d="M7 7a7 7 0 0 1 0 10M11 4a11 11 0 0 1 0 16M3 10a3 3 0 0 1 0 4" /><path d="M16 8v8" /></>,
    phone: <><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 9.73a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.85.3 1.73.5 2.63.62A2 2 0 0 1 22 16.92Z" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09a1.7 1.7 0 0 0-1.1-1.57 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.66 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.5 4.66a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.15.37.36.7.65.98.3.27.68.42 1.08.42H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z" /></>,
    spark: <path d="m12 3 1.25 4.2L17 9l-3.75 1.8L12 15l-1.25-4.2L7 9l3.75-1.8L12 3Zm6 12 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z" />,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function Brand({ light = false }: { light?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className={`logo-mark ${light ? "bg-white/10" : "bg-[#092f26]"}`}>
        <img src="/perklyn-logo.svg" alt="" />
      </div>
      <div className="text-[1.3rem] font-extrabold tracking-[-0.04em] text-[#d4b95e]">
        Perklyn
      </div>
    </div>
  );
}

function Button({ children, variant = "primary", className = "", type = "button", onClick, disabled = false }: { children: ReactNode; variant?: "primary" | "secondary" | "ghost"; className?: string; type?: "button" | "submit"; onClick?: () => void; disabled?: boolean }) {
  return <button type={type} onClick={onClick} disabled={disabled} className={`btn btn-${variant} ${className}`}>{children}</button>;
}

function PhoneField({ defaultLocal = "", onChange }: { defaultLocal?: string; onChange?: (value: string) => void }) {
  const [country, setCountry] = useState("United States");
  const [local, setLocal] = useState(defaultLocal);
  const active = countryCallingCodes.find((item) => item.country === country) ?? countryCallingCodes[0];
  const emit = (nextCountry: string, nextLocal: string) => {
    const next = countryCallingCodes.find((item) => item.country === nextCountry) ?? countryCallingCodes[0];
    onChange?.(`${next.dial} ${nextLocal}`.trim());
  };

  return (
    <div className="phone-field">
      <select
        aria-label="Country calling code"
        value={country}
        onChange={(event) => {
          setCountry(event.target.value);
          emit(event.target.value, local);
        }}
      >
        {countryCallingCodes.map((item) => <option key={item.country} value={item.country}>{item.country} ({item.dial})</option>)}
      </select>
      <span className="dial-code">{active.dial}</span>
      <input
        required
        aria-label="Phone number"
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        value={local}
        onChange={(event) => {
          const value = event.target.value.replace(/[^\d\s()-]/g, "");
          setLocal(value);
          emit(country, value);
        }}
        placeholder="Phone number"
      />
    </div>
  );
}

function SignIn({ onEnter }: { onEnter: (role: Role, isNew: boolean, details: { name: string; businessName: string; phone: string; email: string; password: string; authorizationCode: string }) => Promise<{ ok: boolean; message?: string }> }) {
  const [role, setRole] = useState<Role>("customer");
  const [showSignup, setShowSignup] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [authorizationError, setAuthorizationError] = useState("");
  const [accountName, setAccountName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [phone, setPhone] = useState("+1 202 555 0147");
  const [email, setEmail] = useState("");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [mascotBlink, setMascotBlink] = useState(0);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAuthorizationError("");
    setAuthMessage("");
    setSubmitting(true);
    try {
      const result = await onEnter(role, showSignup, { name: accountName.trim(), businessName: businessName.trim(), phone, email: email.trim(), password, authorizationCode });
      if (!result.ok) {
        const message = result.message ?? "Unable to access this account.";
        setAuthMessage(message);
        if (message.toLowerCase().includes("authorization code")) setAuthorizationError(message);
      }
    } catch {
      setAuthMessage("Perklyn could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };
  const sendRecoveryEmail = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setRecoveryMessage("");
    const { error } = await supabase.auth.resetPasswordForEmail(recoveryEmail.trim(), { redirectTo: window.location.origin });
    setSubmitting(false);
    setRecoveryMessage(error ? error.message : "Check your inbox for a secure password-reset link.");
  };

  return (
    <main className="signin-shell" onPointerDown={() => setMascotBlink((blink) => blink + 1)}>
      <section className="signin-story">
        <div className="absolute inset-0 opacity-15 bg-[radial-gradient(circle_at_70%_20%,#e3ca72_0,transparent_34%),radial-gradient(circle_at_15%_80%,#4f8d78_0,transparent_38%)]" />
        <div className="relative z-10 flex h-full max-w-[46rem] flex-col justify-between">
          <Brand light />
          <div className="max-w-[37rem] py-16">
            <div className="eyebrow text-[#eadb9d]"><Icon name="spark" size={17} /> One wallet. Every reward.</div>
            <div className="mt-6 text-[clamp(2.8rem,5.7vw,5.5rem)] font-extrabold leading-[.95] tracking-[-0.06em] text-white">
              Loyalty that feels rewarding.
            </div>
            <p className="mt-7 max-w-[34rem] text-lg leading-8 text-[#c5d7d0]">
              Connect with the businesses you love and keep every point, perk, and reward in one beautifully simple place.
            </p>
            <div className="mt-10 flex flex-wrap gap-x-8 gap-y-4 text-sm font-semibold text-white/90">
              <span className="flex items-center gap-2"><i className="check-dot"><Icon name="check" size={13} /></i>Always in sync</span>
              <span className="flex items-center gap-2"><i className="check-dot"><Icon name="check" size={13} /></i>Secure by design</span>
              <span className="flex items-center gap-2"><i className="check-dot"><Icon name="check" size={13} /></i>Works everywhere</span>
            </div>
          </div>
          <div className="text-sm text-white/45">Loved by local businesses and their customers.</div>
        </div>
      </section>

      <section className="signin-form-panel">
        <div className="w-full max-w-[31rem]">
          <div className="mb-10 lg:hidden"><Brand /></div>
          {!showRecovery && !showSignup && <div className="login-mascot" aria-hidden="true">
            <svg viewBox="0 0 240 220" role="presentation">
              <defs>
                <linearGradient id="ghost-body" x1="48" y1="25" x2="177" y2="194" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#ffffff" />
                  <stop offset=".55" stopColor="#eaf8f5" />
                  <stop offset="1" stopColor="#72e3d7" />
                </linearGradient>
              </defs>
              <path className="simple-ghost-body" d="M120 14c-48 0-84 35-84 82v60c0 19 9 34 22 34 13 0 17-18 30-18 14 0 16 29 32 29 17 0 19-29 33-29 13 0 17 18 30 18 13 0 22-15 22-34V96c0-47-37-82-85-82Z" fill="url(#ghost-body)" />
              <path className="simple-ghost-highlight" d="M66 73c7-23 24-37 46-42" />
              <g key={mascotBlink} className="simple-ghost-eye">
                <rect x="88" y="76" width="21" height="42" rx="10.5" fill="#25b9ad" transform="rotate(-24 98.5 97)" />
                <rect x="132" y="69" width="21" height="42" rx="10.5" fill="#25b9ad" transform="rotate(-24 142.5 90)" />
              </g>
            </svg>
          </div>}
          <div className={`text-3xl font-extrabold tracking-[-0.04em] ${showRecovery || showSignup ? "text-[#123b30]" : "text-white"}`}>{showRecovery ? "Reset your password" : showSignup ? "Create your account" : "Welcome back"}</div>
          <p className="mt-3 text-[#687a74]">{showRecovery ? "We’ll email you a secure link to choose a new password." : showSignup ? "Join Perklyn and start earning more." : "Sign in to continue to Perklyn."}</p>

          {!showRecovery && <div className="role-switch mt-8">
            <button type="button" onClick={() => { setRole("customer"); setPhone("+1 202 555 0147"); setAuthorizationError(""); setAuthMessage(""); }} className={role === "customer" ? "active" : ""}><Icon name="card" size={18} />Customer</button>
            <button type="button" onClick={() => { setRole("business"); setPhone("+1 202 555 0188"); setAuthorizationError(""); setAuthMessage(""); }} className={role === "business" ? "active" : ""}><Icon name="building" size={18} />Business</button>
          </div>}

          {showRecovery ? (
            <form onSubmit={sendRecoveryEmail} className="mt-8 space-y-5">
              <label className="field-label">Email address<input required className="field" type="email" autoComplete="email" value={recoveryEmail} onChange={(event) => setRecoveryEmail(event.target.value)} placeholder="you@example.com" /></label>
              {recoveryMessage && <div className="rounded-xl bg-[#edf7f2] p-4 text-sm font-semibold text-[#0d5946]" role="status">{recoveryMessage}</div>}
              <Button disabled={submitting} type="submit" className="w-full justify-center py-4">{submitting ? "Sending…" : "Email reset link"} {!submitting && <Icon name="arrow" size={18} />}</Button>
              <button type="button" onClick={() => { setShowRecovery(false); setRecoveryMessage(""); }} className="w-full text-center text-sm font-extrabold text-[#0d5946] hover:underline">Back to sign in</button>
            </form>
          ) : <>
          <form onSubmit={submit} className="mt-7 space-y-5">
            {showSignup && <label className="field-label">Full name<input required className="field" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder={role === "customer" ? "Your full name" : "Owner's full name"} /></label>}
            {showSignup && role === "business" && <label className="field-label">Business name<input required className="field" value={businessName} onChange={(event) => setBusinessName(event.target.value)} placeholder="Your business name" /></label>}
            <label className="field-label">Phone number<PhoneField key={role} defaultLocal={role === "customer" ? "202 555 0147" : "202 555 0188"} onChange={setPhone} /></label>
            {showSignup && <label className="field-label">Email address<input required className="field" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Used only for account recovery" /><span className="field-help">No verification is required to create your account.</span></label>}
            <label className="field-label">Password<div className="password-field"><input required minLength={showSignup ? 10 : undefined} autoComplete={showSignup ? "new-password" : "current-password"} className="field" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={showSignup ? "At least 10 characters" : "Enter your password"} /><button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"}><Icon name="eye" size={18} /><span>{showPassword ? "Hide" : "Show"}</span></button></div></label>
            {showSignup && role === "business" && (
              <label className="field-label">
                Business authorization code
                <input
                  required
                  className={`field ${authorizationError ? "field-error" : ""}`}
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={authorizationCode}
                  onChange={(event) => {
                    setAuthorizationCode(event.target.value.replace(/\D/g, ""));
                    setAuthorizationError("");
                  }}
                  placeholder="Enter your private access code"
                />
                <span className="field-help">This code is provided privately with your business license.</span>
                {authorizationError && <span className="field-error-message" role="alert">{authorizationError}</span>}
              </label>
            )}
            {!showSignup && <div className="flex items-center justify-between text-sm"><label className="flex items-center gap-2 text-[#687a74]"><input type="checkbox" className="accent-[#0d5946]" />Remember me</label><button type="button" onClick={() => { setShowRecovery(true); setAuthMessage(""); }} className="font-bold text-[#0d5946]">Forgot password?</button></div>}
            <Button disabled={submitting} type="submit" className={`w-full justify-center py-4 ${showSignup ? "" : "auth-signin-button"}`}>{submitting ? "Please wait…" : showSignup ? `Create ${role} account` : `Sign in as ${role}`} {!submitting && <Icon name="arrow" size={18} />}</Button>
          </form>
          <div className="mt-8 text-center text-sm text-[#687a74]">
            {showSignup ? "Already have an account? " : "New to Perklyn? "}
            <button type="button" onClick={() => { setShowSignup(!showSignup); setAuthorizationError(""); setAuthMessage(""); }} className="font-extrabold text-[#0d5946] hover:underline">{showSignup ? "Sign in" : "Create an account"}</button>
          </div>
          </>}
          <div className="mt-8 rounded-2xl border border-[#dce6e1] bg-[#f7faf8] p-4 text-center text-xs leading-5 text-[#6a7b75]">
            Your account data is securely synchronized through Supabase across supported devices.<br /><button type="button" className="mt-2 font-extrabold text-[#d4b95e] hover:underline" onClick={() => { window.location.href = "/privacy-policy"; }}>Privacy Policy</button>
          </div>
        </div>
      </section>
      {authMessage && <div className="auth-toast" role="alert"><i><Icon name="users" size={20} /></i><div><b>{showSignup ? "Account creation failed" : "Sign in failed"}</b><span>{authMessage}</span></div><button onClick={() => setAuthMessage("")}>Try again</button><button className="toast-close" onClick={() => setAuthMessage("")} aria-label="Close">×</button></div>}
    </main>
  );
}

function DashboardHeader({ title, subtitle, onLogout, onSettings, onNotifications, unreadCount = 0, customer = false, floating = false }: { title: string; subtitle: string; onLogout: () => void; onSettings: () => void; onNotifications: () => void; unreadCount?: number; customer?: boolean; floating?: boolean }) {
  return (
    <header className={`dashboard-header ${floating ? "floating-header" : ""}`}>
      <div className="top-brand-island"><Brand light /></div>
      <div className="header-identity hidden flex-1 items-center justify-center md:flex">
        <div className="text-center"><div className={`font-extrabold ${customer ? "text-white" : "text-[#123b30]"}`}>{title}</div><div className="text-xs text-[#7c8b86]">{subtitle}</div></div>
      </div>
      <div className="header-actions flex items-center gap-2">
        <button className="icon-button notification-button" onClick={onNotifications} aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ""}`}><Icon name="bell" size={20} />{unreadCount > 0 && <span>{unreadCount > 9 ? "9+" : unreadCount}</span>}</button>
        <button className="icon-button" onClick={onSettings} aria-label="Settings"><Icon name="settings" size={20} /></button>
        <button onClick={onLogout} className="icon-button" aria-label="Sign out"><Icon name="logout" size={20} /></button>
      </div>
    </header>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const callSupport = () => { window.location.href = "tel:+18005550110"; };
  const emailSupport = () => { window.location.href = "mailto:urnishanth22@gmail.com?subject=Perklyn%20support"; };
  return <div className="modal-backdrop card-editor-backdrop" onMouseDown={onClose}><section className="settings-dialog" onMouseDown={(event) => event.stopPropagation()}>
    <div className="flex items-start justify-between"><div><div className="page-kicker">Settings</div><div className="mt-2 text-2xl font-extrabold tracking-[-.04em] text-[#123b30]">Customer care</div><p className="mt-2 text-sm text-[#73827d]">Our support team is ready to help with your Perklyn account.</p></div><button className="icon-button" onClick={onClose}>×</button></div>
    <div className="support-options">
      <button onClick={callSupport}><i><Icon name="phone" size={22} /></i><span><b>Call customer care</b><small>+1 800 555 0110</small><em>Available Mon–Sat, 8 AM–8 PM</em></span><Icon name="chevron" size={18} /></button>
      <button onClick={emailSupport}><i><Icon name="card" size={22} /></i><span><b>Email customer care</b><small>urnishanth22@gmail.com</small><em>Usually replies within one business day</em></span><Icon name="chevron" size={18} /></button>
    </div>
    <div className="support-note"><Icon name="check" size={17} /><span>For point or reward questions, include the business name and your registered phone number.</span></div>
  </section></div>;
}

function NotificationCenter({
  role,
  notifications,
  unreadCount,
  preferences,
  permission,
  busy,
  message,
  onClose,
  onEnable,
  onDisable,
  onPreference,
  onOpenNotification,
  onReadAll,
}: {
  role: Role;
  notifications: PerklynNotification[];
  unreadCount: number;
  preferences: NotificationPreferences | null;
  permission: string;
  busy: boolean;
  message: string;
  onClose: () => void;
  onEnable: () => void;
  onDisable: () => void;
  onPreference: (field: keyof NotificationPreferences, value: boolean) => void;
  onOpenNotification: (notification: PerklynNotification) => void;
  onReadAll: () => void;
}) {
  const supported = isPushSupported();
  return <div className="modal-backdrop notification-backdrop" onMouseDown={onClose}><section className="notification-center" onMouseDown={(event) => event.stopPropagation()}>
    <div className="notification-center-header">
      <div><div className="page-kicker">Perklyn updates</div><div className="mt-2 text-2xl font-extrabold tracking-[-.04em] text-[#123b30]">Notifications</div><p className="mt-2 text-sm text-[#73827d]">{unreadCount ? `${unreadCount} unread update${unreadCount === 1 ? "" : "s"}` : "You’re all caught up."}</p></div>
      <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
    </div>
    <div className="notification-device-card">
      <div><b>Device notifications</b><span>{!supported ? "Not supported by this browser" : permission === "denied" ? "Blocked in browser settings" : preferences?.pushEnabled ? "Enabled on this device" : "Get updates even when Perklyn is closed"}</span></div>
      {supported && permission !== "denied" && (preferences?.pushEnabled
        ? <Button disabled={busy} variant="secondary" onClick={onDisable}>Turn off</Button>
        : <Button disabled={busy} onClick={onEnable}>Enable</Button>)}
    </div>
    {permission === "denied" && <div className="notification-warning">Notifications are blocked. Open your browser or app site settings, allow notifications for Perklyn, then return here.</div>}
    {message && <div className="notification-message" role="status">{message}</div>}
    {preferences && <div className="notification-preferences">
      <div className="text-sm font-extrabold text-[#153d32]">What you receive</div>
      {role === "customer" ? <>
        <label><span><b>Loyalty activity</b><small>Point changes and verified rewards</small></span><input type="checkbox" checked={preferences.loyaltyActivity} onChange={(event) => onPreference("loyaltyActivity", event.target.checked)} /></label>
        <label><span><b>Business updates</b><small>Offers and announcements from joined businesses</small></span><input type="checkbox" checked={preferences.businessUpdates} onChange={(event) => onPreference("businessUpdates", event.target.checked)} /></label>
      </> : <label><span><b>Business operations</b><small>New members and reward claims</small></span><input type="checkbox" checked={preferences.businessOperations} onChange={(event) => onPreference("businessOperations", event.target.checked)} /></label>}
    </div>}
    <div className="notification-list-heading"><b>Inbox</b>{unreadCount > 0 && <button onClick={onReadAll}>Mark all as read</button>}</div>
    <div className="notification-list">
      {notifications.length === 0 ? <div className="notification-empty"><i><Icon name="bell" size={22} /></i><b>No notifications yet</b><span>Account activity and business updates will appear here.</span></div> : notifications.map((notification) => <button key={notification.id} className={`notification-row ${notification.readAt ? "" : "unread"}`} onClick={() => onOpenNotification(notification)}>
        <i><Icon name={notification.type === "points_changed" ? "plus" : notification.type.includes("reward") ? "gift" : notification.type === "member_joined" ? "users" : "bell"} size={17} /></i>
        <span><b>{notification.title}</b><small>{notification.body}</small><em>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(notification.createdAt))}</em></span>
        {!notification.readAt && <strong aria-label="Unread" />}
      </button>)}
    </div>
  </section></div>;
}

function NotificationPrompt({ busy, onEnable, onDismiss }: { busy: boolean; onEnable: () => void; onDismiss: () => void }) {
  return <aside className="notification-prompt" aria-label="Enable notifications">
    <i><Icon name="bell" size={20} /></i>
    <div><b>Stay in the loop</b><span>Get point, reward, and account updates even when Perklyn is closed.</span></div>
    <Button disabled={busy} onClick={onEnable}>{busy ? "Enabling…" : "Enable"}</Button>
    <button className="prompt-dismiss" onClick={onDismiss}>Not now</button>
  </aside>;
}

function BottomIsland({ onLogout, portal, actions = [] }: { onLogout: () => void; portal: "business" | "customer"; actions?: Array<{ label: string; description: string; icon: string; onClick: () => void }> }) {
  const [open, setOpen] = useState(false);
  const primaryAction = actions[0];
  const supportAction = actions.find((action) => action.label.includes("Settings"));
  const goHome = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    setOpen(false);
  };

  return (
    <nav className="bottom-island-wrap" aria-label="Quick navigation">
      {open && <div className="island-menu">
        <div className="island-menu-title"><span>{portal === "business" ? "Business portal" : "Customer wallet"}</span><small>Quick actions</small></div>
        <button onClick={goHome}><i><Icon name={portal === "business" ? "grid" : "card"} size={18} /></i><span><b>{portal === "business" ? "Dashboard overview" : "My loyalty cards"}</b><small>Return to the top</small></span><Icon name="chevron" size={16} /></button>
        {actions.map((action) => <button key={action.label} onClick={() => { setOpen(false); action.onClick(); }}><i><Icon name={action.icon} size={18} /></i><span><b>{action.label}</b><small>{action.description}</small></span><Icon name="chevron" size={16} /></button>)}
        <button className="island-logout" onClick={onLogout}><i><Icon name="logout" size={18} /></i><span><b>Sign out</b><small>Return to account login</small></span><Icon name="chevron" size={16} /></button>
      </div>}
      <div className="bottom-island">
        <button onClick={goHome} aria-label="Home"><Icon name="grid" size={20} /><span>Home</span></button>
        <button onClick={() => primaryAction?.onClick()} aria-label={primaryAction?.label ?? "Quick action"}><Icon name={portal === "business" ? "users" : "card"} size={20} /><span>{portal === "business" ? "Customers" : "Cards"}</span></button>
        <button className={`island-main-button ${open ? "active" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Open menu"><Icon name="plus" size={25} /><span>Menu</span></button>
        <button onClick={() => supportAction?.onClick()} aria-label="Settings and support"><Icon name="settings" size={20} /><span>Support</span></button>
        <button onClick={onLogout} aria-label="Sign out"><Icon name="logout" size={20} /><span>Logout</span></button>
      </div>
    </nav>
  );
}

function QrScannerModal({ onClose, onScan }: { onClose: () => void; onScan: (value: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("Requesting camera access…");
  const [manualCode, setManualCode] = useState("");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (!videoRef.current || stopped) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const BarcodeDetectorClass = (window as unknown as { BarcodeDetector?: new (options: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
        if (!BarcodeDetectorClass) {
          setStatus("Live QR detection is not supported on this browser. Enter the code shown below the business QR.");
          return;
        }
        const detector = new BarcodeDetectorClass({ formats: ["qr_code"] });
        setStatus("Point your camera at the business QR code");
        timer = window.setInterval(async () => {
          if (!videoRef.current || videoRef.current.readyState < 2) return;
          const results = await detector.detect(videoRef.current);
          if (results[0]?.rawValue) {
            window.clearInterval(timer);
            onScan(results[0].rawValue);
          }
        }, 600);
      } catch {
        setStatus("Camera access is unavailable. Enter the business code manually.");
      }
    };
    start();
    return () => {
      stopped = true;
      window.clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [onScan]);

  return <div className="modal-backdrop card-editor-backdrop" onMouseDown={onClose}><section className="scanner-dialog" onMouseDown={(event) => event.stopPropagation()}>
    <div className="flex items-start justify-between"><div><div className="page-kicker">Connect a business</div><div className="mt-2 text-2xl font-extrabold tracking-[-.04em] text-[#123b30]">Scan business QR</div></div><button className="icon-button" onClick={onClose}>×</button></div>
    <div className="camera-frame"><video ref={videoRef} playsInline muted /><span className="scan-corner top-left" /><span className="scan-corner top-right" /><span className="scan-corner bottom-left" /><span className="scan-corner bottom-right" /><i className="scan-line" /></div>
    <div className="camera-status"><Icon name="spark" size={16} />{status}</div>
    <div className="manual-code"><span>or enter business code</span><div><input value={manualCode} onChange={(event) => setManualCode(event.target.value)} placeholder="LH-BIZ-000000" /><Button onClick={() => onScan(manualCode)}>Join</Button></div></div>
  </section></div>;
}

type NfcIssue = {
  id: string;
  amount: number;
  reason?: string;
  status: "pending" | "claimed" | "expired" | "cancelled";
  expiresAt: string;
  claimedAt?: string;
  claimedCustomerName?: string;
  claimedCustomerPhone?: string;
};

function countdownLabel(expiresAt?: string, serverNow?: string) {
  if (!expiresAt) return "";
  const offset = serverNow ? new Date(serverNow).getTime() - Date.now() : 0;
  const remaining = Math.max(0, new Date(expiresAt).getTime() - (Date.now() + offset));
  const seconds = Math.ceil(remaining / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function NfcManager({ businessId, onClose, onClaimed }: { businessId: number; onClose: () => void; onClaimed: () => void }) {
  const [card, setCard] = useState<{ id: string; status: string; activatedAt: string } | null>(null);
  const [provision, setProvision] = useState<{ id: string; writeUrl: string; expiresAt: string; replacing: boolean } | null>(null);
  const [issue, setIssue] = useState<NfcIssue | null>(null);
  const [serverNow, setServerNow] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [qrImage, setQrImage] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [, setClock] = useState(0);

  const loadCard = async () => {
    const result = await apiRequest<{ card: typeof card; provision: typeof provision }>(`/nfc/card?businessId=${businessId}`);
    setCard(result.card);
    setProvision(result.provision);
  };
  const loadIssue = async () => {
    const result = await apiRequest<{ issue: NfcIssue | null; serverNow: string }>(`/nfc/issues/current?businessId=${businessId}`);
    setIssue(result.issue);
    setServerNow(result.serverNow);
    if (result.issue?.status === "claimed") onClaimed();
  };
  useEffect(() => {
    Promise.all([loadCard(), loadIssue()]).catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load NFC card."));
  }, [businessId]);
  useEffect(() => {
    if (!card) return;
    const timer = window.setInterval(() => {
      setClock((value) => value + 1);
      if (issue?.status === "pending") loadIssue().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [card, issue?.status]);
  useEffect(() => {
    if (!provision) {
      setQrImage("");
      return;
    }
    QRCode.toDataURL(provision.writeUrl, { width: 520, margin: 2, errorCorrectionLevel: "M" }).then(setQrImage);
  }, [provision?.writeUrl]);

  const provisionCard = async (replaceExisting = false) => {
    if (replaceExisting && !window.confirm("Replace this NFC card? The old card will stop working as soon as the new card is activated.")) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await apiRequest<{ provision: NonNullable<typeof provision> }>("/nfc/card/provision", {
        method: "POST",
        body: JSON.stringify({ businessId, replaceExisting }),
      });
      setProvision(result.provision);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to start card setup.");
    } finally {
      setBusy(false);
    }
  };
  const writeCard = async () => {
    if (!provision) return;
    setBusy(true);
    setMessage("Hold the NFC card near your phone.");
    try {
      await writeNfcUrl(provision.writeUrl);
      setMessage("Card written. Activate it to finish setup.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to write this NFC card.");
    } finally {
      setBusy(false);
    }
  };
  const activateCard = async () => {
    if (!provision) return;
    setBusy(true);
    try {
      const result = await apiRequest<{ card: NonNullable<typeof card> }>("/nfc/card/activate", {
        method: "POST",
        body: JSON.stringify({ businessId, provisionId: provision.id }),
      });
      setCard(result.card);
      setProvision(null);
      setMessage("Your reusable Perklyn NFC card is connected.");
      await loadIssue();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to activate this card.");
    } finally {
      setBusy(false);
    }
  };
  const createIssue = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await apiRequest<{ issue: NfcIssue; serverNow: string }>("/nfc/issues", {
        method: "POST",
        body: JSON.stringify({ businessId, amount: Number(amount), reason }),
      });
      setIssue(result.issue);
      setServerNow(result.serverNow);
      setAmount("");
      setReason("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to issue NFC points.");
      await loadIssue().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const cancelIssue = async () => {
    if (!issue) return;
    setBusy(true);
    try {
      const result = await apiRequest<{ issue: NfcIssue; serverNow: string }>(`/nfc/issues/${issue.id}/cancel`, { method: "POST" });
      setIssue(result.issue);
      setServerNow(result.serverNow);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to cancel this issue.");
    } finally {
      setBusy(false);
    }
  };
  const resetIssue = () => {
    setIssue(null);
    setMessage("");
  };
  const countdown = countdownLabel(issue?.expiresAt, serverNow);

  return <div className="modal-backdrop card-editor-backdrop" onMouseDown={onClose}><section className="nfc-manager" onMouseDown={(event) => event.stopPropagation()}>
    <div className="flex items-start justify-between"><div><div className="page-kicker">Contactless loyalty</div><div className="mt-2 text-2xl font-extrabold tracking-[-.04em] text-[#123b30]">Issue points by NFC</div><p className="mt-2 text-sm text-[#73827d]">Connect one reusable card, then make points available for one customer for five minutes.</p></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div>
    {!card && !provision && <div className="nfc-empty"><i><Icon name="nfc" size={28} /></i><div><b>No NFC card connected</b><p>A permanent, secure Perklyn link is written once. Point amounts stay safely on the server.</p></div><Button disabled={busy} onClick={() => provisionCard(false)}>Set up NFC card</Button></div>}
    {provision && <div className="nfc-provision">
      <div className="nfc-step"><span>1</span><div><b>Write the secure link</b><p>{supportsNfcWriting() ? "Use this Android device to write a blank NDEF card." : "Web NFC writing is unavailable here. Use NFC Tools on a compatible phone."}</p></div></div>
      {supportsNfcWriting() && <Button disabled={busy} onClick={writeCard}><Icon name="nfc" size={18} />{busy ? "Waiting for card…" : "Write Perklyn card"}</Button>}
      <div className="nfc-manual"><div className="nfc-qr">{qrImage ? <img src={qrImage} alt="Secure NFC setup URL QR code" /> : <span>Generating QR…</span>}</div><div><b>Manual setup</b><p>In NFC Tools, create a URL/URI record and paste this secure link. Do not share it publicly.</p><code>{provision.writeUrl}</code><Button variant="secondary" onClick={() => navigator.clipboard.writeText(provision.writeUrl).then(() => setMessage("Secure URL copied."))}>Copy secure URL</Button></div></div>
      <div className="nfc-step"><span>2</span><div><b>Activate after writing</b><p>Activation connects this exact card to your business. Setup expires in 30 minutes.</p></div></div>
      <Button disabled={busy} onClick={activateCard}><Icon name="check" size={18} />I wrote the card — activate</Button>
    </div>}
    {card && !provision && <div className="nfc-active-card">
      <div className="nfc-connected"><i><Icon name="check" size={18} /></i><div><b>NFC card connected</b><span>Ready for reusable, one-time point issues</span></div><button onClick={() => provisionCard(true)}>Replace card</button></div>
      {!issue && <form onSubmit={createIssue} className="nfc-issue-form">
        <label className="field-label">Points<input required min="1" max="10000" step="1" inputMode="numeric" type="number" className="field" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="1–10,000" /></label>
        <label className="field-label">Internal reason <span>{reason.length}/100</span><input maxLength={100} className="field" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Optional, visible only to your business" /></label>
        <Button disabled={busy} type="submit"><Icon name="nfc" size={18} />Issue points for 5 minutes</Button>
      </form>}
      {issue?.status === "pending" && <div className="nfc-live-issue"><div className="nfc-status"><span>Live now</span><strong>{countdown}</strong></div><div className="nfc-amount">{issue.amount.toLocaleString()}<span>points</span></div>{issue.reason && <p>{issue.reason}</p>}<small>Waiting for one customer to tap and confirm.</small><Button disabled={busy} variant="secondary" onClick={cancelIssue}>Cancel issue</Button></div>}
      {issue?.status === "claimed" && <div className="nfc-result success"><i><Icon name="check" size={22} /></i><div><span>Points claimed</span><strong>{issue.amount.toLocaleString()} points</strong><p>{issue.claimedCustomerName} · {issue.claimedCustomerPhone}</p><small>{issue.claimedAt ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(issue.claimedAt)) : ""}</small></div><Button onClick={resetIssue}>Issue more points</Button></div>}
      {(issue?.status === "expired" || issue?.status === "cancelled") && <div className="nfc-result"><i><Icon name="nfc" size={22} /></i><div><span>Issue {issue.status}</span><strong>{issue.amount.toLocaleString()} points were not added</strong><p>Create a new five-minute issue when the customer is ready.</p></div><Button onClick={resetIssue}>Issue more points</Button></div>}
    </div>}
    {message && <div className="nfc-message" role="status">{message}</div>}
  </section></div>;
}

function NfcClaimDialog({ portal, onContinue, onClaimed, onSwitchAccount }: { portal: Portal; onContinue: () => void; onClaimed: (result: Awaited<ReturnType<typeof claimNfcPoints>>) => void; onSwitchAccount: () => void }) {
  const [preview, setPreview] = useState<NfcClaimPreview | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [, setClock] = useState(0);
  const token = getNfcToken();
  useEffect(() => {
    if (!token) return;
    previewNfcClaim(token).then(setPreview).catch((error) => setMessage(error instanceof Error ? error.message : "Unable to read this NFC card."));
    const timer = window.setInterval(() => setClock((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [token, portal]);
  if (!token) return null;
  const countdown = countdownLabel(preview?.expiresAt, preview?.serverNow);
  const claim = async () => {
    setBusy(true);
    setMessage("");
    try {
      const result = await claimNfcPoints(token);
      clearNfcToken();
      onClaimed(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to claim these points.");
      previewNfcClaim(token).then(setPreview).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const statusCopy: Record<string, string> = {
    no_active_issue: "No points are ready on this card.",
    expired: "This point issue has expired.",
    claimed: "These points have already been claimed.",
    cancelled: "This point issue was cancelled.",
    invalid_card: "This NFC card is no longer active.",
  };
  return <div className="modal-backdrop nfc-claim-backdrop"><section className="nfc-claim-dialog">
    <div className="nfc-claim-mark"><Icon name="nfc" size={28} /></div>
    <div className="page-kicker">NFC point claim</div>
    {!preview && !message && <><div className="nfc-claim-title">Reading Perklyn card…</div><p>Checking for a secure point issue.</p></>}
    {preview?.status === "ready" && <><div className="nfc-claim-title">{preview.amount?.toLocaleString()} points</div><p>from <b>{preview.businessName}</b></p><div className="nfc-claim-countdown"><span>Available for</span><strong>{countdown}</strong></div>
      {portal === "signin" && <Button className="w-full justify-center" onClick={onContinue}>Sign in to claim</Button>}
      {portal === "customer" && <Button disabled={busy || countdown === "0:00"} className="w-full justify-center" onClick={claim}>{busy ? "Claiming…" : "Claim points"}<Icon name="arrow" size={18} /></Button>}
      {portal === "business" && <><div className="nfc-claim-warning">A customer account is required to claim these points.</div><Button variant="secondary" className="w-full justify-center" onClick={onSwitchAccount}>Sign out and switch account</Button></>}
    </>}
    {preview && preview.status !== "ready" && <><div className="nfc-claim-title">Points unavailable</div><p>{statusCopy[preview.status]}</p><Button variant="secondary" className="w-full justify-center" onClick={() => { clearNfcToken(); onContinue(); }}>Close</Button></>}
    {message && <div className="nfc-message" role="alert">{message}</div>}
    <small className="nfc-claim-security">Points are added only after server verification and can be claimed once.</small>
  </section></div>;
}

type RfidCustomer = Customer & { maskedPhone?: string };
type RfidCard = {
  id: string;
  customerId: string;
  customerName: string;
  maskedIdentifier: string;
  maskedPhone?: string;
  status: "active" | "blocked" | "replaced";
  activatedAt: string;
  lastScannedAt?: string | null;
};
type RfidScan = {
  card: { id: string; maskedIdentifier: string; status: string; lastScannedAt: string };
  customer: { id: string; name: string; maskedPhone: string; points: number };
  rewards: Array<Reward & { available?: boolean }>;
  lastTransaction?: Activity | null;
};

function RfidWorkspace({ business, onClose, onDataChanged }: { business: Business; onClose: () => void; onDataChanged: () => void }) {
  type View = "home" | "activate" | "scan" | "add" | "rewards" | "redeem" | "success";
  const [view, setView] = useState<View>("home");
  const [cards, setCards] = useState<RfidCard[]>([]);
  const [cardFilter, setCardFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<RfidCustomer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<RfidCustomer | null>(null);
  const [readerMode, setReaderMode] = useState<"keyboard" | "simulated">("keyboard");
  const [readerStatus, setReaderStatus] = useState<"disconnected" | "ready" | "waiting" | "detected" | "failed">("disconnected");
  const [simulatedIdentifier, setSimulatedIdentifier] = useState("");
  const [detectedIdentifier, setDetectedIdentifier] = useState("");
  const [scanned, setScanned] = useState<RfidScan | null>(null);
  const [replaceCardId, setReplaceCardId] = useState("");
  const [pointsToAdd, setPointsToAdd] = useState("");
  const [purchaseAmount, setPurchaseAmount] = useState("");
  const [transactionNote, setTransactionNote] = useState("");
  const [selectedReward, setSelectedReward] = useState<(Reward & { available?: boolean }) | null>(null);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState<{ title: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const scanBuffer = useRef("");
  const operationId = useRef(crypto.randomUUID());

  const loadCards = async () => {
    const result = await apiRequest<{ cards: RfidCard[] }>(`/rfid/cards?businessId=${business.id}`);
    setCards(result.cards);
  };
  useEffect(() => {
    loadCards().catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load RFID cards."));
  }, [business.id]);

  const processIdentifier = async (identifier: string) => {
    const cleaned = identifier.trim().replace(/[^A-Za-z0-9:_-]/g, "").toUpperCase();
    if (cleaned.length < 4) {
      setReaderStatus("failed");
      setMessage("Scan failed. The reader did not return a valid card identifier.");
      return;
    }
    setDetectedIdentifier(cleaned);
    setReaderStatus("detected");
    if (view !== "scan") return;
    setBusy(true);
    try {
      const result = await apiRequest<RfidScan & { status: string }>("/rfid/cards/scan", {
        method: "POST",
        body: JSON.stringify({ businessId: business.id, cardIdentifier: cleaned }),
      });
      setScanned(result);
      setMessage("");
      await loadCards();
    } catch (error) {
      setScanned(null);
      setMessage(error instanceof Error ? error.message : "Card scan failed.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (readerMode !== "keyboard" || readerStatus !== "waiting") return;
    const receiveReaderInput = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        const value = scanBuffer.current;
        scanBuffer.current = "";
        if (value) processIdentifier(value);
        return;
      }
      if (event.key.length === 1 && /^[A-Za-z0-9:_-]$/.test(event.key)) scanBuffer.current += event.key;
    };
    window.addEventListener("keydown", receiveReaderInput);
    return () => window.removeEventListener("keydown", receiveReaderInput);
  }, [readerMode, readerStatus, view]);

  const startReader = () => {
    scanBuffer.current = "";
    setDetectedIdentifier("");
    setMessage("");
    setReaderStatus("waiting");
  };
  const presentSimulatedCard = () => {
    if (readerMode !== "simulated") return;
    processIdentifier(simulatedIdentifier);
  };
  const searchCustomers = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const query = new URLSearchParams({ businessId: String(business.id), query: customerQuery });
      const result = await apiRequest<{ customers: RfidCustomer[] }>(`/rfid/customers?${query.toString()}`);
      setCustomerResults(result.customers);
      if (result.customers.length === 0) setMessage("No customer belonging to this business was found.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Customer lookup failed.");
    } finally {
      setBusy(false);
    }
  };
  const activateCard = async (reassign = false) => {
    if (!selectedCustomer || !detectedIdentifier) return;
    setBusy(true);
    setMessage("");
    try {
      await apiRequest("/rfid/cards/activate", {
        method: "POST",
        body: JSON.stringify({
          businessId: business.id,
          customerId: selectedCustomer.id,
          cardIdentifier: detectedIdentifier,
          replaceCardId: replaceCardId || undefined,
          reassign,
        }),
      });
      setSuccess({ title: "Loyalty card activated successfully.", detail: `${selectedCustomer.name} can now use card ${detectedIdentifier.slice(0, 3)}••••${detectedIdentifier.slice(-3)}.` });
      setView("success");
      setReplaceCardId("");
      await loadCards();
    } catch (error) {
      const text = error instanceof Error ? error.message : "Unable to activate this card.";
      if ((text.includes("already linked") || text.includes("Secure reassignment")) && window.confirm(`${text} Reassign it to ${selectedCustomer.name}?`)) {
        setBusy(false);
        activateCard(true);
        return;
      }
      setMessage(text);
    } finally {
      setBusy(false);
    }
  };
  const blockCard = async (card: RfidCard) => {
    if (!window.confirm(`Block ${card.maskedIdentifier}? It will no longer be accepted for transactions.`)) return;
    try {
      await apiRequest(`/rfid/cards/${card.id}/block`, { method: "POST", body: JSON.stringify({ businessId: business.id }) });
      await loadCards();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to block this card.");
    }
  };
  const chooseCardCustomer = async (card: RfidCard, replacing = false) => {
    setCustomerQuery(card.customerId);
    setBusy(true);
    try {
      const query = new URLSearchParams({ businessId: String(business.id), query: card.customerId });
      const result = await apiRequest<{ customers: RfidCustomer[] }>(`/rfid/customers?${query.toString()}`);
      const customer = result.customers.find((item) => String(item.id) === String(card.customerId));
      if (!customer) throw new Error("The linked customer could not be found.");
      setSelectedCustomer(customer);
      setCustomerResults(result.customers);
      setDetectedIdentifier("");
      setReaderStatus("disconnected");
      setReplaceCardId(replacing ? card.id : "");
      setView("activate");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Customer lookup failed.");
    } finally {
      setBusy(false);
    }
  };
  const addPoints = async (event: FormEvent) => {
    event.preventDefault();
    if (!scanned) return;
    const amount = Number(pointsToAdd);
    setBusy(true);
    setMessage("");
    try {
      const result = await apiRequest<{ balance: number }>("/rfid/transactions/add", {
        method: "POST",
        body: JSON.stringify({
          businessId: business.id,
          cardId: scanned.card.id,
          points: amount,
          purchaseAmount: purchaseAmount || undefined,
          note: transactionNote,
          operationId: operationId.current,
        }),
      });
      setScanned({ ...scanned, customer: { ...scanned.customer, points: result.balance } });
      setSuccess({ title: "Points added successfully.", detail: `${amount.toLocaleString()} points added. New balance: ${result.balance.toLocaleString()} points.` });
      setView("success");
      onDataChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to add points.");
    } finally {
      setBusy(false);
    }
  };
  const redeemReward = async () => {
    if (!scanned || !selectedReward) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await apiRequest<{ balance: number }>("/rfid/transactions/redeem", {
        method: "POST",
        body: JSON.stringify({
          businessId: business.id,
          cardId: scanned.card.id,
          rewardId: selectedReward.id,
          operationId: operationId.current,
        }),
      });
      setScanned({ ...scanned, customer: { ...scanned.customer, points: result.balance } });
      setSuccess({ title: "Reward redeemed successfully.", detail: `${selectedReward.title} redeemed for ${selectedReward.points.toLocaleString()} points. Remaining balance: ${result.balance.toLocaleString()} points.` });
      setView("success");
      onDataChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to redeem this reward.");
    } finally {
      setBusy(false);
    }
  };
  const openHome = () => {
    setView("home");
    setMessage("");
    setSuccess(null);
    setReaderStatus("disconnected");
    setDetectedIdentifier("");
  };
  const openActivate = () => {
    setView("activate");
    setSelectedCustomer(null);
    setCustomerResults([]);
    setCustomerQuery("");
    setDetectedIdentifier("");
    setReplaceCardId("");
    setReaderStatus("disconnected");
    setMessage("");
  };
  const openScan = () => {
    setView("scan");
    setScanned(null);
    setDetectedIdentifier("");
    setReaderStatus("disconnected");
    setMessage("");
  };
  const readerPanel = (
    <div className="rfid-reader-panel">
      <div className="rfid-reader-head"><i><Icon name="nfc" size={23} /></i><div><b>USB RFID reader</b><span>{readerMode === "simulated" ? "Simulated reader mode — testing only" : readerStatus === "waiting" ? "Keyboard-emulation input armed" : readerStatus === "detected" ? "Card detected" : readerStatus === "failed" ? "Scan failed" : "Reader connection cannot be detected by the browser"}</span></div><em className={readerStatus}>{readerStatus === "waiting" ? "Waiting" : readerStatus === "detected" ? "Detected" : readerMode === "simulated" ? "Simulated" : "Not verified"}</em></div>
      <div className="rfid-mode-switch"><button className={readerMode === "keyboard" ? "active" : ""} onClick={() => { setReaderMode("keyboard"); setReaderStatus("disconnected"); }}>Keyboard reader</button><button className={readerMode === "simulated" ? "active" : ""} onClick={() => { setReaderMode("simulated"); setReaderStatus("ready"); }}>Simulated reader</button></div>
      {readerMode === "simulated" && <label className="field-label">Simulated card identifier<input className="field" value={simulatedIdentifier} onChange={(event) => setSimulatedIdentifier(event.target.value)} placeholder="e.g. TK4100-104928" /></label>}
      <Button disabled={busy || (readerMode === "simulated" && simulatedIdentifier.trim().length < 4)} className="w-full justify-center" onClick={readerMode === "simulated" ? presentSimulatedCard : startReader}><Icon name="nfc" size={18} />{readerMode === "simulated" ? "Present simulated card" : readerStatus === "waiting" ? "Waiting for RFID card…" : "Start scanning"}</Button>
      <p>Tap or present the customer’s loyalty card to the reader. Most TK4100 USB readers enter the card ID as keyboard input followed by Enter.</p>
    </div>
  );
  const visibleCards = cards.filter((card) =>
    (statusFilter === "all" || card.status === statusFilter) &&
    `${card.customerName} ${card.customerId} ${card.maskedIdentifier}`.toLowerCase().includes(cardFilter.toLowerCase())
  );

  return <div className="rfid-workspace">
    <header className="rfid-workspace-header"><button className="rfid-back" onClick={view === "home" ? onClose : openHome}><Icon name="back" size={19} />{view === "home" ? "Dashboard" : "RFID Cards"}</button><div><Brand light /></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></header>
    <main className="rfid-workspace-main">
      {view === "home" && <>
        <div className="rfid-page-heading"><div><div className="page-kicker">Physical loyalty cards</div><div className="page-title">RFID Cards</div><p>Activate, scan, and manage TK4100-compatible loyalty cards for {business.name}.</p></div></div>
        <div className="rfid-action-grid">
          <button onClick={openActivate}><i><Icon name="plus" size={25} /></i><span><b>Activate Card</b><small>Link a new physical card to an existing customer</small></span><Icon name="arrow" /></button>
          <button onClick={openScan}><i><Icon name="nfc" size={25} /></i><span><b>Scan Card</b><small>Open a customer balance and loyalty actions</small></span><Icon name="arrow" /></button>
        </div>
        <section className="rfid-management">
          <div className="rfid-management-toolbar"><div><b>Card management</b><span>{cards.length} registered card{cards.length === 1 ? "" : "s"}</span></div><label className="search-box"><Icon name="search" size={17} /><input value={cardFilter} onChange={(event) => setCardFilter(event.target.value)} placeholder="Search customer or card" /></label><select className="field" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="blocked">Blocked</option><option value="replaced">Replaced</option></select></div>
          <div className="rfid-table-head"><span>Card</span><span>Customer</span><span>Activated</span><span>Status</span><span>Last scanned</span><span>Actions</span></div>
          {visibleCards.length === 0 ? <div className="rfid-empty"><Icon name="card" size={25} /><b>No RFID cards found</b><span>Activate a card for an existing customer to see it here.</span></div> : visibleCards.map((card) => <div className="rfid-table-row" key={card.id}><span><b>{card.maskedIdentifier}</b><small>ID {card.id.slice(0, 8)}</small></span><span><b>{card.customerName}</b><small>Customer {card.customerId}</small></span><span>{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(card.activatedAt))}</span><span><em className={`rfid-card-status ${card.status}`}>{card.status}</em></span><span>{card.lastScannedAt ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(card.lastScannedAt)) : "Never"}</span><span className="rfid-row-actions"><button onClick={() => chooseCardCustomer(card)}>View customer</button>{card.status === "active" && <><button onClick={() => blockCard(card)}>Block</button><button onClick={() => chooseCardCustomer(card, true)}>Replace</button></>}</span></div>)}
        </section>
      </>}
      {view === "activate" && <>
        <div className="rfid-page-heading"><div><div className="page-kicker">{replaceCardId ? "Secure replacement" : "Card activation"}</div><div className="page-title">Activate Loyalty Card</div><p>Link one physical card to an existing customer in this business.</p></div></div>
        <div className="rfid-two-column">
          <section className="rfid-panel"><form onSubmit={searchCustomers}><label className="field-label">Find a customer<input className="field" value={customerQuery} onChange={(event) => setCustomerQuery(event.target.value)} placeholder="Customer ID, phone number, or name" /></label><Button disabled={busy || !customerQuery.trim()} type="submit" className="mt-3 w-full justify-center"><Icon name="search" size={17} />Search</Button></form>
            <div className="rfid-customer-results">{customerResults.map((customer) => <button className={selectedCustomer?.id === customer.id ? "selected" : ""} key={customer.id} onClick={() => setSelectedCustomer(customer)}><i className="avatar">{customer.name.split(" ").map((part) => part[0]).join("")}</i><span><b>{customer.name}</b><small>ID {customer.id} · {customer.phone}</small></span><strong>{customer.points.toLocaleString()} pts</strong></button>)}</div>
          </section>
          <section className="rfid-panel">{selectedCustomer ? <><div className="rfid-selected-customer"><i className="avatar large">{selectedCustomer.name.split(" ").map((part) => part[0]).join("")}</i><div><span>Selected customer</span><b>{selectedCustomer.name}</b><small>ID {selectedCustomer.id} · {selectedCustomer.phone}</small></div><strong>{selectedCustomer.points.toLocaleString()} pts</strong></div>{readerPanel}{detectedIdentifier && <div className="rfid-confirm-card"><span>Detected card</span><code>{detectedIdentifier}</code><p>Confirm that this card should be linked to {selectedCustomer.name}.</p><Button disabled={busy} className="w-full justify-center" onClick={() => activateCard(false)}><Icon name="check" size={18} />{busy ? "Activating…" : replaceCardId ? "Activate replacement card" : "Activate Card"}</Button></div>}</> : <div className="rfid-empty"><Icon name="users" size={25} /><b>Select an existing customer</b><span>A customer must belong to {business.name} before a card can be activated.</span></div>}</section>
        </div>
      </>}
      {view === "scan" && <>
        <div className="rfid-page-heading"><div><div className="page-kicker">Card reader</div><div className="page-title">Scan Loyalty Card</div><p>Retrieve the customer’s business-specific balance and rewards.</p></div></div>
        {!scanned ? <div className="rfid-scan-shell"><div className="rfid-scan-illustration"><Icon name="nfc" size={52} /><b>{readerStatus === "waiting" ? "Ready to scan" : "RFID loyalty card"}</b><span>{readerStatus === "waiting" ? "Present a card to the reader now" : "Start the reader when the customer is ready"}</span></div>{readerPanel}</div> : <section className="rfid-profile"><div className="rfid-profile-main"><i className="avatar large">{scanned.customer.name.split(" ").map((part) => part[0]).join("")}</i><div><span>Registered card detected</span><b>{scanned.customer.name}</b><small>Customer {scanned.customer.id} · {scanned.customer.maskedPhone}</small></div><div className="rfid-balance"><span>Current balance</span><strong>{scanned.customer.points.toLocaleString()}</strong><small>points</small></div></div><div className="rfid-profile-meta"><div><span>Card</span><b>{scanned.card.maskedIdentifier}</b></div><div><span>Available rewards</span><b>{scanned.rewards.filter((reward) => reward.available !== false && scanned.customer.points >= reward.points).length}</b></div><div><span>Last transaction</span><b>{scanned.lastTransaction?.description ?? "No transactions yet"}</b></div></div><div className="rfid-profile-actions"><Button onClick={() => { operationId.current = crypto.randomUUID(); setPointsToAdd(""); setPurchaseAmount(""); setTransactionNote(""); setView("add"); }}><Icon name="plus" size={18} />Add Points</Button><Button variant="secondary" onClick={() => setView("rewards")}><Icon name="gift" size={18} />Redeem Reward / Reduce Points</Button></div></section>}
      </>}
      {view === "add" && scanned && <section className="rfid-flow-card"><div className="page-kicker">RFID transaction</div><div className="page-title">Add Points</div><div className="rfid-flow-customer"><span>{scanned.customer.name}<small>Customer {scanned.customer.id}</small></span><strong>{scanned.customer.points.toLocaleString()} pts</strong></div><form onSubmit={addPoints}><label className="field-label">Points to Add<input required min="1" step="1" inputMode="numeric" type="number" className="field" value={pointsToAdd} onChange={(event) => setPointsToAdd(event.target.value)} placeholder="Enter a positive amount" /></label><label className="field-label">Purchase amount <span>Optional</span><input min="0" step=".01" inputMode="decimal" type="number" className="field" value={purchaseAmount} onChange={(event) => setPurchaseAmount(event.target.value)} placeholder="₹0.00" /></label><label className="field-label">Transaction note <span>Optional</span><textarea maxLength={180} className="field min-h-24 resize-none" value={transactionNote} onChange={(event) => setTransactionNote(event.target.value)} placeholder="Purchase or visit details" /></label><div className="rfid-balance-preview"><span>Current balance<b>{scanned.customer.points.toLocaleString()}</b></span><Icon name="arrow" /><span>New balance<b>{(scanned.customer.points + Math.max(0, Number(pointsToAdd) || 0)).toLocaleString()}</b></span></div><div className="rfid-form-actions"><Button variant="secondary" onClick={() => setView("scan")}>Cancel</Button><Button disabled={busy || !Number.isInteger(Number(pointsToAdd)) || Number(pointsToAdd) <= 0} type="submit">{busy ? "Adding…" : "Confirm Add Points"}</Button></div></form></section>}
      {view === "rewards" && scanned && <section className="rfid-flow-card wide"><div className="page-kicker">Configured rewards</div><div className="page-title">Redeem Reward / Reduce Points</div><p>Select a reward created in the existing rewards manager. Point deductions cannot be entered manually.</p><div className="rfid-reward-grid">{scanned.rewards.length === 0 ? <div className="rfid-empty"><Icon name="gift" /><b>No rewards configured</b><span>Create rewards in Manage rewards before using RFID redemption.</span></div> : scanned.rewards.map((reward) => { const short = Math.max(0, reward.points - scanned.customer.points); const disabled = reward.available === false || short > 0; return <div className={`rfid-reward-card ${disabled ? "disabled" : ""}`} key={reward.id}><i><Icon name="gift" size={21} /></i><div><b>{reward.title}</b><p>{reward.description}</p><strong>{reward.points.toLocaleString()} points</strong>{reward.available === false ? <small>Unavailable</small> : short > 0 ? <small>{short.toLocaleString()} more points needed</small> : <small>Available</small>}</div><Button disabled={disabled} onClick={() => { operationId.current = crypto.randomUUID(); setSelectedReward(reward); setView("redeem"); }}>Select Reward</Button></div>; })}</div><Button variant="secondary" onClick={() => setView("scan")}>Back to customer</Button></section>}
      {view === "redeem" && scanned && selectedReward && <section className="rfid-flow-card"><div className="page-kicker">Confirm redemption</div><div className="page-title">{selectedReward.title}</div><p>Deduct exactly the configured reward cost from {scanned.customer.name}.</p><div className="rfid-redemption-summary"><div><span>Current balance</span><b>{scanned.customer.points.toLocaleString()} points</b></div><div><span>Reward cost</span><b>−{selectedReward.points.toLocaleString()} points</b></div><div><span>Remaining balance</span><b>{(scanned.customer.points - selectedReward.points).toLocaleString()} points</b></div></div><div className="rfid-form-actions"><Button variant="secondary" onClick={() => setView("rewards")}>Cancel</Button><Button disabled={busy} onClick={redeemReward}>{busy ? "Redeeming…" : "Confirm Redemption"}</Button></div></section>}
      {view === "success" && success && <section className="rfid-success"><i><Icon name="check" size={30} /></i><div className="page-title">{success.title}</div><p>{success.detail}</p><div><Button variant="secondary" onClick={openHome}>Manage cards</Button>{scanned && <Button onClick={openScan}>Scan another card</Button>}</div></section>}
      {message && <div className="rfid-message" role="alert">{message}</div>}
    </main>
  </div>;
}

function BusinessDashboard({ onLogout, onNotifications, unreadCount, businesses, setBusinesses, customers, setCustomers, activities, setActivities, profile, onCustomerAdded, onCustomerChanged }: { onLogout: () => void; onNotifications: () => void; unreadCount: number; businesses: Business[]; setBusinesses: React.Dispatch<React.SetStateAction<Business[]>>; customers: Customer[]; setCustomers: React.Dispatch<React.SetStateAction<Customer[]>>; activities: Activity[]; setActivities: React.Dispatch<React.SetStateAction<Activity[]>>; profile?: Profile; onCustomerAdded: (customer: Customer, businessId: number) => void; onCustomerChanged: (customer: Customer, businessId: number) => void }) {
  const safeProfile: Profile = profile && typeof profile.name === "string"
    ? profile
    : { name: "Business owner", phone: "", isNew: false };
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showCardEditor, setShowCardEditor] = useState(false);
  const [showRewards, setShowRewards] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showVerify, setShowVerify] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [showNfc, setShowNfc] = useState(false);
  const [showRfid, setShowRfid] = useState(false);
  const [broadcastTitle, setBroadcastTitle] = useState("");
  const [broadcastBody, setBroadcastBody] = useState("");
  const [broadcastAudience, setBroadcastAudience] = useState(0);
  const [broadcastCampaigns, setBroadcastCampaigns] = useState<NotificationCampaign[]>([]);
  const [broadcastMessage, setBroadcastMessage] = useState("");
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [customPoints, setCustomPoints] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyResult, setVerifyResult] = useState<{ success: boolean; message: string; detail?: string } | null>(null);
  const [pointError, setPointError] = useState("");
  const [pointUpdating, setPointUpdating] = useState(false);
  const [qrImage, setQrImage] = useState("");
  const [editingRewardId, setEditingRewardId] = useState<number | null>(null);
  const [rewardTitle, setRewardTitle] = useState("");
  const [rewardPoints, setRewardPoints] = useState("250");
  const [rewardDescription, setRewardDescription] = useState("");
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const merchant = businesses[0];
  const [cardName, setCardName] = useState(merchant.name);
  const [cardColor, setCardColor] = useState(merchant.color);
  const [cardLogo, setCardLogo] = useState(merchant.logo);
  const selected = customers.find((item) => item.id === selectedId);
  const selectedActivities = selected
    ? activities.filter((item) => item.businessId === merchant.id && (item.phone ?? "").replace(/\D/g, "") === (selected.phone ?? "").replace(/\D/g, ""))
    : [];
  const filtered = customers.filter((item) => `${item.name} ${item.phone}`.toLowerCase().includes(search.toLowerCase()));
  const verifiedRewards = activities.filter((item) => item.businessId === merchant.id && (item.description ?? "").startsWith("Reward verified in store:"));
  const verifiedThisWeek = verifiedRewards.filter((item) => {
    const activityTime = new Date(item.occurredAt).getTime();
    return Number.isFinite(activityTime) && activityTime >= Date.now() - 7 * 24 * 60 * 60 * 1000;
  }).length;
  const businessQrCode = `LH-BIZ-${merchant.id}`;

  useEffect(() => {
    if (!showQr) return;
    QRCode.toDataURL(businessQrCode, { width: 720, margin: 2, color: { dark: "#092f26", light: "#ffffff" }, errorCorrectionLevel: "H" }).then(setQrImage);
  }, [showQr, businessQrCode]);

  useEffect(() => {
    if (!selectedId || !selected) return;
    const customerId = selectedId;
    const phone = selected.phone;
    const syncSelectedBalance = async () => {
      try {
        const query = new URLSearchParams({ businessId: String(merchant.id), phone });
        const result = await apiRequest<{ balance: number; activities?: Activity[] }>(`/customer-balance?${query.toString()}`);
        const customerActivities = Array.isArray(result.activities) ? result.activities : [];
        setCustomers((items) => items.map((customer) => customer.id === customerId && customer.points !== result.balance ? { ...customer, points: result.balance } : customer));
        setActivities((items) => {
          const otherCustomers = items.filter((activity) => !(activity.businessId === merchant.id && (activity.phone ?? "").replace(/\D/g, "") === phone.replace(/\D/g, "")));
          const merged = [...customerActivities, ...otherCustomers];
          return JSON.stringify(merged) === JSON.stringify(items) ? items : merged;
        });
      } catch (error) {
        console.error("Unable to refresh selected customer balance", error);
      }
    };
    const timer = window.setInterval(syncSelectedBalance, 3000);
    syncSelectedBalance();
    return () => window.clearInterval(timer);
  }, [merchant.id, selectedId]);

  const updatePoints = async (amount: number) => {
    if (!selectedId || !selected) return;
    setPointError("");
    setPointUpdating(true);
    try {
      const result = await apiRequest<{ balance: number }>("/adjust-points", {
        method: "POST",
        body: JSON.stringify({ businessId: merchant.id, phone: selected.phone, delta: amount }),
      });
      const updated = { ...selected, points: result.balance };
      setCustomers((items) => items.map((item) => item.id === selectedId ? updated : item));
      setActivities((items) => [{
        id: Date.now() + Math.random(),
        businessId: merchant.id,
        customerName: selected.name,
        phone: selected.phone,
        type: amount > 0 ? "issued" : "adjusted",
        points: Math.abs(amount),
        description: amount > 0 ? "Points issued by business" : "Manual point adjustment",
        occurredAt: new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date()),
      }, ...items]);
    } catch (error) {
      setPointError(error instanceof Error ? error.message : "Unable to update points.");
    } finally {
      setPointUpdating(false);
    }
  };
  const updateReward = (reward: string) => {
    if (!selectedId || !selected) return;
    const updated = { ...selected, reward };
    setCustomers((items) => items.map((item) => item.id === selectedId ? updated : item));
    onCustomerChanged(updated, merchant.id);
  };
  const addCustomPoints = () => {
    const amount = Number(customPoints);
    if (!Number.isFinite(amount) || amount <= 0) return;
    updatePoints(Math.floor(amount));
    setCustomPoints("");
  };
  const verifyClaim = async (event: FormEvent) => {
    event.preventDefault();
    setVerifyResult(null);
    try {
      const result = await apiRequest<{ claim: { customerName: string; title: string; points: number } }>("/verify-claim", {
        method: "POST",
        body: JSON.stringify({ code: verifyCode }),
      });
      setVerifyResult({ success: true, message: "Claim verified successfully", detail: `${result.claim.customerName} · ${result.claim.title} · ${result.claim.points} points` });
      setVerifyCode("");
    } catch (error) {
      setVerifyResult({ success: false, message: error instanceof Error ? error.message : "Unable to verify this claim code." });
    }
  };
  const addCustomer = (event: FormEvent) => {
    event.preventDefault();
    const customer = { id: Date.now(), name: newName, phone: newPhone, points: 0, reward: "Welcome reward", joined: "Just now" };
    setCustomers((items) => [customer, ...items]);
    onCustomerAdded(customer, merchant.id);
    setNewName("");
    setNewPhone("");
    setShowAdd(false);
  };
  const openCardEditor = () => {
    setCardName(merchant.name);
    setCardColor(merchant.color);
    setCardLogo(merchant.logo);
    setShowCardEditor(true);
  };
  const saveCard = (event: FormEvent) => {
    event.preventDefault();
    setBusinesses((items) => items.map((item) => item.id === merchant.id ? { ...item, name: cardName.trim(), color: cardColor, logo: cardLogo } : item));
    setShowCardEditor(false);
  };
  const chooseLogo = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCardLogo(String(reader.result));
    reader.readAsDataURL(file);
  };
  const resetRewardForm = () => {
    setEditingRewardId(null);
    setRewardTitle("");
    setRewardPoints("250");
    setRewardDescription("");
  };
  const editReward = (reward: Reward) => {
    setEditingRewardId(reward.id);
    setRewardTitle(reward.title);
    setRewardPoints(String(reward.points));
    setRewardDescription(reward.description);
  };
  const saveReward = (event: FormEvent) => {
    event.preventDefault();
    const reward: Reward = { id: editingRewardId ?? Date.now(), title: rewardTitle.trim(), points: Number(rewardPoints), description: rewardDescription.trim() };
    setBusinesses((items) => items.map((item) => item.id !== merchant.id ? item : {
      ...item,
      rewards: editingRewardId ? item.rewards.map((current) => current.id === editingRewardId ? reward : current) : [...item.rewards, reward],
    }));
    resetRewardForm();
  };
  const openBroadcast = async () => {
    setShowBroadcast(true);
    setBroadcastMessage("");
    try {
      const [audience, campaigns] = await Promise.all([
        apiRequest<{ eligibleRecipients: number }>(`/business/${merchant.id}/notification-audience`),
        apiRequest<{ campaigns: NotificationCampaign[] }>(`/business/${merchant.id}/campaigns`),
      ]);
      setBroadcastAudience(audience.eligibleRecipients);
      setBroadcastCampaigns(campaigns.campaigns);
    } catch (error) {
      setBroadcastMessage(error instanceof Error ? error.message : "Unable to load notification audience.");
    }
  };
  const sendBroadcast = async (event: FormEvent) => {
    event.preventDefault();
    setBroadcastBusy(true);
    setBroadcastMessage("");
    try {
      const result = await apiRequest<{ campaignId: string; eligibleRecipients: number }> (`/business/${merchant.id}/broadcast`, {
        method: "POST",
        body: JSON.stringify({ title: broadcastTitle, body: broadcastBody }),
      });
      setBroadcastMessage(`Notification queued for ${result.eligibleRecipients} opted-in member${result.eligibleRecipients === 1 ? "" : "s"}.`);
      setBroadcastCampaigns((items) => [{ id: result.campaignId, title: broadcastTitle, body: broadcastBody, status: "queued", eligibleRecipients: result.eligibleRecipients, inboxCreated: 0, pushesDelivered: 0, createdAt: new Date().toISOString() }, ...items]);
      setBroadcastTitle("");
      setBroadcastBody("");
    } catch (error) {
      setBroadcastMessage(error instanceof Error ? error.message : "Unable to send this notification.");
    } finally {
      setBroadcastBusy(false);
    }
  };
  const syncNfcReporting = async () => {
    try {
      const result = await apiRequest<{ state: { customers?: Customer[]; activities?: Activity[] } | null }>("/me");
      if (result.state?.customers) setCustomers(result.state.customers);
      if (result.state?.activities) setActivities(result.state.activities);
    } catch {
      // The NFC panel continues polling and will retry reconciliation.
    }
  };

  return (
    <div className="min-h-screen bg-[#f5f8f6]">
      <DashboardHeader title={merchant.name} subtitle="Business portal" onLogout={onLogout} onSettings={() => setShowSettings(true)} onNotifications={onNotifications} unreadCount={unreadCount} floating />
      <main className="dashboard-main">
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
          <div><div className="page-kicker">Business overview</div><div className="page-title">Good morning, {safeProfile.name.split(" ")[0]}.</div><p className="mt-2 text-[#6e7d77]">{safeProfile.isNew ? "Your new loyalty account is ready to set up." : "Here’s what’s happening with your loyalty community."}</p></div>
          <div className="flex flex-wrap gap-2"><Button onClick={() => setShowRfid(true)}><Icon name="nfc" size={18} />RFID Cards</Button><Button variant="secondary" onClick={() => setShowNfc(true)}><Icon name="nfc" size={18} />Issue points by NFC</Button><Button variant="secondary" onClick={() => setShowQr(true)}><Icon name="grid" size={18} />View QR code</Button><Button variant="secondary" onClick={() => setShowHistory(true)}><Icon name="grid" size={18} />History</Button><Button variant="secondary" onClick={() => setShowRewards(true)}><Icon name="gift" size={18} />Manage rewards</Button><Button variant="secondary" onClick={openCardEditor}><Icon name="card" size={18} />Edit loyalty card</Button><Button variant="secondary" onClick={openBroadcast}><Icon name="bell" size={18} />Send notification</Button><Button onClick={() => setShowAdd(true)}><Icon name="plus" size={18} />Add customer</Button></div>
        </div>

        <section className="stats-grid">
          <div className="stat-card"><i className="stat-icon"><Icon name="users" /></i><div><span>Total customers</span><strong>{customers.length}</strong><small>{safeProfile.isNew ? "Ready for your first customer" : "+12% this month"}</small></div></div>
          <div className="stat-card"><i className="stat-icon gold"><Icon name="spark" /></i><div><span>Points issued</span><strong>{customers.reduce((sum, item) => sum + item.points, 0).toLocaleString()}</strong><small>Across all customers</small></div></div>
          <div className="stat-card"><i className="stat-icon pale"><Icon name="gift" /></i><div><span>Rewards redeemed</span><strong>{verifiedRewards.length}</strong><small>{verifiedThisWeek === 0 ? "No verifications this week" : `${verifiedThisWeek} verified this week`}</small></div></div>
        </section>

        <section className="table-card">
          <div className="table-toolbar">
            <div><div className="text-lg font-extrabold text-[#153d32]">Your customers</div><div className="mt-1 text-sm text-[#7a8984]">Manage points and rewards for each member.</div></div>
            <label className="search-box"><Icon name="search" size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or phone" /></label>
          </div>
          <div className="hidden grid-cols-[1.35fr_1fr_.65fr_.8fr_1.1fr_.2fr] gap-4 border-y border-[#e7edea] bg-[#f9fbfa] px-6 py-3 text-[.69rem] font-extrabold uppercase tracking-[.1em] text-[#82908b] md:grid">
            <span>Customer</span><span>Phone</span><span>Points</span><span>Issued by NFC</span><span>Current reward</span><span></span>
          </div>
          <div>
            {filtered.map((customer) => (
              <button key={customer.id} onClick={() => setSelectedId(customer.id)} className="customer-row">
                <span className="flex items-center gap-3"><i className="avatar">{customer.name.split(" ").map((part) => part[0]).join("")}</i><span><b>{customer.name}</b><small>Joined {customer.joined}</small></span></span>
                <span className="muted-cell"><Icon name="phone" size={14} />{customer.phone}</span>
                <span className="point-pill">{customer.points.toLocaleString()} pts</span>
                <span className="nfc-points-cell">{customer.nfcPoints ? `${customer.nfcPoints.toLocaleString()} pts` : "—"}</span>
                <span className="reward-cell">{customer.reward}</span>
                <Icon name="chevron" size={17} />
              </button>
            ))}
          </div>
        </section>
      </main>

      {selected && <div className="modal-backdrop" onMouseDown={() => setSelectedId(null)}><section className="side-panel" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between"><div className="page-kicker">Customer account</div><button className="icon-button" onClick={() => setSelectedId(null)} aria-label="Close">×</button></div>
        <div className="mt-8 flex items-center gap-4"><i className="avatar large">{selected.name.split(" ").map((part) => part[0]).join("")}</i><div><div className="text-xl font-extrabold text-[#123b30]">{selected.name}</div><div className="mt-1 text-sm text-[#72817c]">{selected.phone}</div></div></div>
        <div className="points-balance"><span>Current balance</span><strong>{selected.points.toLocaleString()}</strong><small>loyalty points</small></div>
        <div className="mt-8"><label className="field-label">Adjust points</label><div className="mt-2 grid grid-cols-3 gap-2"><Button disabled={pointUpdating} variant="secondary" onClick={() => updatePoints(-50)}><Icon name="minus" size={15} />50</Button><Button disabled={pointUpdating} variant="secondary" onClick={() => updatePoints(50)}><Icon name="plus" size={15} />50</Button><Button disabled={pointUpdating} onClick={() => updatePoints(100)}><Icon name="plus" size={15} />100</Button></div><div className="custom-points"><input disabled={pointUpdating} type="number" min="1" inputMode="numeric" value={customPoints} onChange={(event) => setCustomPoints(event.target.value)} placeholder="Enter any number of points" /><Button disabled={pointUpdating} onClick={addCustomPoints}><Icon name="plus" size={16} />{pointUpdating ? "Saving…" : "Add points"}</Button></div>{pointError && <span className="field-error-message" role="alert">{pointError}</span>}</div>
        <label className="field-label mt-7">Issued reward<select className="field" aria-label="Reward and reason for issuing" value={selected.reward} onChange={(event) => updateReward(event.target.value)}><option value="Free signature drink">Free signature drink — Loyalty milestone reached</option><option value="10% off next visit">10% off next visit — Thank you for returning</option><option value="Free pastry">Free pastry — Points achievement reward</option><option value="VIP tasting menu">VIP tasting menu — VIP customer recognition</option><option value="Welcome reward">Welcome reward — New customer appreciation</option></select></label>
        <div className="customer-activity"><div className="flex items-center justify-between"><b>Customer activity</b><span>{selectedActivities.length} records</span></div>{selectedActivities.length === 0 ? <p>No activity recorded for this customer yet.</p> : selectedActivities.slice(0, 12).map((item) => <div className="customer-activity-row" key={item.id}><i className={item.type}><Icon name={item.type === "claimed" ? "gift" : item.type === "nfc_issued" ? "nfc" : item.type === "issued" ? "plus" : "minus"} size={14} /></i><div><b>{item.description}</b><small><em className={`activity-kind ${item.type}`}>{item.type === "nfc_issued" ? "Issued by NFC" : item.type === "issued" ? "Points issued" : item.type === "claimed" ? "Points claimed" : "Adjustment"}</em>{item.occurredAt}</small></div><span className={item.type}>{item.type === "issued" || item.type === "nfc_issued" ? "+" : "−"}{item.points} pts</span></div>)}</div>
        <div className="mt-auto rounded-2xl bg-[#f2f7f4] p-4 text-sm leading-6 text-[#667871]"><b className="text-[#1b4d3e]">Merchant-safe balance</b><br />These points are stored only under {merchant.name} and never mixed with another business.</div>
      </section></div>}

      {showAdd && <div className="modal-backdrop" onMouseDown={() => setShowAdd(false)}><form onSubmit={addCustomer} className="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between"><div><div className="text-xl font-extrabold text-[#123b30]">Add a customer</div><p className="mt-1 text-sm text-[#73827d]">Connect a customer to your loyalty program.</p></div><button type="button" className="icon-button" onClick={() => setShowAdd(false)}>×</button></div>
        <label className="field-label mt-7">Customer name<input required className="field" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="e.g. Avery Johnson" /></label>
        <label className="field-label mt-5">Phone number<PhoneField onChange={setNewPhone} /></label>
        <Button type="submit" className="mt-7 w-full justify-center">Add to Perklyn<Icon name="arrow" size={18} /></Button>
      </form></div>}

      {showCardEditor && <div className="modal-backdrop card-editor-backdrop" onMouseDown={() => setShowCardEditor(false)}><form onSubmit={saveCard} className="card-editor" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between"><div><div className="page-kicker">Customer-facing card</div><div className="mt-2 text-2xl font-extrabold tracking-[-.04em] text-[#123b30]">Design your loyalty card</div><p className="mt-2 text-sm text-[#73827d]">Changes appear on every connected customer’s wallet.</p></div><button type="button" className="icon-button" onClick={() => setShowCardEditor(false)}>×</button></div>
        <div className={`card-editor-preview bg-gradient-to-br ${cardColor}`}>
          <div className="card-glow" />
          <div className="relative z-10 flex h-full flex-col justify-between">
            <div className="flex items-start justify-between"><div className="editor-logo"><img src={cardLogo} alt="Business logo preview" /></div><span className="text-xs font-extrabold tracking-[-.02em] text-[#d4b95e]">Perklyn</span></div>
            <div><div className="text-xs text-white/55">Your loyalty card</div><div className="mt-1 text-2xl font-extrabold text-white">{cardName || "Your business name"}</div></div>
          </div>
        </div>
        <label className="field-label mt-7">Business name shown on card<input required className="field" value={cardName} onChange={(event) => setCardName(event.target.value)} maxLength={40} /></label>
        <div className="field-label mt-6">Card color<div className="color-options">{cardColors.map((option) => <button type="button" key={option.name} onClick={() => setCardColor(option.value)} aria-label={option.name} aria-pressed={cardColor === option.value} className={`color-swatch bg-gradient-to-br ${option.value} ${cardColor === option.value ? "selected" : ""}`}><Icon name="check" size={15} /></button>)}</div></div>
        <div className="field-label mt-6">Business logo<label className="logo-uploader"><span className="upload-logo-preview"><img src={cardLogo} alt="" /></span><span><b>Upload a new logo</b><small>PNG, JPG or WebP. Square images work best.</small></span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => chooseLogo(event.target.files?.[0])} /></label></div>
        <div className="mt-7 flex justify-end gap-2"><Button variant="secondary" onClick={() => setShowCardEditor(false)}>Cancel</Button><Button type="submit">Save card changes<Icon name="check" size={17} /></Button></div>
      </form></div>}

      {showRewards && <div className="modal-backdrop card-editor-backdrop" onMouseDown={() => setShowRewards(false)}><section className="reward-manager" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between"><div><div className="page-kicker">Customer rewards</div><div className="mt-2 text-2xl font-extrabold tracking-[-.04em] text-[#123b30]">Manage rewards</div><p className="mt-2 text-sm text-[#73827d]">These rewards appear under your card in the customer wallet.</p></div><button className="icon-button" onClick={() => setShowRewards(false)}>×</button></div>
        <div className="reward-manager-grid">
          <div className="space-y-3">
            <div className="text-xs font-extrabold uppercase tracking-[.12em] text-[#83908c]">Active rewards</div>
            {merchant.rewards.map((reward) => <div className={`merchant-reward ${editingRewardId === reward.id ? "active" : ""}`} key={reward.id}><i><Icon name="gift" size={18} /></i><div><b>{reward.title}</b><small>{reward.points} points · {reward.description}</small></div><button onClick={() => editReward(reward)}>Edit</button></div>)}
          </div>
          <form onSubmit={saveReward} className="reward-form">
            <div className="text-sm font-extrabold text-[#153d32]">{editingRewardId ? "Edit reward" : "Add a reward"}</div>
            <label className="field-label mt-5">Reward name<input required className="field" value={rewardTitle} onChange={(event) => setRewardTitle(event.target.value)} placeholder="e.g. Free signature drink" /></label>
            <label className="field-label mt-4">Points required<input required min="1" className="field" type="number" value={rewardPoints} onChange={(event) => setRewardPoints(event.target.value)} /></label>
            <label className="field-label mt-4">Description<textarea required className="field min-h-24 resize-none" value={rewardDescription} onChange={(event) => setRewardDescription(event.target.value)} placeholder="What the customer can redeem in store" /></label>
            <div className="mt-5 flex gap-2">{editingRewardId && <Button variant="secondary" onClick={resetRewardForm}>Cancel</Button>}<Button type="submit" className="flex-1">{editingRewardId ? "Save changes" : "Add reward"}<Icon name={editingRewardId ? "check" : "plus"} size={16} /></Button></div>
          </form>
        </div>
      </section></div>}

      {showHistory && <div className="modal-backdrop card-editor-backdrop" onMouseDown={() => setShowHistory(false)}><section className="history-panel" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between"><div><div className="page-kicker">Points ledger</div><div className="mt-2 text-2xl font-extrabold tracking-[-.04em] text-[#123b30]">Customer activity history</div><p className="mt-2 text-sm text-[#73827d]">Track who received points and who claimed rewards.</p></div><button className="icon-button" onClick={() => setShowHistory(false)}>×</button></div>
        <div className="history-summary"><div><span>Points issued</span><strong>{activities.filter((item) => item.businessId === merchant.id && (item.type === "issued" || item.type === "nfc_issued")).reduce((sum, item) => sum + item.points, 0)}</strong></div><div><span>Points claimed</span><strong>{activities.filter((item) => item.businessId === merchant.id && item.type === "claimed").reduce((sum, item) => sum + item.points, 0)}</strong></div><div><span>Total activities</span><strong>{activities.filter((item) => item.businessId === merchant.id).length}</strong></div></div>
        <div className="business-history-list">
          {activities.filter((item) => item.businessId === merchant.id).map((item) => <div className="business-history-row" key={item.id}><i className={item.type}><Icon name={item.type === "claimed" ? "gift" : item.type === "nfc_issued" ? "nfc" : item.type === "issued" ? "plus" : "minus"} size={17} /></i><div><b>{item.customerName}</b><small>{item.phone}</small></div><div className="history-description"><b>{item.description}</b><small>{item.occurredAt}</small></div><span className={item.type}>{item.type === "issued" || item.type === "nfc_issued" ? "+" : "−"}{item.points} pts</span></div>)}
        </div>
      </section></div>}
      {showQr && <div className="modal-backdrop card-editor-backdrop" onMouseDown={() => setShowQr(false)}><section className="business-qr-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <button className="icon-button qr-close" onClick={() => setShowQr(false)}>×</button>
        <div className="qr-business-logo"><img src={merchant.logo} alt="" /></div>
        <div className="mt-4 text-2xl font-extrabold tracking-[-.04em] text-[#123b30]">{merchant.name}</div>
        <p>Customers can scan this unique code to join your loyalty program.</p>
        <div className="qr-image-shell">{qrImage ? <img src={qrImage} alt={`QR code for ${merchant.name}`} /> : <span>Generating secure QR…</span>}</div>
        <div className="business-code-label">Unique business code</div><code>{businessQrCode}</code>
        <div className="qr-security-note"><Icon name="check" size={16} />This QR code belongs only to {merchant.name}.</div>
      </section></div>}
      {showBroadcast && <div className="modal-backdrop card-editor-backdrop" onMouseDown={() => setShowBroadcast(false)}><section className="broadcast-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between"><div><div className="page-kicker">Member communication</div><div className="mt-2 text-2xl font-extrabold tracking-[-.04em] text-[#123b30]">Send a notification</div><p className="mt-2 text-sm text-[#73827d]">Reach opted-in members of {merchant.name}. Up to 3 broadcasts are allowed every 24 hours.</p></div><button className="icon-button" onClick={() => setShowBroadcast(false)} aria-label="Close">×</button></div>
        <div className="broadcast-audience"><Icon name="users" size={18} /><div><b>{broadcastAudience} eligible member{broadcastAudience === 1 ? "" : "s"}</b><span>Customers control promotional notifications in their own settings.</span></div></div>
        <form onSubmit={sendBroadcast} className="broadcast-grid">
          <div>
            <label className="field-label">Title <span>{broadcastTitle.length}/60</span><input required maxLength={60} className="field" value={broadcastTitle} onChange={(event) => setBroadcastTitle(event.target.value)} placeholder="Weekend reward bonus" /></label>
            <label className="field-label mt-5">Message <span>{broadcastBody.length}/180</span><textarea required maxLength={180} className="field min-h-28 resize-none" value={broadcastBody} onChange={(event) => setBroadcastBody(event.target.value)} placeholder="Earn double points this Saturday at our store." /></label>
            <Button disabled={broadcastBusy || broadcastAudience === 0} type="submit" className="mt-5 w-full justify-center"><Icon name="bell" size={17} />{broadcastBusy ? "Queuing…" : "Send to members"}</Button>
            {broadcastMessage && <div className="broadcast-message" role="status">{broadcastMessage}</div>}
          </div>
          <div>
            <div className="text-xs font-extrabold uppercase tracking-[.12em] text-[#83908c]">Notification preview</div>
            <div className="push-preview"><img src="/icons/perklyn-192.png" alt="" /><div><small><span className="font-extrabold text-[#d4b95e]">Perklyn</span> · now</small><b>{broadcastTitle || "Your notification title"}</b><span>{broadcastBody || "Your message will appear here."}</span></div></div>
            <div className="recent-campaigns"><b>Recent sends</b>{broadcastCampaigns.length === 0 ? <span>No campaigns sent yet.</span> : broadcastCampaigns.slice(0, 3).map((campaign) => <div key={campaign.id}><span><b>{campaign.title}</b><small>{campaign.eligibleRecipients} members · {campaign.status}</small></span><em>{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(campaign.createdAt))}</em></div>)}</div>
          </div>
        </form>
      </section></div>}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showNfc && <NfcManager businessId={merchant.id} onClose={() => setShowNfc(false)} onClaimed={syncNfcReporting} />}
      {showRfid && <RfidWorkspace business={merchant} onClose={() => setShowRfid(false)} onDataChanged={syncNfcReporting} />}
      {showVerify && <div className="modal-backdrop card-editor-backdrop" onMouseDown={() => setShowVerify(false)}><form className="verify-dialog" onSubmit={verifyClaim} onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between"><div><div className="page-kicker">In-store redemption</div><div className="mt-2 text-2xl font-extrabold tracking-[-.04em] text-[#123b30]">Verify claim code</div><p className="mt-2 text-sm text-[#73827d]">Enter the code shown on the customer’s phone. Codes are valid for 24 hours and can only be used once.</p></div><button type="button" className="icon-button" onClick={() => setShowVerify(false)}>×</button></div>
        <label className="field-label mt-7">Customer claim code<input required className="field claim-code-input" value={verifyCode} onChange={(event) => setVerifyCode(event.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase())} placeholder="e.g. A1B2C3D4" maxLength={8} /></label>
        <Button type="submit" className="mt-5 w-full justify-center"><Icon name="check" size={18} />Verify reward claim</Button>
        {verifyResult && <div className={`verify-result ${verifyResult.success ? "success" : "error"}`}><Icon name={verifyResult.success ? "check" : "minus"} size={18} /><div><b>{verifyResult.message}</b>{verifyResult.detail && <span>{verifyResult.detail}</span>}</div></div>}
      </form></div>}
      <BottomIsland
        portal="business"
        onLogout={onLogout}
        actions={[
          { label: "RFID Cards", description: "Activate, scan, and manage physical loyalty cards", icon: "nfc", onClick: () => setShowRfid(true) },
          { label: "Issue points by NFC", description: "Create a secure five-minute point issue", icon: "nfc", onClick: () => setShowNfc(true) },
          { label: "View QR code", description: "Show your unique customer join code", icon: "grid", onClick: () => setShowQr(true) },
          { label: "Customer history", description: "Review issued and claimed points", icon: "grid", onClick: () => setShowHistory(true) },
          { label: "Manage rewards", description: "Add or edit customer rewards", icon: "gift", onClick: () => setShowRewards(true) },
          { label: "Send notification", description: "Message opted-in loyalty members", icon: "bell", onClick: openBroadcast },
          { label: "Edit loyalty card", description: "Change your card name, color, and logo", icon: "card", onClick: openCardEditor },
          { label: "Add customer", description: "Connect a customer to your business", icon: "plus", onClick: () => setShowAdd(true) },
          { label: "Verify claim code", description: "Confirm a customer reward in store", icon: "check", onClick: () => { setVerifyResult(null); setShowVerify(true); } },
          { label: "Settings & support", description: "Call or email customer care", icon: "settings", onClick: () => setShowSettings(true) },
        ]}
      />
    </div>
  );
}

function CustomerDashboard({ onLogout, onNotifications, unreadCount, notificationBusinessId, businesses, setBusinesses, directory, claims, setClaims, setActivities, profile }: { onLogout: () => void; onNotifications: () => void; unreadCount: number; notificationBusinessId: number | null; businesses: Business[]; setBusinesses: React.Dispatch<React.SetStateAction<Business[]>>; directory: Business[]; claims: Claim[]; setClaims: React.Dispatch<React.SetStateAction<Claim[]>>; setActivities: React.Dispatch<React.SetStateAction<Activity[]>>; profile?: Profile }) {
  const safeProfile: Profile = profile && typeof profile.name === "string"
    ? profile
    : { name: "Perklyn member", phone: "Phone not set", isNew: false };
  const [selected, setSelected] = useState<Business | null>(null);
  const [claimMessage, setClaimMessage] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [scanNotice, setScanNotice] = useState("");
  const [claimingRewardId, setClaimingRewardId] = useState<number | null>(null);
  const total = useMemo(() => businesses.reduce((sum, item) => sum + item.points, 0), [businesses]);
  const businessClaims = selected ? claims.filter((claim) => claim.businessId === selected.id) : [];
  const businessTransactions = selected?.transactions ?? [];
  useEffect(() => {
    if (!notificationBusinessId) return;
    const business = businesses.find((item) => item.id === notificationBusinessId);
    if (business) setSelected(business);
  }, [businesses, notificationBusinessId]);
  const claimReward = async (reward: Reward) => {
    if (!selected || selected.points < reward.points) return;
    const businessId = selected.id;
    setClaimingRewardId(reward.id);
    try {
      await apiRequest<{ verificationCodes: true }>("/claim-capabilities");
      const result = await apiRequest<{ balance: number; claimCode: string; expiresAt: string }>("/claim-reward", {
        method: "POST",
        body: JSON.stringify({ businessId, rewardId: reward.id, title: reward.title, points: reward.points }),
      });
    setClaims((items) => [{ id: Date.now() + Math.random(), businessId, rewardId: reward.id, title: reward.title, points: reward.points, claimedAt: new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date()), claimCode: result.claimCode, expiresAt: result.expiresAt }, ...items]);
    setActivities((items) => [{
      id: Date.now() + Math.random(),
      businessId,
      customerName: safeProfile.name,
      phone: safeProfile.phone,
      type: "claimed",
      points: reward.points,
      description: `Claimed: ${reward.title}`,
      occurredAt: new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date()),
    }, ...items]);
    setBusinesses((items) => items.map((business) => business.id === businessId ? { ...business, points: result.balance } : business));
    setSelected((business) => business ? { ...business, points: result.balance } : business);
    setClaimMessage(`${reward.title} is ready. Show code ${result.claimCode} to staff in store within 24 hours. ${reward.points} points were deducted.`);
    } catch (error) {
      setClaimMessage(error instanceof Error ? error.message : "Unable to claim this reward.");
    } finally {
      setClaimingRewardId(null);
    }
  };
  const joinBusiness = async (value: string) => {
    const id = Number(value.match(/LH-BIZ-(\d+)/i)?.[1]);
    let business = directory.find((item) => item.id === id);
    if (!business && id) {
      try {
        const result = await apiRequest<{ business: Business }>(`/business/${id}`);
        business = result.business;
      } catch {
        setScanNotice("This QR code does not match an active Perklyn business.");
        return;
      }
    }
    if (!business) return setScanNotice("This QR code does not match an active Perklyn business.");
    if (businesses.some((item) => item.id === business.id)) {
      setScanNotice(`You are already connected to ${business.name}.`);
      setShowScanner(false);
      return;
    }
    try {
      const result = await apiRequest<{ business: Business; membership: { points: number; reward: string } }>("/join-business", {
        method: "POST",
        body: JSON.stringify({ businessId: business.id }),
      });
      setBusinesses((items) => [...items, { ...result.business, points: result.membership.points, reward: result.membership.reward, progress: 0 }]);
      setScanNotice(`You joined ${business.name}. Your new loyalty balance starts at ${result.membership.points} points.`);
      setShowScanner(false);
    } catch (error) {
      setScanNotice(error instanceof Error ? error.message : "Unable to join this business.");
    }
  };
  return (
    <div className="min-h-screen bg-[#f5f8f6]">
      <DashboardHeader title="My loyalty wallet" subtitle="Customer portal" onLogout={onLogout} onSettings={() => setShowSettings(true)} onNotifications={onNotifications} unreadCount={unreadCount} customer floating />
      <main className="dashboard-main">
        <section className="wallet-hero">
          <div className="relative z-10 max-w-[35rem]"><div className="eyebrow text-[#eadb9d]">Your reward wallet</div><div className="mt-4 text-[clamp(2.3rem,4vw,3.8rem)] font-extrabold leading-none tracking-[-0.055em]">Welcome, {safeProfile.name.split(" ")[0]}.</div><p className="mt-5 text-[#c8d8d2]">{safeProfile.isNew ? "Your new wallet is ready for its first business connection." : "Your favorite places are all connected to this number."}</p><div className="mt-6 flex items-center gap-3 text-sm font-bold"><span className="rounded-full bg-white/10 px-4 py-2">{safeProfile.phone}</span><span className="rounded-full bg-[#d9bd61] px-4 py-2 text-[#133b30]">{total.toLocaleString()} points</span></div></div>
          <img src="/perklyn-logo.svg" alt="" className="wallet-hero-logo" />
        </section>
        <div className="mt-12 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end"><div><div className="page-kicker">Connected businesses</div><div className="page-title">Your loyalty cards</div></div><div className="flex items-center gap-3"><span className="hidden text-sm text-[#74837d] sm:block">{businesses.length} active memberships</span><Button onClick={() => { setScanNotice(""); setShowScanner(true); }}><Icon name="grid" size={18} />Scan business QR</Button></div></div>
        {scanNotice && <div className="scan-notice"><Icon name="check" size={17} />{scanNotice}</div>}
        <section className="business-grid">
          {businesses.map((business) => (
            <button key={business.id} onClick={() => { setSelected(business); setClaimMessage(""); }} className="business-tile">
              <div className={`mini-card bg-gradient-to-br ${business.color}`}>
                <div className="flex items-start justify-between"><div className="mini-logo"><img src={business.logo} alt="" /></div><span className="text-xs font-extrabold tracking-[-.02em] text-[#d4b95e]">Perklyn</span></div>
                <div><div className="text-lg font-extrabold text-white">{business.name}</div><div className="mt-1 text-xs text-white/60">{business.category}</div></div>
              </div>
              <div className="p-5 text-left"><div className="flex items-end justify-between"><div><div className="text-xs font-bold uppercase tracking-[.12em] text-[#87938f]">Balance</div><div className="mt-1 text-2xl font-extrabold text-[#123b30]">{business.points.toLocaleString()} <small className="text-sm">pts</small></div></div><i className="round-arrow"><Icon name="arrow" size={17} /></i></div><div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#e7edea]"><div className="h-full rounded-full bg-[#c2a84f]" style={{ width: `${business.progress}%` }} /></div><div className="mt-2 text-xs text-[#73817c]">{business.reward}</div></div>
            </button>
          ))}
        </section>
        {businesses.length === 0 && <section className="empty-wallet"><i><Icon name="card" size={25} /></i><div className="text-lg font-extrabold text-[#1a4639]">No businesses connected yet</div><p>Give your phone number to a participating business. Their loyalty card and your first points will appear here.</p></section>}
        <section className="secure-note"><i><Icon name="check" /></i><div><b>Your points are safe and separate</b><p>Each business manages its own balance, so points can never be mixed up between your loyalty cards.</p></div></section>
      </main>

      {selected && <div className="card-modal-backdrop" onMouseDown={() => setSelected(null)}>
        <div className="card-modal reward-wallet-modal" onMouseDown={(event) => event.stopPropagation()}>
          <button className="close-card" onClick={() => setSelected(null)}>×</button>
          <div className={`loyalty-card bg-gradient-to-br ${selected.color}`}>
            <div className="card-glow" />
            <div className="relative z-10 flex h-full flex-col justify-between">
              <div className="flex items-start justify-between"><div className="loyalty-logo"><img src={selected.logo} alt="" /></div><div className="text-right"><div className="text-xs font-extrabold tracking-[-.02em] text-[#d4b95e]">Perklyn</div><div className="mt-1 text-sm font-bold text-white">{selected.name}</div></div></div>
              <div><div className="text-[.62rem] font-bold uppercase tracking-[.18em] text-white/50">Available balance</div><div className="mt-1 text-5xl font-extrabold tracking-[-.05em] text-white">{selected.points.toLocaleString()}<span className="ml-2 text-base font-semibold text-[#ead58d]">POINTS</span></div></div>
              <div className="grid grid-cols-2"><div><div className="card-label">Member</div><div className="card-value">{safeProfile.name.toUpperCase()}</div></div><div><div className="card-label">Phone</div><div className="card-value">{safeProfile.phone}</div></div></div>
            </div>
          </div>
          <div className="store-claim-note"><Icon name="building" size={19} /><div><b>Claim rewards only at the store</b><span>Visit {selected.name} and show the claimed reward screen to a staff member. Online redemption is not available.</span></div></div>
          {claimMessage && <div className="claim-success"><Icon name="check" size={18} />{claimMessage}</div>}
          {claimMessage && businessClaims[0]?.claimCode && <div className="claim-code-card"><span>STORE VERIFICATION CODE</span><strong>{businessClaims[0].claimCode}</strong><small>Show this code in store within 24 hours. It can only be verified once.</small></div>}
          <div className="rewards-section">
            <div className="flex items-end justify-between"><div><div className="page-kicker">Available for you</div><div className="mt-1 text-lg font-extrabold text-[#153d32]">Issued rewards</div></div><span className="text-xs font-bold text-[#73817c]">{selected.points} points available</span></div>
            <div className="customer-reward-list">
              {(selected.rewards ?? []).map((reward) => {
                const locked = selected.points < reward.points;
                return <div className="customer-reward" key={reward.id}><i><Icon name="gift" size={19} /></i><div><b>{reward.title}</b><p>{reward.description}</p><small>{reward.points} points</small></div><button disabled={locked || claimingRewardId !== null} onClick={() => claimReward(reward)}>{locked ? "More points needed" : claimingRewardId === reward.id ? "Creating code…" : "Claim at store"}</button></div>;
              })}
            </div>
          </div>
          <div className="claim-history">
            <div className="text-sm font-extrabold text-[#153d32]">Claim history</div>
            {businessClaims.length === 0 ? <p className="empty-history">No rewards claimed from this business yet.</p> : businessClaims.map((claim) => <div className="history-row" key={claim.id}><i><Icon name="check" size={14} /></i><div><b>{claim.title}</b><small>{claim.claimedAt}{claim.claimCode ? ` · Code ${claim.claimCode}` : ""}</small></div><span>{claim.points} pts</span></div>)}
          </div>
          {businessTransactions.length > 0 && <div className="claim-history"><div className="text-sm font-extrabold text-[#153d32]">Points activity</div>{businessTransactions.slice(0, 12).map((transaction) => <div className="history-row" key={transaction.id}><i><Icon name={transaction.type === "claimed" ? "gift" : "nfc"} size={14} /></i><div><b>{transaction.type === "claimed" ? transaction.description.replace(/^RFID reward redeemed:\s*/i, "Reward redeemed: ") : "Points added by loyalty card"}</b><small>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(transaction.occurredAt))}</small></div><span>{transaction.type === "claimed" ? "−" : "+"}{transaction.points} pts</span></div>)}</div>}
        </div>
      </div>}
      {showScanner && <QrScannerModal onClose={() => setShowScanner(false)} onScan={joinBusiness} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      <BottomIsland
        portal="customer"
        onLogout={onLogout}
        actions={[
          { label: "Scan business QR", description: "Join a new business with your camera", icon: "grid", onClick: () => { setScanNotice(""); setShowScanner(true); } },
          { label: "My loyalty cards", description: "View connected businesses and points", icon: "card", onClick: () => window.scrollTo({ top: 360, behavior: "smooth" }) },
          { label: "Settings & support", description: "Call or email customer care", icon: "settings", onClick: () => setShowSettings(true) },
        ]}
      />
    </div>
  );
}

function PasswordReset({ onComplete }: { onComplete: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const updatePassword = async (event: FormEvent) => {
    event.preventDefault();
    setMessage("");
    if (password !== confirmation) {
      setMessage("The passwords do not match.");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    await supabase.auth.signOut();
    window.history.replaceState({}, document.title, window.location.pathname);
    onComplete();
  };

  return (
    <main className="signin-shell">
      <section className="signin-story">
        <div className="absolute inset-0 opacity-15 bg-[radial-gradient(circle_at_70%_20%,#e3ca72_0,transparent_34%),radial-gradient(circle_at_15%_80%,#4f8d78_0,transparent_38%)]" />
        <div className="relative z-10 flex h-full flex-col justify-between"><Brand light /><div className="max-w-[34rem] py-16 text-[clamp(2.8rem,5.7vw,5.5rem)] font-extrabold leading-[.95] tracking-[-0.06em] text-white">A fresh start.</div><div /></div>
      </section>
      <section className="signin-form-panel">
        <div className="w-full max-w-[31rem]">
          <div className="mb-10 lg:hidden"><Brand /></div>
          <div className="text-3xl font-extrabold tracking-[-0.04em] text-[#123b30]">Choose a new password</div>
          <p className="mt-3 text-[#687a74]">Use at least 10 characters to keep your Perklyn account secure.</p>
          <form onSubmit={updatePassword} className="mt-8 space-y-5">
            <label className="field-label">New password<input required minLength={10} className="field" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <label className="field-label">Confirm new password<input required minLength={10} className="field" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
            {message && <div className="rounded-xl bg-[#fff1ed] p-4 text-sm font-semibold text-[#9c3d2b]" role="alert">{message}</div>}
            <Button disabled={submitting} type="submit" className="w-full justify-center py-4">{submitting ? "Updating…" : "Update password"} {!submitting && <Icon name="arrow" size={18} />}</Button>
          </form>
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const [showNfcClaim, setShowNfcClaim] = useState(() => Boolean(captureNfcToken()));
  const [portal, setPortal] = useState<Portal>("signin");
  const [businessList, setBusinessList] = useState<Business[]>([]);
  const [businessDirectory, setBusinessDirectory] = useState<Business[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [profile, setProfile] = useState<Profile>({ name: "Perklyn member", phone: "", isNew: false });
  const [activeRole, setActiveRole] = useState<Role | null>(null);
  const [backendReady, setBackendReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [passwordRecovery, setPasswordRecovery] = useState(() => window.location.hash.includes("type=recovery") || window.location.search.includes("type=recovery"));
  const [notifications, setNotifications] = useState<PerklynNotification[]>([]);
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifications, setShowNotifications] = useState(false);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState("");
  const [notificationPermission, setNotificationPermission] = useState(() => getNotificationPermission());
  const [showNotificationPrompt, setShowNotificationPrompt] = useState(false);
  const [notificationBusinessId, setNotificationBusinessId] = useState<number | null>(null);

  const loadNotifications = async () => {
    const result = await apiRequest<{ notifications: PerklynNotification[]; unreadCount: number }>("/notifications?limit=30");
    setNotifications(result.notifications);
    setUnreadCount(result.unreadCount);
    return result.notifications;
  };

  const enableNotifications = async () => {
    setNotificationBusy(true);
    setNotificationMessage("");
    try {
      await subscribeCurrentDevice();
      const result = await apiRequest<{ preferences: NotificationPreferences }>("/notification-preferences");
      setNotificationPreferences({ ...result.preferences, pushEnabled: true });
      setNotificationPermission(getNotificationPermission());
      setShowNotificationPrompt(false);
      setNotificationMessage("Notifications are enabled on this device.");
    } catch (error) {
      setNotificationPermission(getNotificationPermission());
      setNotificationMessage(error instanceof Error ? error.message : "Unable to enable notifications.");
    } finally {
      setNotificationBusy(false);
    }
  };

  const disableNotifications = async () => {
    setNotificationBusy(true);
    setNotificationMessage("");
    try {
      await unsubscribeCurrentDevice();
      setNotificationPreferences((current) => current ? { ...current, pushEnabled: false } : current);
      setNotificationMessage("Notifications are turned off on this device.");
    } catch (error) {
      setNotificationMessage(error instanceof Error ? error.message : "Unable to turn off notifications.");
    } finally {
      setNotificationBusy(false);
    }
  };

  const updateNotificationPreference = async (field: keyof NotificationPreferences, value: boolean) => {
    if (!notificationPreferences) return;
    const next = { ...notificationPreferences, [field]: value };
    setNotificationPreferences(next);
    try {
      const result = await apiRequest<{ preferences: NotificationPreferences }>("/notification-preferences", {
        method: "PUT",
        body: JSON.stringify({ [field]: value }),
      });
      setNotificationPreferences(result.preferences);
    } catch (error) {
      setNotificationPreferences(notificationPreferences);
      setNotificationMessage(error instanceof Error ? error.message : "Unable to save notification settings.");
    }
  };

  const openNotification = async (notification: PerklynNotification) => {
    if (!notification.readAt) {
      setNotifications((items) => items.map((item) => item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item));
      setUnreadCount((count) => Math.max(0, count - 1));
      apiRequest(`/notifications/${notification.id}/read`, { method: "POST" }).catch(() => loadNotifications());
    }
    if (notification.businessId) setNotificationBusinessId(notification.businessId);
    setShowNotifications(false);
    window.history.replaceState({}, document.title, window.location.pathname);
  };

  const readAllNotifications = async () => {
    const readAt = new Date().toISOString();
    setNotifications((items) => items.map((item) => ({ ...item, readAt: item.readAt ?? readAt })));
    setUnreadCount(0);
    try {
      await apiRequest("/notifications/read-all", { method: "POST" });
    } catch {
      await loadNotifications();
    }
  };

  const loadAccount = async () => {
    const result = await apiRequest<{
      profile: { role: Role; name: string; phone: string; businessName?: string };
      state: { businesses?: Business[]; claims?: Claim[]; activities?: Activity[]; customers?: Customer[] } | null;
    }>("/me");
    const role = result.profile.role;
    setActiveRole(role);
    setProfile({ name: result.profile.name, phone: result.profile.phone, isNew: !result.state });
    let connectedBusinesses = result.state?.businesses ?? [];
    if (role === "customer") {
      const pending = await apiRequest<{ memberships: ServerMembership[] }>("/pending-memberships");
      connectedBusinesses = mergeMembershipBusinesses(connectedBusinesses, pending.memberships);
    }
    if (role === "business" && connectedBusinesses.length === 0) {
      connectedBusinesses = [{
        id: Date.now(),
        name: result.profile.businessName || "My Business",
        category: "New loyalty program",
        points: 0,
        color: "from-[#0d4e3a] to-[#073127]",
        accent: "#e8c765",
        logo: "/perklyn-logo.svg",
        reward: "Create your first reward",
        rewards: [],
        progress: 0,
      }];
    }
    setBusinessList(connectedBusinesses);
    setBusinessDirectory((directory) => [...directory, ...connectedBusinesses.filter((item) => !directory.some((listed) => listed.id === item.id))]);
    setClaims(result.state?.claims ?? []);
    setActivities(result.state?.activities ?? []);
    setCustomers(result.state?.customers ?? []);
    setPortal(role);
    setBackendReady(true);
  };

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setPasswordRecovery(true);
        setLoading(false);
      }
    });
    supabase.auth.getSession().then(async ({ data }) => {
      const isRecoveryLink = window.location.hash.includes("type=recovery") || window.location.search.includes("type=recovery");
      if (data.session && !isRecoveryLink) {
        try {
          await loadAccount();
        } catch (error) {
          console.error("Unable to restore Perklyn session", error);
          await supabase.auth.signOut();
        }
      }
      setLoading(false);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    setBusinessDirectory((directory) => directory.map((listed) => businessList.find((item) => item.id === listed.id) ?? listed));
  }, [businessList]);

  useEffect(() => {
    if (portal !== "signin" && getNfcToken()) setShowNfcClaim(true);
  }, [portal]);

  useEffect(() => {
    if (!backendReady || portal === "signin") return;
    const timer = window.setTimeout(() => {
      apiRequest("/state", {
        method: "PUT",
        body: JSON.stringify({ businesses: businessList, claims, activities, customers }),
      }).catch((error) => console.error("Unable to save Perklyn data", error));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [activities, backendReady, businessList, claims, customers, portal]);

  useEffect(() => {
    if (!backendReady || !activeRole) return;
    let cancelled = false;
    const initializeNotifications = async () => {
      try {
        const [preferences, inbox, subscribed] = await Promise.all([
          apiRequest<{ preferences: NotificationPreferences }>("/notification-preferences"),
          apiRequest<{ notifications: PerklynNotification[]; unreadCount: number }>("/notifications?limit=30"),
          currentDeviceIsSubscribed(),
        ]);
        if (cancelled) return;
        setNotificationPreferences({ ...preferences.preferences, pushEnabled: subscribed });
        setNotifications(inbox.notifications);
        setUnreadCount(inbox.unreadCount);
        setNotificationPermission(getNotificationPermission());
        const dismissedAt = Number(localStorage.getItem("perklyn-notification-prompt-dismissed") ?? 0);
        if (isPushSupported() && getNotificationPermission() === "default" && Date.now() - dismissedAt > 7 * 24 * 60 * 60 * 1000) setShowNotificationPrompt(true);
        const notificationId = new URLSearchParams(window.location.search).get("notification");
        const linked = notificationId ? inbox.notifications.find((item) => item.id === notificationId) : null;
        if (linked) {
          setShowNotifications(true);
          if (linked.businessId) setNotificationBusinessId(linked.businessId);
          if (!linked.readAt) {
            apiRequest(`/notifications/${linked.id}/read`, { method: "POST" }).catch(() => undefined);
            setNotifications((items) => items.map((item) => item.id === linked.id ? { ...item, readAt: new Date().toISOString() } : item));
            setUnreadCount((count) => Math.max(0, count - 1));
          }
        }
      } catch (error) {
        if (!cancelled) console.error("Unable to initialize notifications", error);
      }
    };
    initializeNotifications();
    const refresh = () => loadNotifications().catch(() => undefined);
    const timer = window.setInterval(refresh, 20_000);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [activeRole, backendReady]);

  useEffect(() => {
    if (!backendReady || activeRole !== "customer") return;
    const syncMemberships = async () => {
      try {
        const pending = await apiRequest<{ memberships: ServerMembership[] }>("/pending-memberships");
        setBusinessList((current) => mergeMembershipBusinesses(current, pending.memberships));
      } catch (error) {
        console.error("Unable to refresh customer balances", error);
      }
    };
    const onFocus = () => syncMemberships();
    const timer = window.setInterval(syncMemberships, 5000);
    window.addEventListener("focus", onFocus);
    syncMemberships();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeRole, backendReady]);

  useEffect(() => {
    if (!backendReady || activeRole !== "business") return;
    const syncBusinessActivity = async () => {
      try {
        const result = await apiRequest<{ state: { customers?: Customer[]; activities?: Activity[] } | null }>("/me");
        const nextCustomers = result.state?.customers ?? [];
        const nextActivities = result.state?.activities ?? [];
        setCustomers((current) => JSON.stringify(current) === JSON.stringify(nextCustomers) ? current : nextCustomers);
        setActivities((current) => JSON.stringify(current) === JSON.stringify(nextActivities) ? current : nextActivities);
      } catch (error) {
        console.error("Unable to refresh business activity", error);
      }
    };
    const onFocus = () => syncBusinessActivity();
    const timer = window.setInterval(syncBusinessActivity, 5000);
    window.addEventListener("focus", onFocus);
    syncBusinessActivity();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeRole, backendReady]);

  const registerPendingCustomer = (customer: Customer, businessId: number) => {
    const business = businessList.find((item) => item.id === businessId);
    if (!business) return;
    apiRequest("/pending-membership", {
      method: "POST",
      body: JSON.stringify({ customer, business }),
    }).catch((error) => console.error("Unable to save pending membership", error));
  };

  const enterAccount = async (role: Role, creating: boolean, details: { name: string; businessName: string; phone: string; email: string; password: string; authorizationCode: string }) => {
    const normalizedPhone = details.phone.replace(/\D/g, "");
    try {
      if (creating) {
        await apiRequest("/signup", {
          method: "POST",
          body: JSON.stringify({ role, ...details }),
        });
      }
      const session = await apiRequest<{ accessToken: string; refreshToken: string }>("/login", {
        method: "POST",
        body: JSON.stringify({ role, phone: normalizedPhone, password: details.password }),
      });
      const { error } = await supabase.auth.setSession({
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
      });
      if (error) {
        throw new Error(error.message);
      }
      const account = await apiRequest<{ profile: { role: Role } }>("/me");
      if (account.profile.role !== role) {
        await supabase.auth.signOut();
        throw new Error(`This phone number belongs to a ${account.profile.role} account.`);
      }
      await loadAccount();
      return { ok: true };
    } catch (error) {
      await supabase.auth.signOut();
      setBackendReady(false);
      return { ok: false, message: error instanceof Error ? error.message : "Unable to access this account." };
    }
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setBackendReady(false);
    setActiveRole(null);
    setBusinessList([]);
    setBusinessDirectory([]);
    setClaims([]);
    setActivities([]);
    setCustomers([]);
    setNotifications([]);
    setUnreadCount(0);
    setNotificationPreferences(null);
    setShowNotifications(false);
    setShowNotificationPrompt(false);
    setPortal("signin");
  };

  const completeNfcClaim = (result: Awaited<ReturnType<typeof claimNfcPoints>>) => {
    const claimedBusiness = result.business as unknown as Business;
    setBusinessList((items) => {
      const next = { ...claimedBusiness, points: result.balance, progress: claimedBusiness.progress ?? 0 };
      return items.some((item) => item.id === claimedBusiness.id)
        ? items.map((item) => item.id === claimedBusiness.id ? { ...item, ...next } : item)
        : [...items, next];
    });
    setShowNfcClaim(false);
  };

  if (passwordRecovery) return <PasswordReset onComplete={() => { setPasswordRecovery(false); setPortal("signin"); }} />;
  if (loading) return <div className="min-h-screen grid place-items-center bg-[#f5f8f6]"><Brand /><div className="fixed mt-20 text-sm font-bold text-[#6f817a]">Synchronizing Perklyn…</div></div>;
  const dashboard = portal === "business" && activeRole === "business"
    ? <BusinessDashboard businesses={businessList} setBusinesses={setBusinessList} customers={customers} setCustomers={setCustomers} activities={activities} setActivities={setActivities} profile={profile} onCustomerAdded={registerPendingCustomer} onCustomerChanged={registerPendingCustomer} onLogout={logout} onNotifications={() => { setNotificationMessage(""); setShowNotifications(true); loadNotifications().catch(() => undefined); }} unreadCount={unreadCount} />
    : portal === "customer" && activeRole === "customer"
      ? <CustomerDashboard businesses={businessList} setBusinesses={setBusinessList} directory={businessDirectory} claims={claims} setClaims={setClaims} setActivities={setActivities} profile={profile} onLogout={logout} onNotifications={() => { setNotificationMessage(""); setShowNotifications(true); loadNotifications().catch(() => undefined); }} unreadCount={unreadCount} notificationBusinessId={notificationBusinessId} />
      : <SignIn onEnter={enterAccount} />;
  return <>
    {dashboard}
    {showNfcClaim && <NfcClaimDialog portal={portal} onContinue={() => setShowNfcClaim(false)} onClaimed={completeNfcClaim} onSwitchAccount={logout} />}
    {showNotifications && activeRole && <NotificationCenter role={activeRole} notifications={notifications} unreadCount={unreadCount} preferences={notificationPreferences} permission={notificationPermission} busy={notificationBusy} message={notificationMessage} onClose={() => setShowNotifications(false)} onEnable={enableNotifications} onDisable={disableNotifications} onPreference={updateNotificationPreference} onOpenNotification={openNotification} onReadAll={readAllNotifications} />}
    {showNotificationPrompt && activeRole && <NotificationPrompt busy={notificationBusy} onEnable={enableNotifications} onDismiss={() => { localStorage.setItem("perklyn-notification-prompt-dismissed", String(Date.now())); setShowNotificationPrompt(false); }} />}
  </>;
}
