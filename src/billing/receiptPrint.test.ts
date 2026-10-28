import { describe, expect, it } from "vitest"
import {
  buildThermalReceiptHtml,
  type ThermalReceiptData,
} from "./receiptPrint"
import type { CalculatedLine } from "./types"

const line = (patch: Partial<CalculatedLine> = {}): CalculatedLine => ({
  id: "line-1",
  itemType: "product",
  name: "Cotton shirt",
  hsnSac: "6205",
  unit: "unit",
  quantity: 2,
  unitPricePaise: 50000,
  gstRateBps: 500,
  priceIncludesTax: true,
  lineDiscountPaise: 5000,
  lineNumber: 1,
  grossBeforeDiscountPaise: 100000,
  allocatedCartDiscountPaise: 5000,
  taxablePaise: 85714,
  cgstPaise: 2143,
  sgstPaise: 2143,
  igstPaise: 0,
  totalPaise: 90000,
  ...patch,
})

const receipt = (
  patch: Partial<ThermalReceiptData> = {},
): ThermalReceiptData => ({
  seller: {
    legalName: "Example Store",
    gstin: "33ABCDE1234F1Z5",
    addressLine1: "1 Main Road",
    city: "Chennai",
    stateName: "Tamil Nadu",
    postalCode: "600001",
  },
  invoiceNumber: "INV/2026-27/000001",
  createdAt: "2026-10-28T10:30:00.000Z",
  status: "paid",
  placeOfSupplyCode: "33",
  customerName: "Test Customer",
  customerPhone: "+919876543210",
  totals: {
    lines: [line()],
    subtotalPaise: 100000,
    lineDiscountPaise: 5000,
    cartDiscountPaise: 5000,
    taxablePaise: 85714,
    cgstPaise: 2143,
    sgstPaise: 2143,
    igstPaise: 0,
    totalPaise: 90000,
  },
  payments: [
    { id: "cash", mode: "cash", amountPaise: 40000 },
    { id: "upi", mode: "upi", amountPaise: 50000, reference: "UPI-123" },
  ],
  pointsAwarded: 90,
  pointsReversed: 0,
  footerNote: "Please retain this bill for exchanges.",
  ...patch,
})

describe("thermal receipt", () => {
  it("renders a full 80 mm GST receipt", () => {
    const html = buildThermalReceiptHtml(receipt(), 80)
    expect(html).toContain("@page { size: 80mm auto")
    expect(html).toContain("TAX INVOICE")
    expect(html).toContain("Total MRP (before discount)")
    expect(html).toContain("Item discount")
    expect(html).toContain("Bill discount")
    expect(html).toContain("CGST")
    expect(html).toContain("UPI-123")
    expect(html).toContain("Points awarded: 90")
    expect(html).toContain("Please retain this bill for exchanges.")
  })

  it("uses the narrow item layout for 58 mm receipts", () => {
    const html = buildThermalReceiptHtml(receipt(), 58)
    expect(html).toContain("@page { size: 58mm auto")
    expect(html).toContain(".item-detail span:first-child")
    expect(html).toContain("Cotton shirt")
  })

  it("omits zero-value optional totals", () => {
    const data = receipt()
    data.totals.lineDiscountPaise = 0
    data.totals.cartDiscountPaise = 0
    data.totals.cgstPaise = 0
    data.totals.sgstPaise = 0
    const html = buildThermalReceiptHtml(data, 80)
    expect(html).not.toContain("Item discount")
    expect(html).not.toContain("Bill discount")
    expect(html).not.toContain(">CGST<")
    expect(html).not.toContain(">SGST<")
  })

  it("shows refund and credit-note details", () => {
    const html = buildThermalReceiptHtml(
      receipt({
        status: "refunded",
        refundedPaise: 90000,
        pointsReversed: 90,
        creditNoteNumbers: ["CN/2026-27/000001"],
      }),
      80,
    )
    expect(html).toContain("REFUNDED")
    expect(html).toContain("Refunded")
    expect(html).toContain("CN/2026-27/000001")
    expect(html).toContain("Points reversed: 90")
  })

  it("escapes untrusted receipt text", () => {
    const html = buildThermalReceiptHtml(
      receipt({
        seller: {
          ...receipt().seller,
          legalName: '<script>alert("seller")</script>',
        },
        customerName: "<img src=x onerror=alert(1)>",
        totals: {
          ...receipt().totals,
          lines: [line({ name: "Shirt & <b>more</b>" })],
        },
        payments: [
          {
            id: "upi",
            mode: "upi",
            amountPaise: 90000,
            reference: '"><script>alert(1)</script>',
          },
        ],
        footerNote: "Keep this bill.\nNo <returns> without it.",
      }),
      80,
    )
    expect(html).not.toContain("<script>alert")
    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("Shirt &amp; &lt;b&gt;more&lt;/b&gt;")
    expect(html).toContain("Keep this bill.\nNo &lt;returns&gt; without it.")
  })
})
