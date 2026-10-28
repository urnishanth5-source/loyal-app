import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { BrowserMultiFormatReader } from "@zxing/browser"
import JsBarcode from "jsbarcode"
import { apiRequest } from "./supabase"
import { countryCallingCodes } from "./countryCallingCodes"
import {
  calculateBillingTotals,
  formatInr,
  rupeesToPaise,
} from "./billing/calculations"
import { downloadInvoicePdf } from "./billing/invoicePdf"
import {
  printThermalReceipt,
  type ThermalReceiptData,
  type ThermalReceiptSeller,
  type ThermalReceiptWidth,
} from "./billing/receiptPrint"
import type {
  CatalogImportError,
  CatalogImportRow,
} from "./billing/catalogExcel"
import type {
  BillingCustomer,
  BillingInvoiceSummary,
  BillingPayment,
  BillingSettings,
  BillingTotals,
  CartLine,
  CatalogItem,
  GstRateBps,
} from "./billing/types"

type Merchant = { id: number; name: string }
type View = "checkout" | "catalog" | "sales" | "report" | "settings"
type ReportView = "stock" | "sold"
type SoldReportItem = {
  id: string
  catalogItemId?: string
  name: string
  hsnSac: string
  unit: string
  quantity: number
  totalPaise: number
  brand: string
  design: string
  size: string
  category: string
  sku: string
  barcode: string
  customValues: Record<string, string>
}
type SalesRange = "today" | "month" | "3months" | "6months" | "year"

const salesRangeOptions: { value: SalesRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "month", label: "This month" },
  { value: "3months", label: "3 months" },
  { value: "6months", label: "6 months" },
  { value: "year", label: "This year" },
]

const formatUnits = (value: number) =>
  value.toLocaleString("en-IN", { maximumFractionDigits: 3 })

const salesRangeStart = (range: SalesRange, now: Date) => {
  if (range === "today")
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (range === "month") return new Date(now.getFullYear(), now.getMonth(), 1)
  if (range === "3months")
    return new Date(now.getFullYear(), now.getMonth() - 2, 1)
  if (range === "6months")
    return new Date(now.getFullYear(), now.getMonth() - 5, 1)
  return new Date(now.getFullYear(), 0, 1)
}

const createSalesBuckets = (range: SalesRange, now: Date) => {
  if (range === "today") {
    return Array.from({ length: 8 }, (_, index) => {
      const hour = index * 3
      return {
        key: `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${index}`,
        label: new Date(2000, 0, 1, hour).toLocaleTimeString("en-IN", {
          hour: "numeric",
        }),
        matches: (date: Date) =>
          date.toDateString() === now.toDateString() &&
          Math.floor(date.getHours() / 3) === index,
        totalPaise: 0,
      }
    })
  }
  if (range === "month") {
    return Array.from({ length: now.getDate() }, (_, index) => {
      const day = index + 1
      return {
        key: `${now.getFullYear()}-${now.getMonth()}-${day}`,
        label: String(day),
        matches: (date: Date) =>
          date.getFullYear() === now.getFullYear() &&
          date.getMonth() === now.getMonth() &&
          date.getDate() === day,
        totalPaise: 0,
      }
    })
  }
  const monthCount =
    range === "3months" ? 3 : range === "6months" ? 6 : now.getMonth() + 1
  return Array.from({ length: monthCount }, (_, index) => {
    const date =
      range === "year"
        ? new Date(now.getFullYear(), index, 1)
        : new Date(
            now.getFullYear(),
            now.getMonth() - monthCount + index + 1,
            1,
          )
    return {
      key: `${date.getFullYear()}-${date.getMonth()}`,
      label: date.toLocaleDateString("en-IN", { month: "short" }),
      matches: (candidate: Date) =>
        candidate.getFullYear() === date.getFullYear() &&
        candidate.getMonth() === date.getMonth(),
      totalPaise: 0,
    }
  })
}

const emptySettings = (businessId: number, name: string): BillingSettings => ({
  businessId,
  legalName: name,
  gstin: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  stateName: "",
  stateCode: "",
  postalCode: "",
  invoicePrefix: "INV",
  creditNotePrefix: "CN",
  pointsPerRupee: 1,
  receiptFooter: "",
  catalogCustomFields: [],
  catalogCustomOptions: {},
  catalogOptions: {
    brands: [],
    designs: [],
    sizes: [],
    categories: [],
  },
})

const emptyCatalogItem = (businessId: number): CatalogItem => ({
  id: "",
  businessId,
  itemType: "product",
  name: "",
  category: "",
  brand: "",
  design: "",
  size: "",
  sku: "",
  barcode: "",
  hsnSac: "",
  unit: "unit",
  pricePaise: 0,
  gstRateBps: 1800,
  priceIncludesTax: true,
  stockQuantity: 0,
  customValues: {},
  discountType: "none",
  discountValue: 0,
  active: true,
})

const normalizeCatalogItem = (
  item: Partial<CatalogItem> & Pick<CatalogItem, "id" | "businessId" | "name">,
): CatalogItem => ({
  id: item.id,
  businessId: item.businessId,
  itemType: item.itemType === "service" ? "service" : "product",
  name: item.name,
  category: item.category ?? "",
  brand: item.brand ?? "",
  design: item.design ?? "",
  size: item.size ?? "",
  sku: item.sku ?? "",
  barcode: item.barcode ?? "",
  hsnSac: item.hsnSac ?? "",
  unit: item.unit ?? "unit",
  pricePaise: Number(item.pricePaise ?? 0),
  gstRateBps: ([0, 500, 1200, 1800, 2800].includes(Number(item.gstRateBps))
    ? Number(item.gstRateBps)
    : 1800) as GstRateBps,
  priceIncludesTax: item.priceIncludesTax !== false,
  stockQuantity: item.stockQuantity == null ? null : Number(item.stockQuantity),
  customValues:
    item.customValues && typeof item.customValues === "object"
      ? item.customValues
      : {},
  discountType:
    item.discountType === "percent" || item.discountType === "fixed"
      ? item.discountType
      : "none",
  discountValue: Number.isFinite(Number(item.discountValue))
    ? Number(item.discountValue)
    : 0,
  active: item.active !== false,
})

const normalizeBillingSettings = (
  value: BillingSettings,
  fallback: BillingSettings,
): BillingSettings => ({
  ...fallback,
  ...value,
  receiptFooter: value.receiptFooter ?? fallback.receiptFooter ?? "",
  catalogCustomFields:
    value.catalogCustomFields ?? fallback.catalogCustomFields ?? [],
  catalogCustomOptions:
    value.catalogCustomOptions ?? fallback.catalogCustomOptions ?? {},
  catalogOptions: {
    brands:
      value.catalogOptions?.brands ?? fallback.catalogOptions?.brands ?? [],
    designs:
      value.catalogOptions?.designs ?? fallback.catalogOptions?.designs ?? [],
    sizes: value.catalogOptions?.sizes ?? fallback.catalogOptions?.sizes ?? [],
    categories:
      value.catalogOptions?.categories ??
      fallback.catalogOptions?.categories ??
      [],
  },
})

const receiptSellerFromSettings = (
  settings: BillingSettings,
): ThermalReceiptSeller => ({
  legalName: settings.legalName,
  gstin: settings.gstin,
  addressLine1: settings.addressLine1,
  addressLine2: settings.addressLine2,
  city: settings.city,
  stateName: settings.stateName,
  postalCode: settings.postalCode,
})

const historicalInvoiceTotals = (sale: any): BillingTotals => ({
  lines: sale.items.map((item: any, index: number) => ({
    id: item.id,
    lineNumber: index + 1,
    catalogItemId: item.catalog_item_id,
    itemType: item.item_type,
    name: item.name,
    hsnSac: item.hsn_sac,
    unit: item.unit,
    quantity: Number(item.quantity),
    unitPricePaise: Number(item.unit_price_paise),
    priceIncludesTax: item.price_includes_tax,
    gstRateBps: Number(item.gst_rate_bps) as GstRateBps,
    lineDiscountPaise: Number(item.line_discount_paise),
    grossBeforeDiscountPaise: Number(item.gross_before_discount_paise),
    allocatedCartDiscountPaise: Number(item.allocated_cart_discount_paise),
    taxablePaise: Number(item.taxable_paise),
    cgstPaise: Number(item.cgst_paise),
    sgstPaise: Number(item.sgst_paise),
    igstPaise: Number(item.igst_paise),
    totalPaise: Number(item.total_paise),
  })),
  subtotalPaise: Number(sale.invoice.subtotal_paise),
  lineDiscountPaise: Number(sale.invoice.line_discount_paise),
  cartDiscountPaise: Number(sale.invoice.cart_discount_paise),
  taxablePaise: Number(sale.invoice.taxable_paise),
  cgstPaise: Number(sale.invoice.cgst_paise),
  sgstPaise: Number(sale.invoice.sgst_paise),
  igstPaise: Number(sale.invoice.igst_paise),
  totalPaise: Number(sale.invoice.total_paise),
})

const historicalInvoicePayments = (sale: any): BillingPayment[] =>
  sale.payments.map((payment: any) => ({
    id: payment.id,
    mode: payment.payment_mode,
    amountPaise: Number(payment.amount_paise),
    reference: payment.reference,
  }))

const automaticDiscountPaise = (
  item: Pick<CartLine, "unitPricePaise" | "automaticDiscountType" | "automaticDiscountValue">,
  quantity: number,
) => {
  const gross = Math.max(0, Math.round(item.unitPricePaise * quantity))
  if (item.automaticDiscountType === "percent")
    return Math.min(
      gross,
      Math.round((gross * Number(item.automaticDiscountValue ?? 0)) / 100),
    )
  if (item.automaticDiscountType === "fixed")
    return Math.min(
      gross,
      Math.round(Number(item.automaticDiscountValue ?? 0) * quantity),
    )
  return 0
}

const toCartLine = (item: CatalogItem): CartLine => {
  const line: CartLine = {
    id: crypto.randomUUID(),
    catalogItemId: item.id,
    itemType: item.itemType,
    name: item.name,
    hsnSac: item.hsnSac,
    unit: item.unit,
    quantity: 1,
    unitPricePaise: item.pricePaise,
    gstRateBps: item.gstRateBps,
    priceIncludesTax: item.priceIncludesTax,
    lineDiscountPaise: 0,
    automaticDiscountType:
      item.discountType === "none" ? undefined : item.discountType,
    automaticDiscountValue: item.discountValue,
  }
  line.lineDiscountPaise = automaticDiscountPaise(line, line.quantity)
  return line
}

const ean13CheckDigit = (value: string) => {
  const sum = value
    .split("")
    .reduce(
      (total, digit, index) =>
        total + Number(digit) * (index % 2 === 0 ? 1 : 3),
      0,
    )
  return String((10 - (sum % 10)) % 10)
}

const generateEan13 = (businessId: number) => {
  const seed =
    `${String(businessId).slice(-4).padStart(4, "0")}${Date.now().toString().slice(-8)}`.slice(
      0,
      12,
    )
  return `${seed}${ean13CheckDigit(seed)}`
}

function BarcodeGraphic({ value }: { value: string }) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!ref.current || !value) return
    try {
      JsBarcode(ref.current, value, {
        format: "CODE128",
        displayValue: true,
        background: "transparent",
        lineColor: "#2b0d4f",
        height: 54,
        margin: 4,
      })
    } catch {
      ref.current.replaceChildren()
    }
  }, [value])
  return <svg ref={ref} className="billing-barcode-preview" />
}

