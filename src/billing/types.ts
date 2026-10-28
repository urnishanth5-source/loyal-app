export type GstRateBps = 0 | 500 | 1200 | 1800 | 2800

export type BillingSettings = {
  businessId: number
  legalName: string
  gstin?: string
  addressLine1: string
  addressLine2?: string
  city: string
  stateName: string
  stateCode: string
  postalCode: string
  invoicePrefix: string
  creditNotePrefix: string
  pointsPerRupee: number
  receiptFooter: string
  catalogCustomFields: string[]
  catalogCustomOptions: Record<string, string[]>
  catalogOptions: {
    brands: string[]
    designs: string[]
    sizes: string[]
    categories: string[]
  }
}

export type CatalogItem = {
  id: string
  businessId: number
  itemType: "product" | "service"
  name: string
  category?: string
  brand?: string
  design?: string
  size?: string
  sku?: string
  barcode?: string
  hsnSac: string
  unit: string
  pricePaise: number
  gstRateBps: GstRateBps
  priceIncludesTax: boolean
  stockQuantity?: number | null
  customValues: Record<string, string>
  discountType: "none" | "percent" | "fixed"
  discountValue: number
  active: boolean
}

export type CartLine = {
  id: string
  catalogItemId?: string
  itemType: "product" | "service"
  name: string
  hsnSac: string
  unit: string
  quantity: number
  unitPricePaise: number
  gstRateBps: GstRateBps
  priceIncludesTax: boolean
  lineDiscountPaise: number
  automaticDiscountType?: "percent" | "fixed"
  automaticDiscountValue?: number
}

export type CalculatedLine = CartLine & {
  lineNumber: number
  grossBeforeDiscountPaise: number
  allocatedCartDiscountPaise: number
  taxablePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  totalPaise: number
}

export type BillingTotals = {
  lines: CalculatedLine[]
  subtotalPaise: number
  lineDiscountPaise: number
  cartDiscountPaise: number
  taxablePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  totalPaise: number
}

export type BillingPayment = {
  id: string
  mode: "cash" | "upi" | "card"
  amountPaise: number
  reference?: string
}

export type BillingCustomer = {
  id: string
  name: string
  phone: string
  maskedPhone: string
  points: number
}

export type BillingInvoiceSummary = {
  id: string
  invoiceNumber: string
  status: "paid" | "partially_refunded" | "refunded"
  customerName?: string
  customerPhone?: string
  totalPaise: number
  pointsAwarded: number
  pointsReversed: number
  createdAt: string
}

export type BillingInvoice = BillingInvoiceSummary & {
  businessId: number
  placeOfSupplyCode: string
  sellerSnapshot: Record<string, string>
  totals: Omit<BillingTotals, "lines">
  lines: CalculatedLine[]
  payments: BillingPayment[]
}
