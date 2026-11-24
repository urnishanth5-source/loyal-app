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

type AdminCustomer = {
  id: string
  name: string
  phone: string
  email: string
  createdAt?: string | null
  lastLoginAt?: string | null
  inactiveDays: number
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
  const [customers, setCustomers] = useState<AdminCustomer[]>([])
  const [view, setView] = useState<"businesses" | "customers">("businesses")
  const [query, setQuery] = useState("")
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(
    Boolean(sessionStorage.getItem(sessionKey)),
  )
  const [authenticated, setAuthenticated] = useState(
    Boolean(sessionStorage.getItem(sessionKey)),
  )
  const [updatingId, setUpdatingId] = useState<number | null>(null)

  const loadAdminData = async () => {
    setLoading(true)
    try {
      const [businessResult, customerResult] = await Promise.all([
        adminRequest<{ businesses: AdminBusiness[] }>("/admin/businesses"),
        adminRequest<{ customers: AdminCustomer[] }>("/admin/customers"),
      ])
      setBusinesses(businessResult.businesses)
      setCustomers(customerResult.customers)
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
    if (authenticated) loadAdminData()
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
      await loadAdminData()
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
    setCustomers([])
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
  const filteredCustomers = useMemo(() => {
    const search = query.trim().toLowerCase()
    if (!search) return customers
    return customers.filter((customer) =>
      `${customer.name} ${customer.phone} ${customer.email}`
        .toLowerCase()
        .includes(search),
    )
  }, [customers, query])

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
  const activeTodayCount = customers.filter(
    (customer) => customer.inactiveDays === 0,
  ).length
  return (
    <main className="admin-page">
      <header className="admin-header">
        <a href="/" className="admin-brand">
          <img src="/perklyn-logo.svg" alt="" />
          <span>Perklyn Admin</span>
        </a>
        <div>
          <button onClick={loadAdminData} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button className="admin-logout" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <section className="admin-content">
        <nav className="admin-view-tabs" aria-label="Admin sections">
          <button
            className={view === "businesses" ? "active" : ""}
            onClick={() => {
              setView("businesses")
              setQuery("")
            }}
          >
            Business accounts
          </button>
          <button
            className={view === "customers" ? "active" : ""}
            onClick={() => {
              setView("customers")
              setQuery("")
            }}
          >
            Customer accounts
          </button>
        </nav>
        <div className="admin-title-row">
          <div>
            <div className="admin-kicker">
              {view === "businesses"
                ? "Business access control"
                : "Customer activity"}
            </div>
            <h1>
              {view === "businesses"
                ? "Monthly subscriptions"
                : "Customer accounts"}
            </h1>
            <p>
              {view === "businesses"
                ? "Pause unpaid business IDs and resume access after payment."
                : "Review account age and the number of days since each customer last logged in."}
            </p>
          </div>
          <div className="admin-summary">
            {view === "businesses" ? (
              <>
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
              </>
            ) : (
              <>
                <span>
                  <b>{customers.length}</b>
                  Total customers
                </span>
                <span>
                  <b>{activeTodayCount}</b>
                  Logged in today
                </span>
                <span>
                  <b>{customers.length - activeTodayCount}</b>
                  Away 1+ days
                </span>
              </>
            )}
          </div>
        </div>
        <div className="admin-toolbar">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              view === "businesses"
                ? "Search by ID, business, owner, or phone"
                : "Search customers by name, phone, or email"
            }
          />
          <span>
            {view === "businesses"
              ? filteredBusinesses.length
              : filteredCustomers.length}{" "}
            results
          </span>
        </div>
        {message && <div className="admin-message">{message}</div>}
        {view === "businesses" ? (
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
        ) : (
          <div className="admin-customer-list">
            {filteredCustomers.map((customer) => (
              <article key={customer.id}>
                <div className="admin-customer-avatar">
                  {customer.name.charAt(0).toUpperCase() || "C"}
                </div>
                <div className="admin-business-details">
                  <b>{customer.name}</b>
                  <span>
                    {[customer.phone, customer.email]
                      .filter(Boolean)
                      .join(" · ") || "Contact details unavailable"}
                  </span>
                  <small>
                    Created{" "}
                    {customer.createdAt
                      ? new Date(customer.createdAt).toLocaleDateString("en-IN")
                      : "date unavailable"}
                    {" · "}
                    {customer.lastLoginAt
                      ? `Last login ${new Date(customer.lastLoginAt).toLocaleString("en-IN")}`
                      : "No tracked login yet"}
                  </small>
                </div>
                <div
                  className={`admin-inactive-days ${
                    customer.inactiveDays === 0 ? "is-current" : ""
                  }`}
                >
                  <b>{customer.inactiveDays}</b>
                  <span>
                    {customer.inactiveDays === 1 ? "day" : "days"} since login
                  </span>
                </div>
              </article>
            ))}
            {!loading && filteredCustomers.length === 0 && (
              <div className="admin-empty">
                No matching customer accounts found.
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  )
}