function SalesLineChart({
  buckets,
}: {
  buckets: { key: string; label: string; totalPaise: number }[]
}) {
  const width = 800
  const height = 260
  const left = 64
  const right = 20
  const top = 24
  const bottom = 45
  const chartWidth = width - left - right
  const chartHeight = height - top - bottom
  const maxValue = Math.max(...buckets.map((bucket) => bucket.totalPaise), 1)
  const points = buckets.map((bucket, index) => ({
    ...bucket,
    x:
      buckets.length === 1
        ? left + chartWidth / 2
        : left + (index / (buckets.length - 1)) * chartWidth,
    y: top + chartHeight - (bucket.totalPaise / maxValue) * chartHeight,
  }))
  const linePoints = points.map((point) => `${point.x},${point.y}`).join(" ")
  const areaPoints = `${left},${top + chartHeight} ${linePoints} ${
    left + chartWidth
  },${top + chartHeight}`
  const labelInterval = Math.max(1, Math.ceil(buckets.length / 8))

  return (
    <div className="billing-sales-chart">
      <div className="billing-sales-chart-head">
        <span>Sales trend</span>
        <small>Hover a point to see its total</small>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Line chart showing sales totals over the selected period"
      >
        {[0, 0.5, 1].map((ratio) => {
          const y = top + chartHeight * ratio
          const value = Math.round(maxValue * (1 - ratio))
          return (
            <g key={ratio}>
              <line
                className="billing-chart-grid"
                x1={left}
                x2={left + chartWidth}
                y1={y}
                y2={y}
              />
              <text className="billing-chart-axis" x={left - 10} y={y + 4}>
                {formatInr(value)}
              </text>
            </g>
          )
        })}
        <polygon className="billing-chart-area" points={areaPoints} />
        <polyline className="billing-chart-line" points={linePoints} />
        {points.map((point, index) => (
          <g key={point.key}>
            <circle
              className="billing-chart-point"
              cx={point.x}
              cy={point.y}
              r="5"
            >
              <title>
                {point.label}: {formatInr(point.totalPaise)}
              </title>
            </circle>
            {(index % labelInterval === 0 || index === points.length - 1) && (
              <text className="billing-chart-label" x={point.x} y={height - 16}>
                {point.label}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  )
}

function WorkspaceButton({
  children,
  onClick,
  type = "button",
  secondary = false,
  disabled = false,
  active = false,
}: {
  children: React.ReactNode
  onClick?: () => void
  type?: "button" | "submit"
  secondary?: boolean
  disabled?: boolean
  active?: boolean
}) {
  return (
    <button
      type={type}
      className={`btn ${secondary ? "btn-secondary" : "btn-primary"} ${
        active ? "billing-range-active" : ""
      }`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export default function BillingWorkspace({
  merchant,
  onClose,
  onDataChanged,
}: {
  merchant: Merchant
  onClose: () => void
  onDataChanged: () => void
}) {
  const [view, setView] = useState<View>("checkout")
  const [reportView, setReportView] = useState<ReportView>("stock")
  const [settings, setSettings] = useState<BillingSettings | null>(null)
  const [settingsDraft, setSettingsDraft] = useState(() =>
    emptySettings(merchant.id, merchant.name),
  )
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const catalogImportInput = useRef<HTMLInputElement>(null)
  const [catalogImportRows, setCatalogImportRows] = useState<
    CatalogImportRow[]
  >([])
  const [catalogImportErrors, setCatalogImportErrors] = useState<
    CatalogImportError[]
  >([])
  const [catalogImportFileName, setCatalogImportFileName] = useState("")
  const [catalogImportProgress, setCatalogImportProgress] = useState("")
  const [catalogDraft, setCatalogDraft] = useState(() =>
    emptyCatalogItem(merchant.id),
  )
  const [showCatalogEditor, setShowCatalogEditor] = useState(false)
  const [catalogQuery, setCatalogQuery] = useState("")
  const [catalogListQuery, setCatalogListQuery] = useState("")
  const [catalogFilters, setCatalogFilters] = useState({
    brand: "",
    design: "",
    size: "",
    category: "",
    stock: "",
    custom: {} as Record<string, string>,
  })
  const [stockReportQuery, setStockReportQuery] = useState("")
  const [stockReportFilters, setStockReportFilters] = useState({
    brand: "",
    design: "",
    size: "",
    category: "",
    stock: "",
    custom: {} as Record<string, string>,
  })
  const [soldReportItems, setSoldReportItems] = useState<SoldReportItem[]>([])
  const [soldReportQuery, setSoldReportQuery] = useState("")
  const [soldReportFrom, setSoldReportFrom] = useState("")
  const [soldReportTo, setSoldReportTo] = useState("")
  const [appliedSoldReportFrom, setAppliedSoldReportFrom] = useState("")
  const [appliedSoldReportTo, setAppliedSoldReportTo] = useState("")
  const [soldReportFilters, setSoldReportFilters] = useState({
    brand: "",
    design: "",
    size: "",
    category: "",
    custom: {} as Record<string, string>,
  })
  const [customName, setCustomName] = useState("")
  const [customHsn, setCustomHsn] = useState("")
  const [customPrice, setCustomPrice] = useState("")
  const [customGstRate, setCustomGstRate] = useState<GstRateBps>(1800)
  const [barcodeScan, setBarcodeScan] = useState("")
  const [showBarcodeScanner, setShowBarcodeScanner] = useState(false)
  const scannerVideo = useRef<HTMLVideoElement>(null)
  const hardwareScanBuffer = useRef("")
  const hardwareScanAt = useRef(0)
  const [newCustomField, setNewCustomField] = useState("")
  const [newCustomCatalogOption, setNewCustomCatalogOption] =
    useState<Record<string, string>>({})
  const [newCatalogOption, setNewCatalogOption] =
    useState<Record<string, string>>({})
  const [cart, setCart] = useState<CartLine[]>([])
  const [cartDiscount, setCartDiscount] = useState("")
  const [cartDiscountPercent, setCartDiscountPercent] = useState("")
  const [placeOfSupply, setPlaceOfSupply] = useState("")
  const [customerQuery, setCustomerQuery] = useState("")
  const [customers, setCustomers] = useState<BillingCustomer[]>([])
  const [customer, setCustomer] = useState<BillingCustomer | null>(null)
  const [showAddCustomer, setShowAddCustomer] = useState(false)
  const [newCustomerName, setNewCustomerName] = useState("")
  const [newCustomerCountry, setNewCustomerCountry] = useState("India")
  const [newCustomerLocalPhone, setNewCustomerLocalPhone] = useState("")
  const [payments, setPayments] = useState<BillingPayment[]>([
    { id: crypto.randomUUID(), mode: "cash", amountPaise: 0 },
  ])
  const [invoices, setInvoices] = useState<BillingInvoiceSummary[]>([])
  const [salesRange, setSalesRange] = useState<SalesRange>("month")
  const [selectedSale, setSelectedSale] = useState<any>(null)
  const [editingInvoice, setEditingInvoice] = useState(false)
  const [invoiceEditLines, setInvoiceEditLines] = useState<any[]>([])
  const [lastInvoice, setLastInvoice] = useState<BillingInvoiceSummary | null>(
    null,
  )
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const percentageDiscountPaise = useMemo(() => {
    const netBeforeCartDiscount = cart.reduce((sum, line) => {
      const gross = Math.max(0, Math.round(line.unitPricePaise * line.quantity))
      return sum + Math.max(0, gross - line.lineDiscountPaise)
    }, 0)
    const percentage = Math.min(
      100,
      Math.max(0, Number(cartDiscountPercent) || 0),
    )
    return Math.round((netBeforeCartDiscount * percentage) / 100)
  }, [cart, cartDiscountPercent])
  const combinedCartDiscountPaise =
    rupeesToPaise(cartDiscount) + percentageDiscountPaise
  const totals = useMemo(
    () =>
      calculateBillingTotals(
        cart,
        combinedCartDiscountPaise,
        settings?.stateCode ?? "",
        placeOfSupply || settings?.stateCode || "",
      ),
    [cart, combinedCartDiscountPaise, settings, placeOfSupply],
  )
  const projectedPoints =
    customer && settings
      ? Math.floor((totals.totalPaise * settings.pointsPerRupee) / 100)
      : 0
  const paymentTotal = payments.reduce(
    (sum, payment) => sum + payment.amountPaise,
    0,
  )
  const filteredCatalog = useMemo(
    () =>
      catalog.filter((item) => {
        const query = catalogListQuery.trim().toLowerCase()
        if (
          query &&
          !`${item.name} ${item.brand} ${item.design} ${item.size} ${item.category} ${item.sku} ${item.barcode} ${item.hsnSac}`
            .toLowerCase()
            .includes(query)
        )
          return false
        if (catalogFilters.brand && item.brand !== catalogFilters.brand)
          return false
        if (catalogFilters.design && item.design !== catalogFilters.design)
          return false
        if (catalogFilters.size && item.size !== catalogFilters.size)
          return false
        if (
          catalogFilters.category &&
          item.category !== catalogFilters.category
        )
          return false
        if (
          catalogFilters.stock === "in" &&
          !(item.stockQuantity != null && item.stockQuantity > 0)
        )
          return false
        if (
          catalogFilters.stock === "out" &&
          !(item.stockQuantity != null && item.stockQuantity <= 0)
        )
          return false
        if (catalogFilters.stock === "untracked" && item.stockQuantity != null)
          return false
        return Object.entries(catalogFilters.custom).every(
          ([field, value]) => !value || item.customValues?.[field] === value,
        )
      }),
    [catalog, catalogFilters, catalogListQuery],
  )
  const stockReportItems = useMemo(
    () =>
      catalog.filter((item) => {
        if (item.itemType !== "product") return false
        const query = stockReportQuery.trim().toLowerCase()
        if (
          query &&
          !`${item.name} ${item.brand} ${item.design} ${item.size} ${item.category} ${item.sku} ${item.barcode} ${item.hsnSac}`
            .toLowerCase()
            .includes(query)
        )
          return false
        if (stockReportFilters.brand && item.brand !== stockReportFilters.brand)
          return false
        if (
          stockReportFilters.design &&
          item.design !== stockReportFilters.design
        )
          return false
        if (stockReportFilters.size && item.size !== stockReportFilters.size)
          return false
        if (
          stockReportFilters.category &&
          item.category !== stockReportFilters.category
        )
          return false
        if (
          stockReportFilters.stock === "in" &&
          !(item.stockQuantity != null && item.stockQuantity > 0)
        )
          return false
        if (
          stockReportFilters.stock === "out" &&
          !(item.stockQuantity != null && item.stockQuantity <= 0)
        )
          return false
        if (
          stockReportFilters.stock === "untracked" &&
          item.stockQuantity != null
        )
          return false
        return Object.entries(stockReportFilters.custom).every(
          ([field, value]) => !value || item.customValues?.[field] === value,
        )
      }),
    [catalog, stockReportFilters, stockReportQuery],
  )
  const filteredSoldReportItems = useMemo(
    () =>
      soldReportItems.filter((item) => {
        const query = soldReportQuery.trim().toLowerCase()
        if (
          query &&
          !`${item.name} ${item.brand} ${item.design} ${item.size} ${item.category} ${item.sku} ${item.barcode} ${item.hsnSac}`
            .toLowerCase()
            .includes(query)
        )
          return false
        if (soldReportFilters.brand && item.brand !== soldReportFilters.brand)
          return false
        if (
          soldReportFilters.design &&
          item.design !== soldReportFilters.design
        )
          return false
        if (soldReportFilters.size && item.size !== soldReportFilters.size)
          return false
        if (
          soldReportFilters.category &&
          item.category !== soldReportFilters.category
        )
          return false
        return Object.entries(soldReportFilters.custom).every(
          ([field, value]) => !value || item.customValues?.[field] === value,
        )
      }),
    [soldReportFilters, soldReportItems, soldReportQuery],
  )
  const stockReportTotals = useMemo(
    () => ({
      all: catalog
        .filter((item) => item.itemType === "product")
        .reduce((total, item) => total + Number(item.stockQuantity ?? 0), 0),
      filtered: stockReportItems.reduce(
        (total, item) => total + Number(item.stockQuantity ?? 0),
        0,
      ),
    }),
    [catalog, stockReportItems],
  )
  const soldReportTotals = useMemo(
    () => ({
      all: soldReportItems.reduce(
        (total, item) => total + Number(item.quantity),
        0,
      ),
      filtered: filteredSoldReportItems.reduce(
        (total, item) => total + Number(item.quantity),
        0,
      ),
    }),
    [filteredSoldReportItems, soldReportItems],
  )
  const salesReport = useMemo(() => {
    const now = new Date()
    const start = salesRangeStart(salesRange, now)
    const rangeInvoices = invoices.filter((invoice) => {
      const createdAt = new Date(invoice.createdAt)
      return createdAt >= start && createdAt <= now
    })
    const buckets = createSalesBuckets(salesRange, now)
    rangeInvoices.forEach((invoice) => {
      const createdAt = new Date(invoice.createdAt)
      const bucket = buckets.find((item) => item.matches(createdAt))
      if (bucket) bucket.totalPaise += invoice.totalPaise
    })
    const totalPaise = rangeInvoices.reduce(
      (sum, invoice) => sum + invoice.totalPaise,
      0,
    )
    return {
      invoices: rangeInvoices,
      buckets,
      totalPaise,
      averagePaise:
        rangeInvoices.length > 0
          ? Math.round(totalPaise / rangeInvoices.length)
          : 0,
    }
  }, [invoices, salesRange])

  const loadCatalog = async () => {
    const items: CatalogItem[] = []
    const pageSize = 1000
    for (let offset = 0; offset < 50000; offset += pageSize) {
      const result = await apiRequest<{ items: CatalogItem[] }>(
        `/billing/catalog?businessId=${merchant.id}&status=all&offset=${offset}&limit=${pageSize}`,
      )
      items.push(...result.items.map((item) => normalizeCatalogItem(item)))
      if (result.items.length < pageSize) break
    }
    setCatalog(items)
  }
  const loadInvoices = async () => {
    const result = await apiRequest<{ invoices: BillingInvoiceSummary[] }>(
      `/billing/invoices?businessId=${merchant.id}`,
    )
    setInvoices(result.invoices)
  }
  const loadSoldReport = async (
    from = appliedSoldReportFrom,
    to = appliedSoldReportTo,
  ) => {
    const params = new URLSearchParams({ businessId: String(merchant.id) })
    if (from) {
      params.set("from", new Date(`${from}T00:00:00`).toISOString())
    }
    if (to) {
      const exclusiveEnd = new Date(`${to}T00:00:00`)
      exclusiveEnd.setDate(exclusiveEnd.getDate() + 1)
      params.set("to", exclusiveEnd.toISOString())
    }
    const result = await apiRequest<{ items: SoldReportItem[] }>(
      `/billing/reports/sold?${params.toString()}`,
    )
    setSoldReportItems(result.items)
    setAppliedSoldReportFrom(from)
    setAppliedSoldReportTo(to)
  }
  const applySoldReportPeriod = () => {
    if (soldReportFrom && soldReportTo && soldReportFrom > soldReportTo) {
      setMessage("The sold report From date must be before the To date.")
      return
    }
    setMessage("")
    loadSoldReport(soldReportFrom, soldReportTo).catch((error) =>
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to load the sold items report.",
      ),
    )
  }
  useEffect(() => {
    Promise.all([
      apiRequest<{ settings: BillingSettings | null }>(
        `/billing/settings?businessId=${merchant.id}`,
      ),
      loadCatalog(),
      loadInvoices(),
    ])
      .then(([result]) => {
        const loadedSettings = result.settings
          ? normalizeBillingSettings(result.settings, settingsDraft)
          : null
        setSettings(loadedSettings)
        if (loadedSettings) {
          setSettingsDraft(loadedSettings)
          setPlaceOfSupply(loadedSettings.stateCode)
        }
      })
      .catch((error) =>
        setMessage(
          error instanceof Error ? error.message : "Unable to load billing.",
        ),
      )
  }, [merchant.id])
  useEffect(() => {
    if (view !== "report" || reportView !== "sold") return
    loadSoldReport().catch((error) =>
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to load the sold items report.",
      ),
    )
  }, [merchant.id, reportView, view])

  const updateLine = (id: string, patch: Partial<CartLine>) =>
    setCart((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    )

  const searchCustomers = async () => {
    setBusy(true)
    setMessage("")
    try {
      const result = await apiRequest<{ customers: BillingCustomer[] }>(
        `/billing/customers?businessId=${merchant.id}&query=${encodeURIComponent(customerQuery)}`,
      )
      setCustomers(result.customers)
      if (result.customers.length === 0)
        setMessage("No matching loyalty customer was found.")
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to search customers.",
      )
    } finally {
      setBusy(false)
    }
  }

  const addCheckoutCustomer = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage("")
    try {
      const country =
        countryCallingCodes.find(
          (option) => option.country === newCustomerCountry,
        ) ?? countryCallingCodes[0]
      const internationalPhone =
        `${country.dial} ${newCustomerLocalPhone}`.trim()
      const result = await apiRequest<{ customer: BillingCustomer }>(
        "/billing/customers",
        {
          method: "POST",
          body: JSON.stringify({
            businessId: merchant.id,
            name: newCustomerName,
            phone: internationalPhone,
          }),
        },
      )
      setCustomer(result.customer)
      setCustomers([])
      setCustomerQuery("")
      setShowAddCustomer(false)
      setNewCustomerName("")
      setNewCustomerLocalPhone("")
      setMessage(`${result.customer.name} added and selected for this bill.`)
      await onDataChanged()
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to add customer.",
      )
    } finally {
      setBusy(false)
    }
  }

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage("")
    try {
      const result = await apiRequest<{ settings: BillingSettings }>(
        "/billing/settings",
        { method: "PUT", body: JSON.stringify(settingsDraft) },
      )
      const responseOptions = result.settings.catalogOptions
      const responseCustomOptions = result.settings.catalogCustomOptions ?? {}
      const footerPersisted =
        (result.settings.receiptFooter ?? "") ===
        settingsDraft.receiptFooter.trim()
      const optionsPersisted =
        responseOptions &&
        JSON.stringify(responseOptions.brands ?? []) ===
          JSON.stringify(settingsDraft.catalogOptions.brands) &&
        JSON.stringify(responseOptions.designs ?? []) ===
          JSON.stringify(settingsDraft.catalogOptions.designs) &&
        JSON.stringify(responseOptions.sizes ?? []) ===
          JSON.stringify(settingsDraft.catalogOptions.sizes) &&
        JSON.stringify(responseOptions.categories ?? []) ===
          JSON.stringify(settingsDraft.catalogOptions.categories) &&
        JSON.stringify(responseCustomOptions) ===
          JSON.stringify(settingsDraft.catalogCustomOptions)
      if (!optionsPersisted || !footerPersisted) {
        throw new Error(
          "Some billing settings were not saved by the server. Apply the latest Supabase migrations and redeploy the Edge Function, then save again.",
        )
      }
      const savedSettings = normalizeBillingSettings(
        result.settings,
        settingsDraft,
      )
      setSettings(savedSettings)
      setSettingsDraft(savedSettings)
      setPlaceOfSupply(savedSettings.stateCode)
      setMessage("Billing settings saved.")
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to save settings.",
      )
    } finally {
      setBusy(false)
    }
  }

  const addCustomCatalogField = () => {
    const field = newCustomField.trim()
    if (!field) return
    if (
      settingsDraft.catalogCustomFields.some(
        (current) => current.toLowerCase() === field.toLowerCase(),
      )
    ) {
      setMessage("That custom catalog field already exists.")
      return
    }
    setSettingsDraft({
      ...settingsDraft,
      catalogCustomFields: [...settingsDraft.catalogCustomFields, field],
    })
    setNewCustomField("")
  }

  const addCustomCatalogOption = (field: string) => {
    const value = (newCustomCatalogOption[field] ?? "").trim()
    if (!value) return
    const current = settingsDraft.catalogCustomOptions[field] ?? []
    if (current.some((option) => option.toLowerCase() === value.toLowerCase()))
      return
    setSettingsDraft({
      ...settingsDraft,
      catalogCustomOptions: {
        ...settingsDraft.catalogCustomOptions,
        [field]: [...current, value],
      },
    })
    setNewCustomCatalogOption((options) => ({ ...options, [field]: "" }))
  }

  const removeCustomCatalogOption = (field: string, value: string) => {
    setSettingsDraft({
      ...settingsDraft,
      catalogCustomOptions: {
        ...settingsDraft.catalogCustomOptions,
        [field]: (settingsDraft.catalogCustomOptions[field] ?? []).filter(
          (option) => option !== value,
        ),
      },
    })
  }

  const addCatalogOption = (
    group: "brands" | "designs" | "sizes" | "categories",
  ) => {
    const raw = (newCatalogOption[group] ?? "").trim()
    if (!raw) return
    const value = raw
    const current = settingsDraft.catalogOptions[
      group
    ] as Array<string | number>
    if (
      current.some(
        (item) => String(item).toLowerCase() === String(value).toLowerCase(),
      )
    )
      return
    setSettingsDraft({
      ...settingsDraft,
      catalogOptions: {
        ...settingsDraft.catalogOptions,
        [group]: [...current, value],
      },
    })
    setNewCatalogOption((options) => ({ ...options, [group]: "" }))
  }

  const removeCatalogOption = (
    group: "brands" | "designs" | "sizes" | "categories",
    value: string,
  ) => {
    setSettingsDraft({
      ...settingsDraft,
      catalogOptions: {
        ...settingsDraft.catalogOptions,
        [group]: (settingsDraft.catalogOptions[
          group
        ] as Array<string | number>).filter((item) => item !== value),
      },
    })
  }

  const saveCatalogItem = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage("")
    try {
      const path = catalogDraft.id
        ? `/billing/catalog/${catalogDraft.id}`
        : "/billing/catalog"
      const result = await apiRequest<{ item: CatalogItem }>(path, {
        method: catalogDraft.id ? "PUT" : "POST",
        body: JSON.stringify(catalogDraft),
      })
      const savedItem = normalizeCatalogItem(result.item)
      const discountPersisted =
        savedItem.discountType === catalogDraft.discountType &&
        Math.abs(savedItem.discountValue - catalogDraft.discountValue) < 0.01
      if (!discountPersisted) {
        throw new Error(
          "The automatic discount was not saved by the server. Apply migration 20260318000000_catalog_automatic_discounts.sql and redeploy the Supabase Edge Function, then save the item again.",
        )
      }
      setCatalogDraft(emptyCatalogItem(merchant.id))
      setShowCatalogEditor(false)
      await loadCatalog()
      setMessage("Catalog item saved.")
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to save item.",
      )
    } finally {
      setBusy(false)
    }
  }

  const downloadCatalogImportTemplate = async () => {
    const { downloadCatalogTemplate } = await import(
      "./billing/catalogExcel"
    )
    await downloadCatalogTemplate(settingsDraft.catalogCustomFields)
  }

  const selectCatalogImportFile = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setMessage("Choose an Excel .xlsx file.")
      return
    }
    setMessage("")
    try {
      const { parseCatalogWorkbook } = await import("./billing/catalogExcel")
      const result = await parseCatalogWorkbook(
        await file.arrayBuffer(),
        settingsDraft.catalogCustomFields,
      )
      setCatalogImportRows(result.rows)
      setCatalogImportErrors(result.errors)
      setCatalogImportFileName(file.name)
      setShowCatalogEditor(false)
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to read the Excel workbook.",
      )
    }
  }

  const cancelCatalogImport = () => {
    setCatalogImportRows([])
    setCatalogImportErrors([])
    setCatalogImportFileName("")
    setCatalogImportProgress("")
  }

  const importCatalogWorkbook = async () => {
    setBusy(true)
    setMessage("")
    try {
      let importedCount = 0
      let serverErrors: CatalogImportError[] = []
      let optionSyncWarning = ""
      if (catalogImportRows.length > 0) {
        const batchSize = 500
        const batchCount = Math.ceil(catalogImportRows.length / batchSize)
        for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
          const start = batchIndex * batchSize
          const rows = catalogImportRows.slice(start, start + batchSize)
          setCatalogImportProgress(
            `Importing ${start + 1}–${start + rows.length} of ${catalogImportRows.length}`,
          )
          const result = await apiRequest<{
            importedCount: number
            errors: CatalogImportError[]
            settings?: BillingSettings
            optionSyncWarning?: string
          }>("/billing/catalog/bulk", {
            method: "POST",
            body: JSON.stringify({
              businessId: merchant.id,
              rows,
            }),
          })
          importedCount += result.importedCount
          serverErrors.push(...(result.errors ?? []))
          if (result.settings) {
            const savedSettings = normalizeBillingSettings(
              result.settings,
              settingsDraft,
            )
            setSettings(savedSettings)
            setSettingsDraft(savedSettings)
          }
          if (result.optionSyncWarning)
            optionSyncWarning = result.optionSyncWarning
        }
      }
      const errors = [...catalogImportErrors, ...serverErrors]
      if (errors.length > 0) {
        const { downloadCatalogErrorWorkbook } = await import(
          "./billing/catalogExcel"
        )
        await downloadCatalogErrorWorkbook(errors, catalogImportFileName)
      }
      cancelCatalogImport()
      await loadCatalog()
      setMessage(
        `${importedCount} product${importedCount === 1 ? "" : "s"} imported.${
          errors.length > 0
            ? ` ${errors.length} rejected row${errors.length === 1 ? "" : "s"} downloaded in the error Excel.`
            : ""
        }${optionSyncWarning ? ` ${optionSyncWarning}` : ""}`,
      )
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to import the catalog.",
      )
    } finally {
      setCatalogImportProgress("")
      setBusy(false)
    }
  }

  const addPayment = () =>
    setPayments((items) => [
      ...items,
      { id: crypto.randomUUID(), mode: "upi", amountPaise: 0 },
    ])

  const addByBarcode = (value: string) => {
    const cleaned = value.trim()
    if (!cleaned) return
    const item = catalog.find(
      (candidate) => candidate.active && candidate.barcode === cleaned,
    )
    if (!item) {
      setMessage(`No active catalog item matches barcode ${cleaned}.`)
      return
    }
    setCart((lines) => [...lines, toCartLine(item)])
    setBarcodeScan("")
    setMessage(`${item.name} added from barcode.`)
  }

  useEffect(() => {
    const cleaned = barcodeScan.trim()
    if (!cleaned) return
    const exactMatch = catalog.some(
      (item) => item.active && item.barcode === cleaned,
    )
    if (!exactMatch) return
    const timer = window.setTimeout(() => addByBarcode(cleaned), 120)
    return () => window.clearTimeout(timer)
  }, [barcodeScan, catalog])

  useEffect(() => {
    if (view !== "checkout") return
    const captureHardwareScanner = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches("input, textarea, select, [contenteditable='true']"))
        return
      const now = Date.now()
      if (event.key === "Enter") {
        const scanned = hardwareScanBuffer.current
        const isScannerSpeed = now - hardwareScanAt.current < 140
        hardwareScanBuffer.current = ""
        if (isScannerSpeed && scanned.length >= 4) addByBarcode(scanned)
        return
      }
      if (event.key.length !== 1 || !/^[A-Za-z0-9:_-]$/.test(event.key)) return
      if (now - hardwareScanAt.current > 90) hardwareScanBuffer.current = ""
      hardwareScanBuffer.current += event.key
      hardwareScanAt.current = now
    }
    window.addEventListener("keydown", captureHardwareScanner)
    return () => window.removeEventListener("keydown", captureHardwareScanner)
  }, [view, catalog])

  useEffect(() => {
    if (!showBarcodeScanner || !scannerVideo.current) return
    const reader = new BrowserMultiFormatReader()
    let stopped = false
    let controls: { stop: () => void } | undefined
    reader
      .decodeFromVideoDevice(
        undefined,
        scannerVideo.current,
        (result, _error, scannerControls) => {
          controls = scannerControls
          if (!result || stopped) return
          stopped = true
          scannerControls.stop()
          setShowBarcodeScanner(false)
          addByBarcode(result.getText())
        },
      )
      .then((nextControls) => {
        controls = nextControls
      })
      .catch((error) => {
        setShowBarcodeScanner(false)
        setMessage(
          error instanceof Error
            ? error.message
            : "Unable to open the barcode camera.",
        )
      })
    return () => {
      stopped = true
      controls?.stop()
    }
  }, [showBarcodeScanner, catalog])

  const printCatalogBarcode = () => {
    if (!catalogDraft.barcode) return
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    try {
      JsBarcode(svg, catalogDraft.barcode, {
        format: "CODE128",
        displayValue: true,
        height: 70,
        margin: 8,
      })
    } catch {
      setMessage("Enter a valid barcode before printing.")
      return
    }
    const popup = window.open("", "_blank", "width=520,height=420")
    if (!popup) return
    popup.document.write(`
      <html><head><title>${catalogDraft.name || "Barcode"}</title>
      <style>@page{size:60mm 35mm;margin:2mm}body{display:grid;place-items:center;margin:0;font:12px sans-serif;text-align:center}b{display:block;margin-bottom:4px}svg{max-width:56mm}</style>
      </head><body><div><b>${catalogDraft.name || "Catalog item"}</b>${svg.outerHTML}</div></body></html>`)
    popup.document.close()
    popup.focus()
    popup.print()
  }

  const addCustomItem = () => {
    if (!customName.trim() || !customHsn.trim() || !customPrice) {
      setMessage("Custom items need a name, HSN/SAC, and price.")
      return
    }
    setCart((lines) => [
      ...lines,
      {
        id: crypto.randomUUID(),
        itemType: "product",
        name: customName.trim(),
        hsnSac: customHsn.trim(),
        unit: "unit",
        quantity: 1,
        unitPricePaise: rupeesToPaise(customPrice),
        gstRateBps: customGstRate,
        priceIncludesTax: true,
        lineDiscountPaise: 0,
      },
    ])
    setCustomName("")
    setCustomHsn("")
    setCustomPrice("")
  }

  const finalizeInvoice = async () => {
    if (!settings) {
      setView("settings")
      return
    }
    setBusy(true)
    setMessage("")
    try {
      const result = await apiRequest<{
        invoice: BillingInvoiceSummary
        pointsAwarded: number
      }>("/billing/invoices", {
        method: "POST",
        body: JSON.stringify({
          businessId: merchant.id,
          lines: cart,
          cartDiscountPaise: combinedCartDiscountPaise,
          placeOfSupplyCode: placeOfSupply || settings.stateCode,
          customer,
          payments,
          idempotencyKey: crypto.randomUUID(),
        }),
      })
      setLastInvoice(result.invoice)
      setMessage(
        `${result.invoice.invoiceNumber} created. ${result.pointsAwarded} loyalty points awarded.`,
      )
      await Promise.all([loadInvoices(), loadCatalog(), onDataChanged()])
      loadSoldReport().catch(() => {
        // The completed invoice remains valid if reporting is temporarily unavailable.
      })
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to finalize invoice.",
      )
    } finally {
      setBusy(false)
    }
  }

  const resetSale = () => {
    setCart([])
    setCartDiscount("")
    setCartDiscountPercent("")
    setCustomer(null)
    setCustomerQuery("")
    setCustomers([])
    setPayments([{ id: crypto.randomUUID(), mode: "cash", amountPaise: 0 }])
    setLastInvoice(null)
    setMessage("")
  }

  const openInvoice = async (id: string, edit = false) => {
    setBusy(true)
    try {
      const result = await apiRequest<any>(
        `/billing/invoices/${id}?businessId=${merchant.id}`,
      )
      setSelectedSale(result)
      setInvoiceEditLines(
        result.items.map((item: any) => ({
          id: item.id,
          quantity: Number(item.quantity),
          unitPricePaise: Number(item.unit_price_paise),
        })),
      )
      setEditingInvoice(edit)
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to load invoice.",
      )
    } finally {
      setBusy(false)
    }
  }

  const saveInvoiceEdits = async () => {
    if (!selectedSale?.invoice) return
    setBusy(true)
    setMessage("")
    try {
      await apiRequest(`/billing/invoices/${selectedSale.invoice.id}`, {
        method: "PUT",
        body: JSON.stringify({
          businessId: merchant.id,
          lines: invoiceEditLines,
        }),
      })
      setEditingInvoice(false)
      await Promise.all([
        openInvoice(selectedSale.invoice.id),
        loadInvoices(),
        loadCatalog(),
        loadSoldReport().catch(() => undefined),
        onDataChanged(),
      ])
      setMessage(`${selectedSale.invoice.invoice_number} updated.`)
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to update invoice.",
      )
    } finally {
      setBusy(false)
    }
  }

  const deleteInvoice = async (id: string, invoiceNumber: string) => {
    if (
      !window.confirm(
        `Delete ${invoiceNumber}? This will restore its product stock, reverse awarded points, and remove its amount from sales reports. This cannot be undone.`,
      )
    )
      return
    setBusy(true)
    setMessage("")
    try {
      await apiRequest(`/billing/invoices/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ businessId: merchant.id }),
      })
      if (lastInvoice?.id === id) setLastInvoice(null)
      setSelectedSale(null)
      setEditingInvoice(false)
      await Promise.all([
        loadInvoices(),
        loadCatalog(),
        loadSoldReport().catch(() => undefined),
        onDataChanged(),
      ])
      setMessage(
        `${invoiceNumber} deleted. Stock and sales reports were updated.`,
      )
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to delete invoice.",
      )
    } finally {
      setBusy(false)
    }
  }

  const refundInvoice = async () => {
    if (!selectedSale?.invoice) return
    if (
      !window.confirm(
        `Create a full credit note for ${selectedSale.invoice.invoice_number}?`,
      )
    )
      return
    setBusy(true)
    try {
      await apiRequest(
        `/billing/invoices/${selectedSale.invoice.id}/credit-notes`,
        {
          method: "POST",
          body: JSON.stringify({
            businessId: merchant.id,
            reason: "Customer refund",
            refundMode: "cash",
            idempotencyKey: crypto.randomUUID(),
            items: selectedSale.items.map((item: any) => ({
              invoiceItemId: item.id,
              quantity: Number(item.quantity),
            })),
          }),
        },
      )
      await Promise.all([
        openInvoice(selectedSale.invoice.id),
        loadInvoices(),
        loadCatalog(),
        onDataChanged(),
      ])
      setMessage("Credit note created and loyalty points reversed.")
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to refund invoice.",
      )
    } finally {
      setBusy(false)
    }
  }

  const openThermalReceipt = (
    data: ThermalReceiptData,
    width: ThermalReceiptWidth,
  ) => {
    if (printThermalReceipt(data, width)) return
    setMessage("Allow popups for this site to print the receipt.")
  }

  const printReceipt = (width: ThermalReceiptWidth) => {
    if (!lastInvoice || !settings) return
    openThermalReceipt(
      {
        seller: receiptSellerFromSettings(settings),
        invoiceNumber: lastInvoice.invoiceNumber,
        createdAt: lastInvoice.createdAt,
        status: lastInvoice.status,
        placeOfSupplyCode: placeOfSupply || settings.stateCode,
        customerName: lastInvoice.customerName,
        customerPhone: lastInvoice.customerPhone,
        totals,
        payments,
        pointsAwarded: lastInvoice.pointsAwarded,
        pointsReversed: lastInvoice.pointsReversed,
        footerNote: settings.receiptFooter,
      },
      width,
    )
  }

  const printHistoricalReceipt = (width: ThermalReceiptWidth) => {
    if (!selectedSale?.invoice || !settings || editingInvoice) return
    const invoice = selectedSale.invoice
    const snapshot =
      invoice.seller_snapshot && typeof invoice.seller_snapshot === "object"
        ? invoice.seller_snapshot
        : {}
    const fallbackSeller = receiptSellerFromSettings(settings)
    const seller: ThermalReceiptSeller = {
      legalName: snapshot.legalName || fallbackSeller.legalName,
      gstin: snapshot.gstin || fallbackSeller.gstin,
      addressLine1: snapshot.addressLine1 || fallbackSeller.addressLine1,
      addressLine2: snapshot.addressLine2 || fallbackSeller.addressLine2,
      city: snapshot.city || fallbackSeller.city,
      stateName: snapshot.stateName || fallbackSeller.stateName,
      postalCode: snapshot.postalCode || fallbackSeller.postalCode,
    }
    openThermalReceipt(
      {
        seller,
        invoiceNumber: invoice.invoice_number,
        createdAt: invoice.created_at,
        status: invoice.status,
        placeOfSupplyCode: invoice.place_of_supply_code,
        customerName: invoice.customer_name,
        customerPhone: invoice.customer_phone,
        totals: historicalInvoiceTotals(selectedSale),
        payments: historicalInvoicePayments(selectedSale),
        pointsAwarded: Number(invoice.points_awarded),
        pointsReversed: Number(invoice.points_reversed),
        refundedPaise: Number(invoice.refunded_paise),
        footerNote: snapshot.receiptFooter ?? settings.receiptFooter,
        creditNoteNumbers: selectedSale.creditNotes.map(
          (note: any) => note.credit_note_number,
        ),
      },
      width,
    )
  }

  return (
    <div className="billing-workspace">
      <header className="billing-workspace-header">
        <button className="billing-back" onClick={onClose}>
          ← Back to business
        </button>
        <div>
          <strong>Billing & POS</strong>
          <span>{merchant.name}</span>
        </div>
        <nav>
          {([
            "checkout",
            "catalog",
            "sales",
            "report",
            "settings",
          ] as View[]).map((item) => (
            <button
              key={item}
              className={view === item ? "active" : ""}
              onClick={() => setView(item)}
            >
              {item}
            </button>
          ))}
        </nav>
      </header>
      <main className="billing-workspace-main">
        {message && <div className="billing-message">{message}</div>}
        {view === "checkout" && (
          <>
            {!settings ? (
              <section className="billing-empty">
                <b>Complete GST billing setup first</b>
                <span>
                  Add seller details, GSTIN, state, invoice prefix, and loyalty
                  earning rate.
                </span>
                <WorkspaceButton onClick={() => setView("settings")}>
                  Open settings
                </WorkspaceButton>
              </section>
            ) : lastInvoice ? (
              <section className="billing-success">
                <span>Invoice completed</span>
                <strong>{lastInvoice.invoiceNumber}</strong>
                <b>{formatInr(lastInvoice.totalPaise)}</b>
                <small>
                  {lastInvoice.pointsAwarded} loyalty points awarded
                </small>
                <div>
                  <WorkspaceButton onClick={() => printReceipt(80)}>
                    Print 80 mm
                  </WorkspaceButton>
                  <WorkspaceButton secondary onClick={() => printReceipt(58)}>
                    Print 58 mm
                  </WorkspaceButton>
                  <WorkspaceButton
                    secondary
                    onClick={() =>
                      downloadInvoicePdf({
                        invoice: lastInvoice,
                        settings,
                        totals,
                        payments,
                      })
                    }
                  >
                    Download PDF
                  </WorkspaceButton>
                  <WorkspaceButton secondary onClick={resetSale}>
                    New sale
                  </WorkspaceButton>
                </div>
              </section>
            ) : (
              <div className="billing-checkout-grid">
                <section className="billing-panel">
                  <div className="billing-section-head">
                    <div>
                      <span>Catalog</span>
                      <b>Add products and services</b>
                    </div>
                    <input
                      className="field"
                      value={catalogQuery}
                      onChange={(event) => setCatalogQuery(event.target.value)}
                      placeholder="Search item, SKU, barcode"
                    />
                  </div>
                  <div className="billing-scan-row">
                    <input
                      value={barcodeScan}
                      onChange={(event) => setBarcodeScan(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") addByBarcode(barcodeScan)
                      }}
                      placeholder="Scan barcode or enter code"
                      autoComplete="off"
                    />
                    <WorkspaceButton
                      secondary
                      onClick={() => addByBarcode(barcodeScan)}
                    >
                      Add barcode
                    </WorkspaceButton>
                    <WorkspaceButton
                      secondary
                      onClick={() => setShowBarcodeScanner(true)}
                    >
                      Camera scan
                    </WorkspaceButton>
                  </div>
                  {catalogQuery.trim() ? (
                    <div className="billing-product-grid">
                      {catalog
                        .filter(
                          (item) =>
                            item.active &&
                            `${item.name} ${item.brand} ${item.design} ${item.size} ${item.category} ${item.sku} ${item.barcode} ${item.hsnSac}`
                              .toLowerCase()
                              .includes(catalogQuery.trim().toLowerCase()),
                        )
                        .map((item) => (
                          <button
                            key={item.id}
                            className="billing-product"
                            disabled={
                              item.itemType === "product" &&
                              item.stockQuantity != null &&
                              item.stockQuantity <= 0
                            }
                            onClick={() =>
                              setCart((lines) => [...lines, toCartLine(item)])
                            }
                          >
                            <b>{item.name}</b>
                            <span>
                              {item.brand || item.category || item.hsnSac} · GST{" "}
                              {item.gstRateBps / 100}% ·{" "}
                              {item.stockQuantity == null
                                ? "Stock not tracked"
                                : `${item.stockQuantity} in stock`}
                              {item.discountType !== "none"
                                ? ` · ${
                                    item.discountType === "percent"
                                      ? `${item.discountValue}%`
                                      : formatInr(item.discountValue)
                                  } off`
                                : ""}
                            </span>
                            <strong>{formatInr(item.pricePaise)}</strong>
                          </button>
                        ))}
                      {catalog.filter(
                        (item) =>
                          item.active &&
                          `${item.name} ${item.brand} ${item.design} ${item.size} ${item.category} ${item.sku} ${item.barcode} ${item.hsnSac}`
                            .toLowerCase()
                            .includes(catalogQuery.trim().toLowerCase()),
                      ).length === 0 && (
                        <div className="billing-search-empty">
                          No catalog item matches “{catalogQuery.trim()}”.
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="billing-search-empty">
                      Search by product name, brand, design, size, category,
                      SKU, barcode, or HSN/SAC to show catalog items.
                    </div>
                  )}
                  <div className="billing-custom-item">
                    <b>One-off custom item</b>
                    <input
                      value={customName}
                      onChange={(event) => setCustomName(event.target.value)}
                      placeholder="Item name"
                    />
                    <input
                      value={customHsn}
                      onChange={(event) => setCustomHsn(event.target.value)}
                      placeholder="HSN/SAC"
                    />
                    <input
                      type="number"
                      min="0"
                      value={customPrice}
                      onChange={(event) => setCustomPrice(event.target.value)}
                      placeholder="Price ₹"
                    />
                    <select
                      value={customGstRate}
                      onChange={(event) =>
                        setCustomGstRate(
                          Number(event.target.value) as GstRateBps,
                        )
                      }
                    >
                      {[0, 500, 1200, 1800, 2800].map((rate) => (
                        <option key={rate} value={rate}>
                          GST {rate / 100}%
                        </option>
                      ))}
                    </select>
                    <WorkspaceButton secondary onClick={addCustomItem}>
                      Add custom
                    </WorkspaceButton>
                  </div>
                  <div className="billing-customer-search">
                    <input
                      className="field"
                      value={customerQuery}
                      onChange={(event) => setCustomerQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") searchCustomers()
                      }}
                      placeholder="Optional loyalty customer"
                    />
                    <WorkspaceButton secondary onClick={searchCustomers}>
                      {busy ? "Searching…" : "Search"}
                    </WorkspaceButton>
                    <WorkspaceButton
                      secondary
                      onClick={() => setShowAddCustomer((shown) => !shown)}
                    >
                      + Add customer
                    </WorkspaceButton>
                    {showAddCustomer && (
                      <form
                        className="billing-add-customer"
                        onSubmit={addCheckoutCustomer}
                      >
                        <b>Add loyalty customer</b>
                        <input
                          className="field"
                          required
                          value={newCustomerName}
                          onChange={(event) =>
                            setNewCustomerName(event.target.value)
                          }
                          placeholder="Customer name"
                        />
                        <div className="billing-phone-field">
                          <select
                            aria-label="Customer country calling code"
                            value={newCustomerCountry}
                            onChange={(event) =>
                              setNewCustomerCountry(event.target.value)
                            }
                          >
                            {countryCallingCodes.map((option) => (
                              <option
                                key={`${option.country}-${option.dial}`}
                                value={option.country}
                              >
                                {option.country} ({option.dial})
                              </option>
                            ))}
                          </select>
                          <span>
                            {countryCallingCodes.find(
                              (option) => option.country === newCustomerCountry,
                            )?.dial ?? ""}
                          </span>
                          <input
                            required
                            type="tel"
                            inputMode="tel"
                            value={newCustomerLocalPhone}
                            onChange={(event) =>
                              setNewCustomerLocalPhone(
                                event.target.value.replace(/[^\d\s()-]/g, ""),
                              )
                            }
                            placeholder="Phone number"
                          />
                        </div>
                        <WorkspaceButton type="submit" disabled={busy}>
                          {busy ? "Adding…" : "Add and select"}
                        </WorkspaceButton>
                      </form>
                    )}
                    {customer && (
                      <button
                        className="billing-selected-customer"
                        onClick={() => setCustomer(null)}
                      >
                        <b>{customer.name}</b>
                        <span>
                          {customer.maskedPhone} · {customer.points} points ·
                          earns {projectedPoints}
                        </span>
                      </button>
                    )}
                    {!customer &&
                      customers.map((item) => (
                        <button
                          className="billing-customer-result"
                          key={item.id}
                          onClick={() => {
                            setCustomer(item)
                            setCustomers([])
                          }}
                        >
                          <b>{item.name}</b>
                          <span>
                            {item.maskedPhone} · {item.points} points
                          </span>
                        </button>
                      ))}
                  </div>
                </section>
                <section className="billing-panel billing-cart">
                  <div className="billing-section-head">
                    <div>
                      <span>Current bill</span>
                      <b>{cart.length} line items</b>
                    </div>
                    <select
                      className="field"
                      value={placeOfSupply}
                      onChange={(event) => setPlaceOfSupply(event.target.value)}
                    >
                      <option value={settings.stateCode}>
                        Local supply · {settings.stateName}
                      </option>
                      <option value="29">Interstate · Karnataka</option>
                      <option value="33">Interstate · Tamil Nadu</option>
                      <option value="32">Interstate · Kerala</option>
                      <option value="27">Interstate · Maharashtra</option>
                    </select>
                  </div>
                  <div className="billing-cart-lines">
                    {cart.length === 0 ? (
                      <div className="billing-empty compact">
                        Add an item to begin billing.
                      </div>
                    ) : (
                      cart.map((line) => (
                        <div className="billing-cart-line" key={line.id}>
                          <div>
                            <b>{line.name}</b>
                            <span>
                              GST {line.gstRateBps / 100}% ·{" "}
                              {line.priceIncludesTax
                                ? "inclusive"
                                : "exclusive"}
                              {line.automaticDiscountType
                                ? ` · automatic ${
                                    line.automaticDiscountType === "percent"
                                      ? `${line.automaticDiscountValue}%`
                                      : formatInr(
                                          line.automaticDiscountValue ?? 0,
                                        )
                                  } discount`
                                : ""}
                            </span>
                          </div>
                          <input
                            type="number"
                            min="0.001"
                            step="0.001"
                            value={line.quantity}
                            onChange={(event) =>
                              updateLine(line.id, {
                                quantity: Number(event.target.value),
                                lineDiscountPaise: automaticDiscountPaise(
                                  line,
                                  Number(event.target.value),
                                ),
                              })
                            }
                          />
                          <input
                            type="number"
                            min="0"
                            placeholder="Discount ₹"
                            value={line.lineDiscountPaise / 100 || ""}
                            onChange={(event) =>
                              updateLine(line.id, {
                                lineDiscountPaise: rupeesToPaise(
                                  event.target.value,
                                ),
                                automaticDiscountType: undefined,
                                automaticDiscountValue: undefined,
                              })
                            }
                          />
                          <button
                            onClick={() =>
                              setCart((items) =>
                                items.filter((item) => item.id !== line.id),
                              )
                            }
                          >
                            Remove
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="billing-cart-discounts">
                    <label className="billing-discount">
                      Cash discount
                      <input
                        type="number"
                        min="0"
                        value={cartDiscount}
                        onChange={(event) =>
                          setCartDiscount(event.target.value)
                        }
                        placeholder="₹0"
                      />
                    </label>
                    <label className="billing-discount">
                      Discount percentage
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={cartDiscountPercent}
                        onChange={(event) =>
                          setCartDiscountPercent(event.target.value)
                        }
                        placeholder="0%"
                      />
                    </label>
                    {percentageDiscountPaise > 0 && (
                      <small>
                        Percentage discount automatically applied:{" "}
                        <b>{formatInr(percentageDiscountPaise)}</b>
                      </small>
                    )}
                  </div>
                  <div className="billing-totals">
                    <span>
                      Total MRP (before discount){" "}
                      <b>{formatInr(totals.subtotalPaise)}</b>
                    </span>
                    {totals.lineDiscountPaise > 0 && (
                      <span>
                        Item discount{" "}
                        <b>-{formatInr(totals.lineDiscountPaise)}</b>
                      </span>
                    )}
                    {totals.cartDiscountPaise > 0 && (
                      <span>
                        Bill discount{" "}
                        <b>-{formatInr(totals.cartDiscountPaise)}</b>
                      </span>
                    )}
                    <span>
                      Taxable <b>{formatInr(totals.taxablePaise)}</b>
                    </span>
                    {totals.cgstPaise > 0 && (
                      <span>
                        CGST <b>{formatInr(totals.cgstPaise)}</b>
                      </span>
                    )}
                    {totals.sgstPaise > 0 && (
                      <span>
                        SGST <b>{formatInr(totals.sgstPaise)}</b>
                      </span>
                    )}
                    {totals.igstPaise > 0 && (
                      <span>
                        IGST <b>{formatInr(totals.igstPaise)}</b>
                      </span>
                    )}
                    <strong>
                      Total <b>{formatInr(totals.totalPaise)}</b>
                    </strong>
                  </div>
                  <div className="billing-payments">
                    <div className="billing-section-head">
                      <b>Payments</b>
                      <button onClick={addPayment}>+ Split payment</button>
                    </div>
                    {payments.map((payment) => (
                      <div className="billing-payment-row" key={payment.id}>
                        <select
                          value={payment.mode}
                          onChange={(event) =>
                            setPayments((items) =>
                              items.map((item) =>
                                item.id === payment.id
                                  ? {
                                      ...item,
                                      mode: event.target
                                        .value as BillingPayment["mode"],
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <option value="cash">Cash</option>
                          <option value="upi">UPI</option>
                          <option value="card">Card</option>
                        </select>
                        <input
                          type="number"
                          min="0"
                          value={payment.amountPaise / 100 || ""}
                          onChange={(event) =>
                            setPayments((items) =>
                              items.map((item) =>
                                item.id === payment.id
                                  ? {
                                      ...item,
                                      amountPaise: rupeesToPaise(
                                        event.target.value,
                                      ),
                                    }
                                  : item,
                              ),
                            )
                          }
                          placeholder="Amount ₹"
                        />
                        <input
                          value={payment.reference ?? ""}
                          onChange={(event) =>
                            setPayments((items) =>
                              items.map((item) =>
                                item.id === payment.id
                                  ? { ...item, reference: event.target.value }
                                  : item,
                              ),
                            )
                          }
                          placeholder="Reference"
                        />
                      </div>
                    ))}
                  </div>
                  <WorkspaceButton
                    disabled={
                      busy ||
                      !cart.length ||
                      totals.totalPaise <= 0 ||
                      paymentTotal !== totals.totalPaise
                    }
                    onClick={finalizeInvoice}
                  >
                    {busy
                      ? "Finalizing…"
                      : paymentTotal !== totals.totalPaise
                        ? `Allocate ${formatInr(totals.totalPaise - paymentTotal)}`
                        : `Pay ${formatInr(totals.totalPaise)}`}
                  </WorkspaceButton>
                </section>
              </div>
            )}
          </>
        )}
        {view === "catalog" && (
          <div
            className={`billing-management-grid ${
              showCatalogEditor ? "" : "catalog-list-only"
            }`}
          >
            <section className="billing-panel">
              <div className="billing-section-head">
                <div>
                  <span>Products and services</span>
                  <b>
                    {filteredCatalog.length} of {catalog.length} catalog items
                  </b>
                </div>
                <div className="billing-catalog-actions">
                  <WorkspaceButton
                    secondary
                    onClick={downloadCatalogImportTemplate}
                  >
                    Excel template
                  </WorkspaceButton>
                  <WorkspaceButton
                    secondary
                    onClick={() => catalogImportInput.current?.click()}
                  >
                    Import Excel
                  </WorkspaceButton>
                  <WorkspaceButton
                    onClick={() => {
                      cancelCatalogImport()
                      setCatalogDraft(emptyCatalogItem(merchant.id))
                      setShowCatalogEditor(true)
                    }}
                  >
                    + Add item
                  </WorkspaceButton>
                  <input
                    ref={catalogImportInput}
                    className="billing-file-input"
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={selectCatalogImportFile}
                  />
                </div>
              </div>
              {catalogImportFileName && (
                <section className="billing-import-preview">
                  <div>
                    <span>Excel import ready</span>
                    <b>{catalogImportFileName}</b>
                    <small>
                      {catalogImportRows.length} valid product
                      {catalogImportRows.length === 1 ? "" : "s"}
                      {catalogImportErrors.length > 0
                        ? ` · ${catalogImportErrors.length} row${catalogImportErrors.length === 1 ? "" : "s"} already marked for the error Excel`
                        : ""}
                    </small>
                    {catalogImportProgress && (
                      <small
                        className="billing-import-progress"
                        aria-live="polite"
                      >
                        {catalogImportProgress}
                      </small>
                    )}
                  </div>
                  {catalogImportRows.length > 0 && (
                    <ul>
                      {catalogImportRows.slice(0, 5).map((row) => (
                        <li key={row.sourceRow}>
                          <span>{row.item.name}</span>
                          <b>{formatInr(row.item.pricePaise)}</b>
                        </li>
                      ))}
                      {catalogImportRows.length > 5 && (
                        <li>
                          <span>
                            +{catalogImportRows.length - 5} more products
                          </span>
                        </li>
                      )}
                    </ul>
                  )}
                  <div className="billing-import-actions">
                    <WorkspaceButton
                      secondary
                      disabled={busy}
                      onClick={cancelCatalogImport}
                    >
                      Cancel
                    </WorkspaceButton>
                    <WorkspaceButton
                      disabled={busy}
                      onClick={importCatalogWorkbook}
                    >
                      {busy
                        ? catalogImportProgress || "Importing…"
                        : catalogImportRows.length > 0
                          ? `Import ${catalogImportRows.length} products`
                          : "Download error Excel"}
                    </WorkspaceButton>
                  </div>
                </section>
              )}
              <div className="billing-catalog-filters">
                <input
                  className="field"
                  value={catalogListQuery}
                  onChange={(event) => setCatalogListQuery(event.target.value)}
                  placeholder="Search catalog"
                />
                {([
                  ["Brand", "brand", "brands"],
                  ["Design", "design", "designs"],
                  ["Size", "size", "sizes"],
                  ["Category", "category", "categories"],
                ] as const).map(([label, field, group]) => (
                  <select
                    key={field}
                    className="field"
                    value={catalogFilters[field]}
                    onChange={(event) =>
                      setCatalogFilters({
                        ...catalogFilters,
                        [field]: event.target.value,
                      })
                    }
                  >
                    <option value="">All {label.toLowerCase()}s</option>
                    {Array.from(
                      new Set(
                        [
                          ...settingsDraft.catalogOptions[group],
                          ...catalog.map((item) => item[field]),
                        ].filter((option): option is string => Boolean(option)),
                      ),
                    ).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ))}
                <select
                  className="field"
                  value={catalogFilters.stock}
                  onChange={(event) =>
                    setCatalogFilters({
                      ...catalogFilters,
                      stock: event.target.value,
                    })
                  }
                >
                  <option value="">All stock</option>
                  <option value="in">In stock</option>
                  <option value="out">Out of stock</option>
                  <option value="untracked">Stock not tracked</option>
                </select>
                {settingsDraft.catalogCustomFields.map((field) => {
                  const values = Array.from(
                    new Set(
                      [
                        ...(settingsDraft.catalogCustomOptions[field] ?? []),
                        ...catalog.map((item) => item.customValues?.[field]),
                      ].filter((value): value is string => Boolean(value)),
                    ),
                  )
                  return (
                    <select
                      className="field"
                      key={field}
                      value={catalogFilters.custom[field] ?? ""}
                      onChange={(event) =>
                        setCatalogFilters({
                          ...catalogFilters,
                          custom: {
                            ...catalogFilters.custom,
                            [field]: event.target.value,
                          },
                        })
                      }
                    >
                      <option value="">All {field}</option>
                      {values.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  )
                })}
                <button
                  type="button"
                  className="billing-clear-filters"
                  onClick={() => {
                    setCatalogListQuery("")
                    setCatalogFilters({
                      brand: "",
                      design: "",
                      size: "",
                      category: "",
                      stock: "",
                      custom: {},
                    })
                  }}
                >
                  Clear filters
                </button>
              </div>
              <div className="billing-list">
                {filteredCatalog.slice(0, 500).map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setCatalogDraft(normalizeCatalogItem(item))
                      setShowCatalogEditor(true)
                    }}
                  >
                    <span>
                      <b>{item.name}</b>
                      <small>
                        {[item.brand, item.design, item.size, item.category]
                          .filter(Boolean)
                          .join(" · ") || item.hsnSac}
                        {" · "}GST {item.gstRateBps / 100}% ·{" "}
                        {item.stockQuantity == null
                          ? "Stock not tracked"
                          : `${item.stockQuantity} stock`}
                        {" · "}
                        {item.active ? "Active" : "Inactive"}
                        {item.discountType !== "none"
                          ? ` · ${
                              item.discountType === "percent"
                                ? `${item.discountValue}% discount`
                                : `${formatInr(item.discountValue)} discount`
                            }`
                          : ""}
                      </small>
                    </span>
                    <strong>{formatInr(item.pricePaise)}</strong>
                  </button>
                ))}
                {filteredCatalog.length === 0 && (
                  <div className="billing-search-empty">
                    No catalog items match these filters.
                  </div>
                )}
                {filteredCatalog.length > 500 && (
                  <div className="billing-search-empty">
                    Showing the first 500 matching items. Search or filter to
                    find the remaining {filteredCatalog.length - 500}.
                  </div>
                )}
              </div>
            </section>
            {showCatalogEditor && (
              <form
                className="billing-panel billing-form"
                onSubmit={saveCatalogItem}
              >
                <div className="billing-section-head">
                  <b>{catalogDraft.id ? "Edit item" : "New item"}</b>
                  <button
                    type="button"
                    onClick={() => {
                      setCatalogDraft(emptyCatalogItem(merchant.id))
                      setShowCatalogEditor(false)
                    }}
                  >
                    Cancel
                  </button>
                </div>
                <label>
                  Name
                  <input
                    className="field"
                    required
                    value={catalogDraft.name}
                    onChange={(event) =>
                      setCatalogDraft({
                        ...catalogDraft,
                        name: event.target.value,
                      })
                    }
                  />
                </label>
                {([
                  ["Brand", "brands", "brand"],
                  ["Design", "designs", "design"],
                  ["Size", "sizes", "size"],
                  ["Category", "categories", "category"],
                ] as const).map(([label, group, field]) => (
                  <div className="billing-option-picker" key={group}>
                    <span>{label}</span>
                    <div>
                      {settingsDraft.catalogOptions[group].length === 0 ? (
                        <small>
                          Add {label.toLowerCase()} options in Settings.
                        </small>
                      ) : (
                        settingsDraft.catalogOptions[group].map((option) => (
                          <button
                            type="button"
                            key={option}
                            className={
                              catalogDraft[field] === option ? "selected" : ""
                            }
                            onClick={() =>
                              setCatalogDraft({
                                ...catalogDraft,
                                [field]:
                                  catalogDraft[field] === option ? "" : option,
                              })
                            }
                          >
                            {option}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ))}
                <div className="billing-form-row">
                  <label>
                    Stock
                    <input
                      className="field"
                      type="number"
                      min="0"
                      step="0.001"
                      value={catalogDraft.stockQuantity ?? ""}
                      onChange={(event) =>
                        setCatalogDraft({
                          ...catalogDraft,
                          stockQuantity:
                            event.target.value === ""
                              ? null
                              : Number(event.target.value),
                        })
                      }
                      placeholder="Blank = not tracked"
                    />
                  </label>
                  <label>
                    Item type
                    <select
                      className="field"
                      value={catalogDraft.itemType}
                      onChange={(event) =>
                        setCatalogDraft({
                          ...catalogDraft,
                          itemType: event.target.value as "product" | "service",
                        })
                      }
                    >
                      <option value="product">Product</option>
                      <option value="service">Service</option>
                    </select>
                  </label>
                </div>
                <div className="billing-form-row">
                  <label>
                    Automatic discount
                    <select
                      className="field"
                      value={catalogDraft.discountType}
                      onChange={(event) =>
                        setCatalogDraft({
                          ...catalogDraft,
                          discountType: event.target
                            .value as CatalogItem["discountType"],
                          discountValue: 0,
                        })
                      }
                    >
                      <option value="none">No discount</option>
                      <option value="percent">Percentage discount</option>
                      <option value="fixed">Fixed discount per unit</option>
                    </select>
                  </label>
                  {catalogDraft.discountType !== "none" && (
                    <label>
                      {catalogDraft.discountType === "percent"
                        ? "Discount %"
                        : "Discount ₹ per unit"}
                      <input
                        className="field"
                        type="number"
                        min="0"
                        max={
                          catalogDraft.discountType === "percent"
                            ? "100"
                            : undefined
                        }
                        step={
                          catalogDraft.discountType === "percent" ? "0.01" : "1"
                        }
                        value={
                          catalogDraft.discountType === "fixed"
                            ? catalogDraft.discountValue / 100 || ""
                            : catalogDraft.discountValue || ""
                        }
                        onChange={(event) =>
                          setCatalogDraft({
                            ...catalogDraft,
                            discountValue:
                              catalogDraft.discountType === "fixed"
                                ? rupeesToPaise(event.target.value)
                                : Number(event.target.value),
                          })
                        }
                      />
                    </label>
                  )}
                </div>
                {settingsDraft.catalogCustomFields.length > 0 && (
                  <div className="billing-custom-fields-grid">
                    {settingsDraft.catalogCustomFields.map((field) => (
                      <div className="billing-option-picker" key={field}>
                        <span>{field}</span>
                        <div>
                          {(settingsDraft.catalogCustomOptions[field] ?? [])
                            .length === 0 ? (
                            <small>
                              Add {field.toLowerCase()} options in Settings.
                            </small>
                          ) : (
                            settingsDraft.catalogCustomOptions[field].map(
                              (option) => (
                                <button
                                  type="button"
                                  key={option}
                                  className={
                                    catalogDraft.customValues?.[field] ===
                                    option
                                      ? "selected"
                                      : ""
                                  }
                                  onClick={() =>
                                    setCatalogDraft({
                                      ...catalogDraft,
                                      customValues: {
                                        ...catalogDraft.customValues,
                                        [field]:
                                          catalogDraft.customValues?.[field] ===
                                          option
                                            ? ""
                                            : option,
                                      },
                                    })
                                  }
                                >
                                  {option}
                                </button>
                              ),
                            )
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="billing-form-row">
                  <label>
                    HSN/SAC
                    <input
                      className="field"
                      required
                      value={catalogDraft.hsnSac}
                      onChange={(event) =>
                        setCatalogDraft({
                          ...catalogDraft,
                          hsnSac: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    SKU
                    <input
                      className="field"
                      value={catalogDraft.sku}
                      onChange={(event) =>
                        setCatalogDraft({
                          ...catalogDraft,
                          sku: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
                <label>
                  Barcode
                  <div className="billing-barcode-field">
                    <input
                      className="field"
                      value={catalogDraft.barcode}
                      onChange={(event) =>
                        setCatalogDraft({
                          ...catalogDraft,
                          barcode: event.target.value,
                        })
                      }
                      placeholder="Scan, enter, or generate"
                    />
                    <WorkspaceButton
                      secondary
                      onClick={() =>
                        setCatalogDraft({
                          ...catalogDraft,
                          barcode: generateEan13(merchant.id),
                        })
                      }
                    >
                      Generate
                    </WorkspaceButton>
                    <WorkspaceButton
                      secondary
                      disabled={!catalogDraft.barcode}
                      onClick={printCatalogBarcode}
                    >
                      Print
                    </WorkspaceButton>
                  </div>
                </label>
                {catalogDraft.barcode && (
                  <div className="billing-barcode-card">
                    <BarcodeGraphic value={catalogDraft.barcode} />
                  </div>
                )}
                <div className="billing-form-row">
                  <label>
                    Price ₹
                    <input
                      className="field"
                      required
                      type="number"
                      min="0"
                      value={catalogDraft.pricePaise / 100 || ""}
                      onChange={(event) =>
                        setCatalogDraft({
                          ...catalogDraft,
                          pricePaise: rupeesToPaise(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    GST
                    <select
                      className="field"
                      value={catalogDraft.gstRateBps}
                      onChange={(event) =>
                        setCatalogDraft({
                          ...catalogDraft,
                          gstRateBps: Number(event.target.value) as GstRateBps,
                        })
                      }
                    >
                      {[0, 500, 1200, 1800, 2800].map((rate) => (
                        <option key={rate} value={rate}>
                          {rate / 100}%
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="billing-check">
                  <input
                    type="checkbox"
                    checked={catalogDraft.priceIncludesTax}
                    onChange={(event) =>
                      setCatalogDraft({
                        ...catalogDraft,
                        priceIncludesTax: event.target.checked,
                      })
                    }
                  />
                  Price includes GST
                </label>
                <label className="billing-check">
                  <input
                    type="checkbox"
                    checked={catalogDraft.active}
                    onChange={(event) =>
                      setCatalogDraft({
                        ...catalogDraft,
                        active: event.target.checked,
                      })
                    }
                  />
                  Active item
                </label>
                <WorkspaceButton type="submit" disabled={busy}>
                  Save catalog item
                </WorkspaceButton>
              </form>
            )}
          </div>
        )}
        {view === "sales" && (
          <div className="billing-sales-workspace">
            <section className="billing-panel billing-sales-overview">
              <div className="billing-section-head">
                <div>
                  <span>Sales performance</span>
                  <b>
                    {
                      salesRangeOptions.find(
                        (option) => option.value === salesRange,
                      )?.label
                    }
                  </b>
                </div>
                <WorkspaceButton secondary onClick={loadInvoices}>
                  Refresh
                </WorkspaceButton>
              </div>
              <div className="billing-sales-ranges" aria-label="Sales period">
                {salesRangeOptions.map((option) => (
                  <WorkspaceButton
                    key={option.value}
                    secondary
                    active={salesRange === option.value}
                    onClick={() => setSalesRange(option.value)}
                  >
                    {option.label}
                  </WorkspaceButton>
                ))}
              </div>
              <div className="billing-sales-metrics">
                <div>
                  <span>Total sales</span>
                  <strong>{formatInr(salesReport.totalPaise)}</strong>
                </div>
                <div>
                  <span>Invoices</span>
                  <strong>{salesReport.invoices.length}</strong>
                </div>
                <div>
                  <span>Average sale</span>
                  <strong>{formatInr(salesReport.averagePaise)}</strong>
                </div>
              </div>
              <SalesLineChart buckets={salesReport.buckets} />
            </section>
            <section className="billing-panel">
              <div className="billing-section-head">
                <div>
                  <span>Sales history</span>
                  <b>{salesReport.invoices.length} invoices in this period</b>
                </div>
              </div>
              <div className="billing-sales-list">
                {salesReport.invoices.map((invoice) => (
                  <div className="billing-sales-row" key={invoice.id}>
                    <button onClick={() => openInvoice(invoice.id)}>
                      <span>
                        <b>{invoice.invoiceNumber}</b>
                        <small>
                          {invoice.customerName || "Walk-in"} ·{" "}
                          {new Date(invoice.createdAt).toLocaleString("en-IN")}
                        </small>
                      </span>
                      <em>{invoice.status.replace("_", " ")}</em>
                      <strong>{formatInr(invoice.totalPaise)}</strong>
                    </button>
                    <div className="billing-invoice-row-actions">
                      <button
                        className="billing-edit-invoice"
                        disabled={invoice.status !== "paid" || busy}
                        onClick={() => openInvoice(invoice.id, true)}
                      >
                        Edit
                      </button>
                      <button
                        className="billing-delete-invoice"
                        disabled={invoice.status !== "paid" || busy}
                        onClick={() =>
                          deleteInvoice(invoice.id, invoice.invoiceNumber)
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
                {salesReport.invoices.length === 0 && (
                  <div className="billing-search-empty">
                    No sales were recorded in this period.
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
        {selectedSale && settings && (
          <div
            className="billing-detail-backdrop"
            onMouseDown={() => setSelectedSale(null)}
          >
            <section
              className="billing-detail"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="billing-section-head">
                <div>
                  <span>Tax invoice</span>
                  <b>{selectedSale.invoice.invoice_number}</b>
                </div>
                <button onClick={() => setSelectedSale(null)}>Close</button>
              </div>
              <div className="billing-invoice-meta">
                <span>
                  Customer
                  <b>{selectedSale.invoice.customer_name || "Walk-in"}</b>
                </span>
                <span>
                  Status
                  <b>{selectedSale.invoice.status.replace("_", " ")}</b>
                </span>
                <span>
                  Total
                  <b>{formatInr(selectedSale.invoice.total_paise)}</b>
                </span>
                <span>
                  Loyalty
                  <b>
                    {selectedSale.invoice.points_awarded} awarded ·{" "}
                    {selectedSale.invoice.points_reversed} reversed
                  </b>
                </span>
              </div>
              <div
                className={`billing-detail-lines ${
                  editingInvoice ? "billing-edit-lines" : ""
                }`}
              >
                {selectedSale.items.map((item: any, index: number) => (
                  <div key={item.id}>
                    <span>
                      <b>{item.name}</b>
                      <small>
                        {item.hsn_sac} · {item.quantity} {item.unit} · GST{" "}
                        {item.gst_rate_bps / 100}%
                      </small>
                    </span>
                    {editingInvoice ? (
                      <div className="billing-invoice-edit-fields">
                        <label>
                          Quantity
                          <input
                            type="number"
                            min="0.001"
                            step="0.001"
                            value={invoiceEditLines[index]?.quantity ?? ""}
                            onChange={(event) =>
                              setInvoiceEditLines((lines) =>
                                lines.map((line, lineIndex) =>
                                  lineIndex === index
                                    ? {
                                        ...line,
                                        quantity: Number(event.target.value),
                                      }
                                    : line,
                                ),
                              )
                            }
                          />
                        </label>
                        <label>
                          Unit price ₹
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={
                              (invoiceEditLines[index]?.unitPricePaise ?? 0) /
                                100 || ""
                            }
                            onChange={(event) =>
                              setInvoiceEditLines((lines) =>
                                lines.map((line, lineIndex) =>
                                  lineIndex === index
                                    ? {
                                        ...line,
                                        unitPricePaise: rupeesToPaise(
                                          event.target.value,
                                        ),
                                      }
                                    : line,
                                ),
                              )
                            }
                          />
                        </label>
                      </div>
                    ) : (
                      <strong>{formatInr(item.total_paise)}</strong>
                    )}
                  </div>
                ))}
              </div>
              <div className="billing-totals">
                <span>
                  Taxable
                  <b>{formatInr(selectedSale.invoice.taxable_paise)}</b>
                </span>
                <span>
                  CGST <b>{formatInr(selectedSale.invoice.cgst_paise)}</b>
                </span>
                <span>
                  SGST <b>{formatInr(selectedSale.invoice.sgst_paise)}</b>
                </span>
                <span>
                  IGST <b>{formatInr(selectedSale.invoice.igst_paise)}</b>
                </span>
                <strong>
                  Total <b>{formatInr(selectedSale.invoice.total_paise)}</b>
                </strong>
              </div>
              {selectedSale.creditNotes.length > 0 && (
                <div className="billing-credit-list">
                  <b>Credit notes</b>
                  {selectedSale.creditNotes.map((note: any) => (
                    <span key={note.id}>
                      {note.credit_note_number} · {formatInr(note.total_paise)}
                    </span>
                  ))}
                </div>
              )}
              <div className="billing-detail-actions">
                {editingInvoice ? (
                  <>
                    <WorkspaceButton
                      secondary
                      onClick={() => setEditingInvoice(false)}
                    >
                      Cancel
                    </WorkspaceButton>
                    <WorkspaceButton disabled={busy} onClick={saveInvoiceEdits}>
                      {busy ? "Saving…" : "Save invoice changes"}
                    </WorkspaceButton>
                  </>
                ) : (
                  <WorkspaceButton
                    secondary
                    disabled={selectedSale.invoice.status !== "paid"}
                    onClick={() => setEditingInvoice(true)}
                  >
                    Edit invoice
                  </WorkspaceButton>
                )}
                {!editingInvoice && (
                  <>
                    <WorkspaceButton
                      secondary
                      disabled={busy}
                      onClick={() => printHistoricalReceipt(80)}
                    >
                      Print 80 mm
                    </WorkspaceButton>
                    <WorkspaceButton
                      secondary
                      disabled={busy}
                      onClick={() => printHistoricalReceipt(58)}
                    >
                      Print 58 mm
                    </WorkspaceButton>
                  </>
                )}
                <WorkspaceButton
                  secondary
                  disabled={editingInvoice}
                  onClick={() => {
                    const invoice = selectedSale.invoice
                    downloadInvoicePdf({
                      invoice: {
                        id: invoice.id,
                        invoiceNumber: invoice.invoice_number,
                        status: invoice.status,
                        customerName: invoice.customer_name,
                        customerPhone: invoice.customer_phone,
                        totalPaise: Number(invoice.total_paise),
                        pointsAwarded: Number(invoice.points_awarded),
                        pointsReversed: Number(invoice.points_reversed),
                        createdAt: invoice.created_at,
                      },
                      settings,
                      totals: historicalInvoiceTotals(selectedSale),
                      payments: historicalInvoicePayments(selectedSale),
                    })
                  }}
                >
                  Download PDF
                </WorkspaceButton>
                {selectedSale.invoice.status !== "refunded" && (
                  <WorkspaceButton disabled={busy} onClick={refundInvoice}>
                    Create full credit note
                  </WorkspaceButton>
                )}
              </div>
            </section>
          </div>
        )}
        {showBarcodeScanner && (
          <div
            className="billing-detail-backdrop"
            onMouseDown={() => setShowBarcodeScanner(false)}
          >
            <section
              className="billing-scanner"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="billing-section-head">
                <div>
                  <span>Camera scanner</span>
                  <b>Point the camera at a product barcode</b>
                </div>
                <button onClick={() => setShowBarcodeScanner(false)}>
                  Close
                </button>
              </div>
              <video ref={scannerVideo} muted playsInline />
              <small>
                Camera access is used only while this scanner is open.
              </small>
            </section>
          </div>
        )}
        {view === "report" && (
          <div className="billing-report-workspace">
            <section className="billing-panel billing-report">
              <div className="billing-section-head">
                <div>
                  <span>Reports</span>
                  <b>Choose a report</b>
                </div>
              </div>
              <div className="billing-report-options">
                <WorkspaceButton
                  secondary
                  active={reportView === "stock"}
                  onClick={() => setReportView("stock")}
                >
                  Stock
                </WorkspaceButton>
                <WorkspaceButton
                  secondary
                  active={reportView === "sold"}
                  onClick={() => setReportView("sold")}
                >
                  Sold
                </WorkspaceButton>
              </div>
            </section>
            {reportView === "stock" && (
              <section className="billing-panel">
                <div className="billing-section-head">
                  <div>
                    <span>Stock report</span>
                    <b>{stockReportItems.length} products</b>
                  </div>
                </div>
                <div className="billing-report-unit-totals">
                  <div>
                    <span>Total stock units</span>
                    <strong>{formatUnits(stockReportTotals.all)}</strong>
                    <small>Before filters</small>
                  </div>
                  <div>
                    <span>Matching stock units</span>
                    <strong>{formatUnits(stockReportTotals.filtered)}</strong>
                    <small>After filters</small>
                  </div>
                </div>
                <div className="billing-catalog-filters">
                  <input
                    className="field"
                    value={stockReportQuery}
                    onChange={(event) =>
                      setStockReportQuery(event.target.value)
                    }
                    placeholder="Search stock"
                  />
                  {([
                    ["Brand", "brand", "brands"],
                    ["Design", "design", "designs"],
                    ["Size", "size", "sizes"],
                    ["Category", "category", "categories"],
                  ] as const).map(([label, field, group]) => (
                    <select
                      key={field}
                      className="field"
                      value={stockReportFilters[field]}
                      onChange={(event) =>
                        setStockReportFilters({
                          ...stockReportFilters,
                          [field]: event.target.value,
                        })
                      }
                    >
                      <option value="">All {label.toLowerCase()}s</option>
                      {Array.from(
                        new Set(
                          [
                            ...settingsDraft.catalogOptions[group],
                            ...catalog.map((item) => item[field]),
                          ].filter((option): option is string =>
                            Boolean(option),
                          ),
                        ),
                      ).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ))}
                  <select
                    className="field"
                    value={stockReportFilters.stock}
                    onChange={(event) =>
                      setStockReportFilters({
                        ...stockReportFilters,
                        stock: event.target.value,
                      })
                    }
                  >
                    <option value="">All stock</option>
                    <option value="in">In stock</option>
                    <option value="out">Out of stock</option>
                    <option value="untracked">Stock not tracked</option>
                  </select>
                  {settingsDraft.catalogCustomFields.map((field) => {
                    const values = Array.from(
                      new Set(
                        [
                          ...(settingsDraft.catalogCustomOptions[field] ?? []),
                          ...catalog.map((item) => item.customValues?.[field]),
                        ].filter((value): value is string => Boolean(value)),
                      ),
                    )
                    return (
                      <select
                        className="field"
                        key={field}
                        value={stockReportFilters.custom[field] ?? ""}
                        onChange={(event) =>
                          setStockReportFilters({
                            ...stockReportFilters,
                            custom: {
                              ...stockReportFilters.custom,
                              [field]: event.target.value,
                            },
                          })
                        }
                      >
                        <option value="">All {field}</option>
                        {values.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    )
                  })}
                  <button
                    type="button"
                    className="billing-clear-filters"
                    onClick={() => {
                      setStockReportQuery("")
                      setStockReportFilters({
                        brand: "",
                        design: "",
                        size: "",
                        category: "",
                        stock: "",
                        custom: {},
                      })
                    }}
                  >
                    Clear filters
                  </button>
                </div>
                <div className="billing-list billing-stock-report-list">
                  {stockReportItems.map((item) => (
                    <div key={item.id}>
                      <span>
                        <b>{item.name}</b>
                        <small>
                          {[item.brand, item.design, item.size, item.category]
                            .filter(Boolean)
                            .join(" · ") || item.hsnSac}
                        </small>
                      </span>
                      <strong>
                        {item.stockQuantity == null
                          ? "Not tracked"
                          : `${item.stockQuantity} ${item.unit}`}
                      </strong>
                    </div>
                  ))}
                  {stockReportItems.length === 0 && (
                    <div className="billing-search-empty">
                      No stock items match these filters.
                    </div>
                  )}
                </div>
              </section>
            )}
            {reportView === "sold" && (
              <section className="billing-panel">
                <div className="billing-section-head">
                  <div>
                    <span>Sold items report</span>
                    <b>{filteredSoldReportItems.length} sold products</b>
                  </div>
                  <WorkspaceButton secondary onClick={loadSoldReport}>
                    Refresh
                  </WorkspaceButton>
                </div>
                <div className="billing-report-unit-totals">
                  <div>
                    <span>Period units sold</span>
                    <strong>{formatUnits(soldReportTotals.all)}</strong>
                    <small>
                      {appliedSoldReportFrom || appliedSoldReportTo
                        ? `${appliedSoldReportFrom || "Beginning"} to ${appliedSoldReportTo || "Today"}`
                        : "All time"}
                    </small>
                  </div>
                  <div>
                    <span>Matching units sold</span>
                    <strong>{formatUnits(soldReportTotals.filtered)}</strong>
                    <small>After filters</small>
                  </div>
                </div>
                <div
                  className="billing-report-period"
                  aria-label="Sold report period"
                >
                  <label>
                    <span>From date</span>
                    <input
                      className="field"
                      type="date"
                      value={soldReportFrom}
                      max={
                        soldReportTo || new Date().toISOString().slice(0, 10)
                      }
                      onChange={(event) =>
                        setSoldReportFrom(event.target.value)
                      }
                    />
                  </label>
                  <label>
                    <span>To date</span>
                    <input
                      className="field"
                      type="date"
                      value={soldReportTo}
                      min={soldReportFrom || undefined}
                      max={new Date().toISOString().slice(0, 10)}
                      onChange={(event) => setSoldReportTo(event.target.value)}
                    />
                  </label>
                  <WorkspaceButton secondary onClick={applySoldReportPeriod}>
                    Apply period
                  </WorkspaceButton>
                </div>
                <div className="billing-catalog-filters">
                  <input
                    className="field"
                    value={soldReportQuery}
                    onChange={(event) => setSoldReportQuery(event.target.value)}
                    placeholder="Search sold items"
                  />
                  {([
                    ["Brand", "brand", "brands"],
                    ["Design", "design", "designs"],
                    ["Size", "size", "sizes"],
                    ["Category", "category", "categories"],
                  ] as const).map(([label, field, group]) => (
                    <select
                      key={field}
                      className="field"
                      value={soldReportFilters[field]}
                      onChange={(event) =>
                        setSoldReportFilters({
                          ...soldReportFilters,
                          [field]: event.target.value,
                        })
                      }
                    >
                      <option value="">All {label.toLowerCase()}s</option>
                      {Array.from(
                        new Set(
                          [
                            ...settingsDraft.catalogOptions[group],
                            ...soldReportItems.map((item) => item[field]),
                          ].filter((option): option is string =>
                            Boolean(option),
                          ),
                        ),
                      ).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ))}
                  {settingsDraft.catalogCustomFields.map((field) => {
                    const values = Array.from(
                      new Set(
                        [
                          ...(settingsDraft.catalogCustomOptions[field] ?? []),
                          ...soldReportItems.map(
                            (item) => item.customValues?.[field],
                          ),
                        ].filter((value): value is string => Boolean(value)),
                      ),
                    )
                    return (
                      <select
                        className="field"
                        key={field}
                        value={soldReportFilters.custom[field] ?? ""}
                        onChange={(event) =>
                          setSoldReportFilters({
                            ...soldReportFilters,
                            custom: {
                              ...soldReportFilters.custom,
                              [field]: event.target.value,
                            },
                          })
                        }
                      >
                        <option value="">All {field}</option>
                        {values.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    )
                  })}
                  <button
                    type="button"
                    className="billing-clear-filters"
                    onClick={() => {
                      setSoldReportQuery("")
                      setSoldReportFrom("")
                      setSoldReportTo("")
                      setSoldReportFilters({
                        brand: "",
                        design: "",
                        size: "",
                        category: "",
                        custom: {},
                      })
                      loadSoldReport("", "").catch((error) =>
                        setMessage(
                          error instanceof Error
                            ? error.message
                            : "Unable to load the sold items report.",
                        ),
                      )
                    }}
                  >
                    Clear filters
                  </button>
                </div>
                <div className="billing-list billing-stock-report-list billing-sold-report-list">
                  {filteredSoldReportItems.map((item) => (
                    <div key={item.id}>
                      <span>
                        <b>{item.name}</b>
                        <small>
                          {[item.brand, item.design, item.size, item.category]
                            .filter(Boolean)
                            .join(" · ") || item.hsnSac}
                        </small>
                      </span>
                      <strong>
                        <span>
                          {item.quantity} {item.unit} sold
                        </span>
                        <small>{formatInr(item.totalPaise)}</small>
                      </strong>
                    </div>
                  ))}
                  {filteredSoldReportItems.length === 0 && (
                    <div className="billing-search-empty">
                      No sold items match these filters.
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>
        )}
        {view === "settings" && (
          <form
            className="billing-panel billing-settings"
            onSubmit={saveSettings}
          >
            <div className="billing-section-head">
              <div>
                <span>GST seller profile</span>
                <b>Billing settings</b>
              </div>
            </div>
            <div className="billing-form-row">
              <label>
                Legal business name
                <input
                  className="field"
                  required
                  value={settingsDraft.legalName}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      legalName: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                GSTIN (optional)
                <input
                  className="field"
                  maxLength={15}
                  value={settingsDraft.gstin ?? ""}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      gstin: event.target.value.toUpperCase(),
                    })
                  }
                />
              </label>
            </div>
            <label>
              Address
              <input
                className="field"
                required
                value={settingsDraft.addressLine1}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    addressLine1: event.target.value,
                  })
                }
              />
            </label>
            <div className="billing-form-row">
              <label>
                City
                <input
                  className="field"
                  required
                  value={settingsDraft.city}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      city: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                State
                <input
                  className="field"
                  required
                  value={settingsDraft.stateName}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      stateName: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                State code
                <input
                  className="field"
                  required
                  maxLength={2}
                  value={settingsDraft.stateCode}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      stateCode: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                PIN code
                <input
                  className="field"
                  required
                  maxLength={6}
                  value={settingsDraft.postalCode}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      postalCode: event.target.value,
                    })
                  }
                />
              </label>
            </div>
            <div className="billing-form-row">
              <label>
                Invoice prefix
                <input
                  className="field"
                  value={settingsDraft.invoicePrefix}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      invoicePrefix: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Credit note prefix
                <input
                  className="field"
                  value={settingsDraft.creditNotePrefix}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      creditNotePrefix: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Points per ₹
                <input
                  className="field"
                  type="number"
                  min="0"
                  step="0.01"
                  value={settingsDraft.pointsPerRupee}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      pointsPerRupee: Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>
            <label className="billing-receipt-footer-setting">
              Receipt footer paragraph (optional)
              <textarea
                className="field"
                rows={4}
                maxLength={500}
                value={settingsDraft.receiptFooter}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    receiptFooter: event.target.value,
                  })
                }
                placeholder="Example: Thank you for shopping with us. Exchange within 7 days with the original bill."
              />
              <small>
                Printed below “Thank you” ·{" "}
                {settingsDraft.receiptFooter.length}/500 characters
              </small>
            </label>
            <section className="billing-custom-settings">
              <div>
                <b>Catalog click options</b>
                <span>
                  Manage the values staff can select with one click when
                  creating or editing an item.
                </span>
              </div>
              <div className="billing-option-settings-grid">
                {([
                  ["Brands", "brands"],
                  ["Designs", "designs"],
                  ["Sizes", "sizes"],
                  ["Categories", "categories"],
                ] as const).map(([label, group]) => (
                  <div className="billing-option-setting" key={group}>
                    <b>{label}</b>
                    <div className="billing-custom-setting-entry">
                      <input
                        className="field"
                        type="text"
                        value={newCatalogOption[group] ?? ""}
                        onChange={(event) =>
                          setNewCatalogOption((options) => ({
                            ...options,
                            [group]: event.target.value,
                          }))
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            addCatalogOption(group)
                          }
                        }}
                        placeholder={`Add ${label.toLowerCase()}`}
                      />
                      <WorkspaceButton
                        secondary
                        onClick={() => addCatalogOption(group)}
                      >
                        Add
                      </WorkspaceButton>
                    </div>
                    <div className="billing-custom-setting-list">
                      {settingsDraft.catalogOptions[group].map((option) => (
                        <span key={option}>
                          {option}
                          <button
                            type="button"
                            onClick={() => removeCatalogOption(group, option)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
            <section className="billing-custom-settings">
              <div>
                <b>Custom catalog options</b>
                <span>
                  Add your own reusable text fields for every catalog item.
                </span>
              </div>
              <div className="billing-custom-setting-entry">
                <input
                  className="field"
                  value={newCustomField}
                  onChange={(event) => setNewCustomField(event.target.value)}
                  placeholder="Example: Material, Collection, Color"
                />
                <WorkspaceButton secondary onClick={addCustomCatalogField}>
                  Add field
                </WorkspaceButton>
              </div>
              <div className="billing-custom-setting-list">
                {settingsDraft.catalogCustomFields.map((field) => (
                  <span key={field}>
                    {field}
                    <button
                      type="button"
                      onClick={() => {
                        const { [field]: _removed, ...remainingOptions } =
                          settingsDraft.catalogCustomOptions
                        setSettingsDraft({
                          ...settingsDraft,
                          catalogCustomFields:
                            settingsDraft.catalogCustomFields.filter(
                              (current) => current !== field,
                            ),
                          catalogCustomOptions: remainingOptions,
                        })
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="billing-option-settings-grid">
                {settingsDraft.catalogCustomFields.map((field) => (
                  <div className="billing-option-setting" key={field}>
                    <b>{field}</b>
                    <div className="billing-custom-setting-entry">
                      <input
                        className="field"
                        value={newCustomCatalogOption[field] ?? ""}
                        onChange={(event) =>
                          setNewCustomCatalogOption((options) => ({
                            ...options,
                            [field]: event.target.value,
                          }))
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            addCustomCatalogOption(field)
                          }
                        }}
                        placeholder={`Add ${field.toLowerCase()}`}
                      />
                      <WorkspaceButton
                        secondary
                        onClick={() => addCustomCatalogOption(field)}
                      >
                        Add
                      </WorkspaceButton>
                    </div>
                    <div className="billing-custom-setting-list">
                      {(settingsDraft.catalogCustomOptions[field] ?? []).map(
                        (option) => (
                          <span key={option}>
                            {option}
                            <button
                              type="button"
                              onClick={() =>
                                removeCustomCatalogOption(field, option)
                              }
                            >
                              ×
                            </button>
                          </span>
                        ),
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
            <WorkspaceButton type="submit" disabled={busy}>
              Save billing settings
            </WorkspaceButton>
          </form>
        )}
      </main>
    </div>
  )
}
