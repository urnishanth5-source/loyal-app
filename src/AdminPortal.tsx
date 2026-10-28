import { FormEvent, useEffect, useMemo, useState } from "react"
import { projectId, publicAnonKey } from "../utils/supabase/info"

type AdminBusiness = {
  id: number
  name: string
  category: string
  ownerName: string
  ownerPhone: string
  paused: boolean
  pausedAt?: string | null
}

const apiBase = `https://${projectId}.supabase.co/functions/v1/make-server-3a123995`
const sessionKey = "perklyn-admin-session"

const adminRequest = async <T,>(
  path: string,
  options: RequestInit = {},
): Promise<T> => {
  const token = sessionStorage.getItem(sessionKey)
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${publicAnonKey}`,
      ...(token ? { "X-Admin-Token": token } : {}),
      ...(options.headers ?? {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? "The admin request failed.")
  return body as T
}

export default function AdminPortal() {
  const [phone, setPhone] = useState("")
  const [password, setPassword] = useState("")
  const [businesses, setBusinesses] = useState<AdminBusiness[]>([])
  const [query, setQuery] = useState("")
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(
    Boolean(sessionStorage.getItem(sessionKey)),
  )
  const [authenticated, setAuthenticated] = useState(
    Boolean(sessionStorage.getItem(sessionKey)),
  )
  const [updatingId, setUpdatingId] = useState<number | null>(null)

  const loadBusinesses = async () => {
    setLoading(true)
    try {
      const result = await adminRequest<{ businesses: AdminBusiness[] }>(
        "/admin/businesses",
      )
      setBusinesses(result.businesses)
      setAuthenticated(true)
      setMessage("")
    } catch (error) {
      sessionStorage.removeItem(sessionKey)
      setAuthenticated(false)
      setMessage(
        error instanceof Error ? error.message : "Unable to load businesses.",
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (authenticated) loadBusinesses()
  }, [])

  const login = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setMessage("")
    try {
      const result = await adminRequest<{ token: string }>("/admin/login", {
        method: "POST",
        body: JSON.stringify({ phone: `+91${phone}`, password }),
      })
      sessionStorage.setItem(sessionKey, result.token)
      setPassword("")
      setAuthenticated(true)
      await loadBusinesses()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to sign in.")
      setAuthenticated(false)
    } finally {
      setLoading(false)
    }
  }

  const logout = async () => {
    try {
      await adminRequest("/admin/logout", { method: "POST" })
    } catch {
      // The local session still needs to be cleared if the server is offline.
    }
    sessionStorage.removeItem(sessionKey)
    setAuthenticated(false)
    setBusinesses([])
    setPhone("")
    setPassword("")
    setMessage("")
  }

  const updateBusinessStatus = async (business: AdminBusiness) => {
    const nextPaused = !business.paused
    if (
      !window.confirm(
        `${
          nextPaused ? "Pause" : "Resume"
        } business ID ${business.id} (${business.name})?`,
      )
    )
      return
    setUpdatingId(business.id)
    setMessage("")
    try {
      await adminRequest(`/admin/businesses/${business.id}/status`, {
        method: "PUT",
        body: JSON.stringify({ paused: nextPaused }),
      })
      setBusinesses((items) =>
        items.map((item) =>
          item.id === business.id
            ? {
                ...item,
                paused: nextPaused,
                pausedAt: nextPaused ? new Date().toISOString() : null,
              }
            : item,
        ),
      )
      setMessage(
        `Business ID ${business.id} is now ${
          nextPaused ? "paused" : "active"
        }.`,
      )
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to change business status.",
      )
    } finally {
      setUpdatingId(null)
    }
  }

  const filteredBusinesses = useMemo(() => {
    const search = query.trim().toLowerCase()
    if (!search) return businesses
    return businesses.filter((business) =>
      `${business.id} ${business.name} ${business.category} ${business.ownerName} ${business.ownerPhone}`
        .toLowerCase()
        .includes(search),
    )
  }, [businesses, query])

  if (!authenticated) {
    return (
      <main className="admin-login-page">
        <section className="admin-login-card">
          <a href="/" className="admin-brand">
            <img src="/perklyn-logo.svg" alt="" />
            <span>Perklyn</span>
          </a>
          <div className="admin-kicker">Restricted access</div>
          <h1>Administrator sign in</h1>
          <p>
            Manage monthly access for registered business IDs. Admin sessions
            expire automatically after eight hours.
          </p>
          <form onSubmit={login}>
            <label>
              Admin phone
              <div className="admin-phone-field">
                <span>+91</span>
                <input
                  required
                  type="tel"
                  inputMode="numeric"
                  autoComplete="username"
                  value={phone}
                  onChange={(event) =>
                    setPhone(event.target.value.replace(/\D/g, "").slice(0, 10))
                  }
                  placeholder="10-digit phone number"
                />
              </div>
            </label>
            <label>
              Password
              <input
                required
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter admin password"
              />
            </label>
            {message && <div className="admin-alert">{message}</div>}
            <button disabled={loading} type="submit">
              {loading ? "Signing in…" : "Sign in securely"}
            </button>
          </form>
          <small>Only the configured Perklyn administrator can sign in.</small>
        </section>
      </main>
    )
  }

  const pausedCount = businesses.filter((business) => business.paused).length
  return (
    <main className="admin-page">
      <header className="admin-header">
        <a href="/" className="admin-brand">
          <img src="/perklyn-logo.svg" alt="" />
          <span>Perklyn Admin</span>
        </a>
        <div>
          <button onClick={loadBusinesses} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button className="admin-logout" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <section className="admin-content">
        <div className="admin-title-row">
          <div>
            <div className="admin-kicker">Business access control</div>
            <h1>Monthly subscriptions</h1>
            <p>Pause unpaid business IDs and resume access after payment.</p>
          </div>
          <div className="admin-summary">
            <span>
              <b>{businesses.length}</b>
              Total businesses
            </span>
            <span>
              <b>{businesses.length - pausedCount}</b>
              Active
            </span>
            <span className="paused">
              <b>{pausedCount}</b>
              Paused
            </span>
          </div>
        </div>
        <div className="admin-toolbar">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by ID, business, owner, or phone"
          />
          <span>{filteredBusinesses.length} results</span>
        </div>
        {message && <div className="admin-message">{message}</div>}
        <div className="admin-business-list">
          {filteredBusinesses.map((business) => (
            <article
              className={business.paused ? "is-paused" : ""}
              key={business.id}
            >
              <div className="admin-business-id">
                <span>Business ID</span>
                <strong>{business.id}</strong>
              </div>
              <div className="admin-business-details">
                <b>{business.name}</b>
                <span>{business.category || "No category"}</span>
                <small>
                  {[business.ownerName, business.ownerPhone]
                    .filter(Boolean)
                    .join(" · ") || "Owner details unavailable"}
                </small>
              </div>
              <span className="admin-status">
                {business.paused ? "Paused" : "Active"}
              </span>
              <button
                className={business.paused ? "resume" : "pause"}
                disabled={updatingId === business.id}
                onClick={() => updateBusinessStatus(business)}
              >
                {updatingId === business.id
                  ? "Updating…"
                  : business.paused
                    ? "Resume"
                    : "Pause"}
              </button>
            </article>
          ))}
          {!loading && filteredBusinesses.length === 0 && (
            <div className="admin-empty">No matching business IDs found.</div>
          )}
        </div>
      </section>
    </main>
  )
}
