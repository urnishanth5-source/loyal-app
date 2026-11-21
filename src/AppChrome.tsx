import { ReactNode, useEffect, useMemo, useState } from "react"

type Consent = "accepted" | "essential" | null
type Theme = "light" | "dark"

const consentKey = "perklyn-cookie-consent"
const themeKey = "perklyn-theme"
const attributionKey = "perklyn-utm-attribution"
const utmFields = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const

const readStoredValue = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeStoredValue = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // The preference remains active for this page when storage is unavailable.
  }
}

export default function AppChrome({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = readStoredValue(themeKey)
    if (stored === "dark" || stored === "light") return stored
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
  })
  const [consent, setConsent] = useState<Consent>(() => {
    const stored = readStoredValue(consentKey)
    return stored === "accepted" || stored === "essential" ? stored : null
  })
  const [scrollProgress, setScrollProgress] = useState(0)
  const [showBackToTop, setShowBackToTop] = useState(false)
  const attribution = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    const values = Object.fromEntries(
      utmFields
        .map((field) => [field, params.get(field)?.trim().slice(0, 200)])
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    )
    return Object.keys(values).length
      ? {
          ...values,
          landingPath: window.location.pathname,
          capturedAt: new Date().toISOString(),
        }
      : null
  }, [])
  const lastUpdated = useMemo(() => {
    const modified = new Date(document.lastModified)
    return Number.isNaN(modified.getTime())
      ? "Recently"
      : new Intl.DateTimeFormat("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        }).format(modified)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    writeStoredValue(themeKey, theme)
    const themeColor = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    )
    themeColor?.setAttribute("content", theme === "dark" ? "#160824" : "#f8f3ff")
  }, [theme])

  useEffect(() => {
    if (consent === "accepted" && attribution)
      writeStoredValue(attributionKey, JSON.stringify(attribution))
  }, [attribution, consent])

  useEffect(() => {
    const activeScroller = () =>
      document.querySelector<HTMLElement>(".billing-workspace")
    const updateScroll = () => {
      const scroller = activeScroller()
      const scrollTop = scroller?.scrollTop ?? window.scrollY
      const scrollable = scroller
        ? scroller.scrollHeight - scroller.clientHeight
        : document.documentElement.scrollHeight - window.innerHeight
      setScrollProgress(
        scrollable > 0
          ? Math.min(100, Math.max(0, (scrollTop / scrollable) * 100))
          : 0,
      )
      setShowBackToTop(scrollTop > 480)
    }
    updateScroll()
    window.addEventListener("scroll", updateScroll, { passive: true })
    document.addEventListener("scroll", updateScroll, {
      capture: true,
      passive: true,
    })
    window.addEventListener("resize", updateScroll)
    return () => {
      window.removeEventListener("scroll", updateScroll)
      document.removeEventListener("scroll", updateScroll, { capture: true })
      window.removeEventListener("resize", updateScroll)
    }
  }, [])

  const saveConsent = (next: Exclude<Consent, null>) => {
    setConsent(next)
    writeStoredValue(consentKey, next)
  }

  return (
    <>
      <div
        className="scroll-progress"
        style={{ transform: `scaleX(${scrollProgress / 100})` }}
        aria-hidden="true"
      />
      {children}
      <div className="app-utility-dock">
        <button
          type="button"
          className="theme-toggle"
          onClick={() =>
            setTheme((current) => (current === "dark" ? "light" : "dark"))
          }
          aria-label={`Use ${theme === "dark" ? "light" : "dark"} mode`}
          title={`Use ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.5 14.2A8.3 8.3 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z" />
            </svg>
          )}
        </button>
        {showBackToTop && (
          <button
            type="button"
            className="back-to-top"
            onClick={() => {
              const scroller =
                document.querySelector<HTMLElement>(".billing-workspace")
              if (scroller) scroller.scrollTo({ top: 0, behavior: "smooth" })
              else window.scrollTo({ top: 0, behavior: "smooth" })
            }}
            aria-label="Back to top"
            title="Back to top"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 15 6-6 6 6" />
            </svg>
          </button>
        )}
      </div>
      <div className="app-last-updated">Last updated {lastUpdated}</div>
      {consent === null && (
        <aside className="cookie-banner" aria-label="Cookie preferences">
          <div>
            <b>Your privacy, clearly handled</b>
            <p>
              Perklyn uses essential browser storage for secure sessions and
              preferences. With your permission, campaign tags are saved to help
              us understand how you found Perklyn.
            </p>
          </div>
          <div className="cookie-actions">
            <button
              type="button"
              className="cookie-essential"
              onClick={() => saveConsent("essential")}
            >
              Essential only
            </button>
            <button
              type="button"
              className="cookie-accept"
              onClick={() => saveConsent("accepted")}
            >
              Accept
            </button>
          </div>
        </aside>
      )}
    </>
  )
}
