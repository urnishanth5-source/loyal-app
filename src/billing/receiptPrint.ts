import { formatInr } from "./calculations"
import type { BillingPayment, BillingTotals } from "./types"

export type ThermalReceiptWidth = 58 | 80

export type ThermalReceiptSeller = {
  legalName: string
  gstin?: string
  addressLine1: string
  addressLine2?: string
  city: string
  stateName: string
  postalCode: string
}

export type ThermalReceiptData = {
  seller: ThermalReceiptSeller
  invoiceNumber: string
  createdAt: string
  status: "paid" | "partially_refunded" | "refunded"
  placeOfSupplyCode?: string
  customerName?: string
  customerPhone?: string
  totals: BillingTotals
  payments: BillingPayment[]
  pointsAwarded: number
  pointsReversed: number
  footerNote?: string
  refundedPaise?: number
  creditNoteNumbers?: string[]
}

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")

const formatQuantity = (value: number) =>
  Number(value).toLocaleString("en-IN", { maximumFractionDigits: 3 })

const maskPhone = (phone?: string) => {
  if (!phone) return ""
  const digits = phone.replace(/\D/g, "")
  if (digits.length <= 4) return digits
  return `${"•".repeat(Math.min(6, digits.length - 4))}${digits.slice(-4)}`
}

const moneyRow = (
  label: string,
  value: number,
  className = "",
) => `<div class="money-row ${className}">
  <span>${escapeHtml(label)}</span><strong>${escapeHtml(formatInr(value))}</strong>
</div>`

