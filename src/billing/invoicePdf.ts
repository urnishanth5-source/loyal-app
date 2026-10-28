import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { formatInr } from "./calculations"
import type {
  BillingInvoiceSummary,
  BillingPayment,
  BillingSettings,
  BillingTotals,
} from "./types"

export async function downloadInvoicePdf({
  invoice,
  settings,
  totals,
  payments,
}: {
  invoice: BillingInvoiceSummary
  settings: BillingSettings
  totals: BillingTotals
  payments: BillingPayment[]
}) {
  const pdfDocument = await PDFDocument.create()
  const page = pdfDocument.addPage([595.28, 841.89])
  const regular = await pdfDocument.embedFont(StandardFonts.Helvetica)
  const bold = await pdfDocument.embedFont(StandardFonts.HelveticaBold)
  const violet = rgb(0.27, 0.07, 0.44)
  let y = 800
  const text = (
    value: string,
    x: number,
    size = 10,
    font = regular,
    color = rgb(0.15, 0.1, 0.2),
  ) => {
    page.drawText(value.replace(/[^\x20-\x7E]/g, " "), {
      x,
      y,
      size,
      font,
      color,
      maxWidth: 510,
    })
  }
  text(settings.legalName, 42, 20, bold, violet)
  if (settings.gstin) {
    y -= 22
    text(`GSTIN: ${settings.gstin}`, 42, 9)
  }
  y -= 14
  text(
    `${settings.addressLine1}${
      settings.addressLine2 ? `, ${settings.addressLine2}` : ""
    }, ${settings.city}, ${settings.stateName} ${settings.postalCode}`,
    42,
    9,
  )
  y -= 30
  text("TAX INVOICE", 42, 15, bold)
  text(invoice.invoiceNumber, 370, 11, bold)
  y -= 18
  text(new Date(invoice.createdAt).toLocaleString("en-IN"), 370, 9)
  y -= 25
  text(
    invoice.customerName
      ? `Customer: ${invoice.customerName} (${invoice.customerPhone ?? ""})`
      : "Customer: Walk-in",
    42,
    10,
    bold,
  )
  y -= 26
  text("Item", 42, 9, bold)
  text("HSN/SAC", 255, 9, bold)
  text("GST", 330, 9, bold)
  text("Amount", 450, 9, bold)
  y -= 8
  page.drawLine({
    start: { x: 42, y },
    end: { x: 553, y },
    thickness: 1,
    color: rgb(0.85, 0.8, 0.9),
  })
  y -= 16
  totals.lines.forEach((line) => {
    text(`${line.name} x ${line.quantity}`, 42, 9)
    text(line.hsnSac, 255, 9)
    text(`${line.gstRateBps / 100}%`, 330, 9)
    text(formatInr(line.totalPaise), 450, 9)
    y -= 17
  })
  y -= 8
  page.drawLine({
    start: { x: 320, y },
    end: { x: 553, y },
    thickness: 1,
    color: rgb(0.85, 0.8, 0.9),
  })
  y -= 18
  const totalRow = (label: string, value: number, emphasize = false) => {
    text(label, 340, emphasize ? 11 : 9, emphasize ? bold : regular)
    text(formatInr(value), 450, emphasize ? 11 : 9, emphasize ? bold : regular)
    y -= emphasize ? 21 : 16
  }
  totalRow("Total MRP", totals.subtotalPaise)
  if (totals.lineDiscountPaise)
    totalRow("Item discount", -totals.lineDiscountPaise)
  if (totals.cartDiscountPaise)
    totalRow("Bill discount", -totals.cartDiscountPaise)
  totalRow("Taxable", totals.taxablePaise)
  if (totals.cgstPaise) totalRow("CGST", totals.cgstPaise)
  if (totals.sgstPaise) totalRow("SGST", totals.sgstPaise)
  if (totals.igstPaise) totalRow("IGST", totals.igstPaise)
  totalRow("Total", totals.totalPaise, true)
  y -= 10
  text(
    `Payment: ${payments.map((payment) => `${payment.mode.toUpperCase()} ${formatInr(payment.amountPaise)}`).join(" + ")}`,
    42,
    9,
  )
  y -= 16
  text(`Loyalty points awarded: ${invoice.pointsAwarded}`, 42, 9)
  y = 45
  text("Computer generated invoice", 42, 8, regular, rgb(0.45, 0.4, 0.5))
  const bytes = await pdfDocument.save()
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `${invoice.invoiceNumber.replaceAll("/", "-")}.pdf`
  anchor.click()
  URL.revokeObjectURL(url)
}