export function buildThermalReceiptHtml(
  data: ThermalReceiptData,
  width: ThermalReceiptWidth,
) {
  const isNarrow = width === 58
  const margin = isNarrow ? 2.5 : 3
  const address = [
    data.seller.addressLine1,
    data.seller.addressLine2,
    [data.seller.city, data.seller.stateName, data.seller.postalCode]
      .filter(Boolean)
      .join(" "),
  ].filter(Boolean)
  const invoiceDate = new Date(data.createdAt)
  const formattedDate = Number.isNaN(invoiceDate.getTime())
    ? data.createdAt
    : invoiceDate.toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
      })
  const status =
    data.status === "paid"
      ? ""
      : `<div class="status">${escapeHtml(data.status.replace("_", " ").toUpperCase())}</div>`
  const customer = data.customerName || "Walk-in"
  const phone = maskPhone(data.customerPhone)
  const itemRows = data.totals.lines
    .map(
      (line) => `<section class="item">
        <div class="item-name">${escapeHtml(line.name)}</div>
        <div class="item-detail">
          <span>HSN ${escapeHtml(line.hsnSac)} · GST ${escapeHtml(line.gstRateBps / 100)}%</span>
          <span>${escapeHtml(formatQuantity(line.quantity))} ${escapeHtml(line.unit)} × ${escapeHtml(formatInr(line.unitPricePaise))}</span>
          <strong>${escapeHtml(formatInr(line.totalPaise))}</strong>
        </div>
      </section>`,
    )
    .join("")
  const totalRows = [
    moneyRow("Total MRP (before discount)", data.totals.subtotalPaise),
    data.totals.lineDiscountPaise
      ? moneyRow("Item discount", -data.totals.lineDiscountPaise)
      : "",
    data.totals.cartDiscountPaise
      ? moneyRow("Bill discount", -data.totals.cartDiscountPaise)
      : "",
    moneyRow("Taxable amount", data.totals.taxablePaise),
    data.totals.cgstPaise ? moneyRow("CGST", data.totals.cgstPaise) : "",
    data.totals.sgstPaise ? moneyRow("SGST", data.totals.sgstPaise) : "",
    data.totals.igstPaise ? moneyRow("IGST", data.totals.igstPaise) : "",
    moneyRow("Grand total", data.totals.totalPaise, "grand-total"),
  ].join("")
  const paymentRows = data.payments
    .map(
      (payment) => `<div class="payment-row">
        <span>${escapeHtml(payment.mode.toUpperCase())}${
          payment.reference
            ? `<small>${escapeHtml(payment.reference)}</small>`
            : ""
        }</span>
        <strong>${escapeHtml(formatInr(payment.amountPaise))}</strong>
      </div>`,
    )
    .join("")
  const refundSection =
    data.status === "paid"
      ? ""
      : `<section class="refund">
          ${moneyRow("Refunded", Number(data.refundedPaise ?? 0))}
          ${
            data.creditNoteNumbers?.length
              ? `<div>Credit note${
                  data.creditNoteNumbers.length > 1 ? "s" : ""
                }: ${data.creditNoteNumbers.map(escapeHtml).join(", ")}</div>`
              : ""
          }
        </section>`

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(data.invoiceNumber)}</title>
  <style>
    @page { size: ${width}mm auto; margin: ${margin}mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; color: #000; background: #fff; }
    body {
      width: 100%;
      font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: ${isNarrow ? "9.5px" : "11px"};
      line-height: 1.35;
      overflow-wrap: anywhere;
      font-variant-numeric: tabular-nums;
    }
    h1, h2, p { margin: 0; }
    header { text-align: center; }
    h1 { font-size: ${isNarrow ? "14px" : "17px"}; line-height: 1.2; }
    .address { margin-top: 3px; }
    .tax-title { margin-top: 7px; font-size: ${
      isNarrow ? "11px" : "13px"
    }; letter-spacing: .08em; }
    .gstin { margin-top: 3px; font-weight: 700; }
    .separator { margin: 7px 0; border-top: 1px dashed #000; }
    .meta { display: grid; gap: 2px; }
    .meta-row, .money-row, .payment-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 7px;
    }
    .meta-row span:first-child, .money-row span:first-child { flex: 0 0 auto; }
    .meta-row strong, .money-row strong, .payment-row strong { text-align: right; }
    .status {
      margin: 6px 0;
      padding: 3px;
      border: 1px solid #000;
      text-align: center;
      font-weight: 800;
      letter-spacing: .08em;
    }
    .items-head {
      display: flex;
      justify-content: space-between;
      margin-bottom: 3px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .item { padding: 4px 0; border-top: 1px dotted #777; }
    .item:first-of-type { border-top: 0; }
    .item-name { font-weight: 800; }
    .item-detail {
      display: grid;
      grid-template-columns: ${isNarrow ? "1fr auto" : "1.25fr 1fr auto"};
      gap: 2px 7px;
      margin-top: 2px;
      color: #111;
      font-size: ${isNarrow ? "8.5px" : "10px"};
    }
    .item-detail strong { text-align: right; }
    ${
      isNarrow
        ? `.item-detail span:first-child { grid-column: 1 / -1; }
           .item-detail strong { grid-column: 2; grid-row: 2; }`
        : ""
    }
    .totals, .payments { display: grid; gap: 2px; }
    .grand-total {
      margin-top: 4px;
      padding-top: 5px;
      border-top: 1px dashed #000;
      font-size: ${isNarrow ? "13px" : "15px"};
      font-weight: 800;
    }
    .section-title { margin-bottom: 3px; font-weight: 800; text-transform: uppercase; }
    .payment-row small { display: block; font-size: .85em; }
    .refund { margin-top: 7px; padding: 5px; border: 1px solid #000; font-weight: 700; }
    footer { margin-top: 9px; text-align: center; }
    footer strong { display: block; margin-top: 5px; font-size: ${
      isNarrow ? "11px" : "12px"
    }; }
    .footer-note {
      margin-top: 5px;
      font-size: ${isNarrow ? "8.5px" : "9.5px"};
      line-height: 1.4;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(data.seller.legalName)}</h1>
    <div class="address">${address.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>
    ${
      data.seller.gstin
        ? `<div class="gstin">GSTIN: ${escapeHtml(data.seller.gstin)}</div>`
        : ""
    }
    <h2 class="tax-title">TAX INVOICE</h2>
  </header>
  <div class="separator"></div>
  ${status}
  <section class="meta">
    <div class="meta-row"><span>Invoice</span><strong>${escapeHtml(data.invoiceNumber)}</strong></div>
    <div class="meta-row"><span>Date</span><strong>${escapeHtml(formattedDate)}</strong></div>
    <div class="meta-row"><span>Customer</span><strong>${escapeHtml(customer)}${
      phone ? `<br>${escapeHtml(phone)}` : ""
    }</strong></div>
    ${
      data.placeOfSupplyCode
        ? `<div class="meta-row"><span>Place of supply</span><strong>${escapeHtml(data.placeOfSupplyCode)}</strong></div>`
        : ""
    }
  </section>
  <div class="separator"></div>
  <div class="items-head"><span>Items</span><span>Amount</span></div>
  <div>${itemRows}</div>
  <div class="separator"></div>
  <section class="totals">${totalRows}</section>
  ${refundSection}
  <div class="separator"></div>
  <section>
    <div class="section-title">Payment</div>
    <div class="payments">${paymentRows || '<div class="payment-row"><span>Not recorded</span></div>'}</div>
  </section>
  <footer>
    <div>Points awarded: ${escapeHtml(data.pointsAwarded)}</div>
    ${
      data.pointsReversed
        ? `<div>Points reversed: ${escapeHtml(data.pointsReversed)}</div>`
        : ""
    }
    <strong>Thank you</strong>
    ${
      data.footerNote
        ? `<div class="footer-note">${escapeHtml(data.footerNote)}</div>`
        : ""
    }
  </footer>
</body>
</html>`
}

export function printThermalReceipt(
  data: ThermalReceiptData,
  width: ThermalReceiptWidth,
) {
  const popup = window.open(
    "",
    "_blank",
    `width=${width === 58 ? 340 : 440},height=720`,
  )
  if (!popup) return false
  popup.document.open()
  popup.document.write(buildThermalReceiptHtml(data, width))
  popup.document.close()
  const print = () => {
    popup.focus()
    popup.print()
  }
  if (popup.document.readyState === "complete") {
    window.setTimeout(print, 0)
  } else {
    popup.addEventListener("load", print, { once: true })
  }
  return true
}
