import { Workbook } from "exceljs"
import type { CatalogItem, GstRateBps } from "./types"

export const MAX_CATALOG_IMPORT_ROWS = 10000

export type CatalogImportRow = {
  sourceRow: number
  source: Record<string, unknown>
  item: Omit<CatalogItem, "id" | "businessId">
}

export type CatalogImportError = {
  sourceRow: number
  source: Record<string, unknown>
  error: string
}

export type CatalogImportResult = {
  rows: CatalogImportRow[]
  errors: CatalogImportError[]
}

const baseHeaders = [
  "Name",
  "Item Type",
  "Brand",
  "Design",
  "Size",
  "Category",
  "Stock",
  "HSN/SAC",
  "Unit",
  "SKU",
  "Barcode",
  "MRP",
  "GST %",
  "Price Includes Tax",
  "Discount Type",
  "Discount Value",
  "Active",
]

const supportedGstRates = new Set([0, 5, 12, 18, 28])

const text = (value: unknown) => String(value ?? "").trim()

const numberValue = (value: unknown) => {
  if (typeof value === "number") return value
  const cleaned = text(value)
    .replaceAll(",", "")
    .replace(/[₹%]/g, "")
  return cleaned === "" ? Number.NaN : Number(cleaned)
}

const booleanValue = (value: unknown, fallback: boolean) => {
  const normalized = text(value).toLowerCase()
  if (!normalized) return fallback
  if (["yes", "true", "1", "y"].includes(normalized)) return true
  if (["no", "false", "0", "n"].includes(normalized)) return false
  return fallback
}

const normalizedRecord = (source: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key.trim().toLowerCase(),
      value,
    ]),
  )

const field = (record: Record<string, unknown>, header: string) =>
  record[header.toLowerCase()]

export function catalogRowsFromRecords(
  records: Record<string, unknown>[],
  customFields: string[],
): CatalogImportResult {
  const rows: CatalogImportRow[] = []
  const errors: CatalogImportError[] = []
  const workbookBarcodes = new Set<string>()

  records.forEach((source, index) => {
    const sourceRow = index + 2
    const record = normalizedRecord(source)
    const discoveredCustomFields = Object.keys(source)
      .map((header) => header.match(/^custom\s*:\s*(.+)$/i)?.[1]?.trim())
      .filter((header): header is string => Boolean(header))
    const rowCustomFields = [...customFields, ...discoveredCustomFields]
      .filter(
        (customField, fieldIndex, fields) =>
          fields.findIndex(
            (candidate) =>
              candidate.toLowerCase() === customField.toLowerCase(),
          ) === fieldIndex,
      )
      .slice(0, 12)
    const name = text(field(record, "Name"))
    const hsnSac = text(field(record, "HSN/SAC"))
    const barcode = text(field(record, "Barcode"))
    const itemTypeValue = text(field(record, "Item Type")).toLowerCase()
    const itemType = itemTypeValue === "service" ? "service" : "product"
    const mrp = numberValue(field(record, "MRP"))
    const gstPercent = numberValue(field(record, "GST %"))
    const stockText = text(field(record, "Stock"))
    const stockQuantity = stockText ? numberValue(field(record, "Stock")) : null
    const discountTypeValue = text(field(record, "Discount Type")).toLowerCase()
    const discountType = ["percent", "fixed"].includes(discountTypeValue)
      ? discountTypeValue as "percent" | "fixed"
      : "none"
    const rawDiscount =
      discountType === "none" ? 0 : numberValue(field(record, "Discount Value"))
    const rowErrors: string[] = []

    if (!name) rowErrors.push("Name is required.")
    if (!hsnSac) rowErrors.push("HSN/SAC is required.")
    if (!Number.isFinite(mrp) || mrp < 0)
      rowErrors.push("MRP must be zero or more.")
    if (!supportedGstRates.has(gstPercent))
      rowErrors.push("GST % must be 0, 5, 12, 18, or 28.")
    if (
      itemTypeValue &&
      itemTypeValue !== "product" &&
      itemTypeValue !== "service"
    )
      rowErrors.push("Item Type must be Product or Service.")
    if (
      stockQuantity != null &&
      (!Number.isFinite(stockQuantity) || stockQuantity < 0)
    )
      rowErrors.push("Stock must be blank or zero or more.")
    if (
      discountTypeValue &&
      !["none", "percent", "fixed"].includes(discountTypeValue)
    )
      rowErrors.push("Discount Type must be None, Percent, or Fixed.")
    if (
      discountType !== "none" &&
      (!Number.isFinite(rawDiscount) || rawDiscount < 0)
    )
      rowErrors.push("Discount Value must be zero or more.")
    if (discountType === "percent" && rawDiscount > 100)
      rowErrors.push("Percentage discount cannot exceed 100.")
    if (barcode && workbookBarcodes.has(barcode))
      rowErrors.push("Barcode is duplicated in this workbook.")
    if (barcode) workbookBarcodes.add(barcode)

    if (rowErrors.length > 0) {
      errors.push({ sourceRow, source, error: rowErrors.join(" ") })
      return
    }

    rows.push({
      sourceRow,
      source,
      item: {
        itemType,
        name,
        brand: text(field(record, "Brand")),
        design: text(field(record, "Design")),
        size: text(field(record, "Size")),
        category: text(field(record, "Category")),
        stockQuantity,
        hsnSac,
        unit: text(field(record, "Unit")) || "unit",
        sku: text(field(record, "SKU")),
        barcode,
        pricePaise: Math.round(mrp * 100),
        gstRateBps: (gstPercent * 100) as GstRateBps,
        priceIncludesTax: booleanValue(
          field(record, "Price Includes Tax"),
          true,
        ),
        discountType,
        discountValue:
          discountType === "fixed"
            ? Math.round(rawDiscount * 100)
            : rawDiscount,
        active: booleanValue(field(record, "Active"), true),
        customValues: Object.fromEntries(
          rowCustomFields.map((customField) => [
            customField,
            text(field(record, `Custom: ${customField}`)),
          ]),
        ),
      },
    })
  })

  return { rows, errors }
}

const workbookCellValue = (value: unknown, textValue: string) => {
  if (value == null) return ""
  if (typeof value === "object") return textValue
  return value
}

const downloadWorkbook = async (workbook: Workbook, fileName: string) => {
  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function parseCatalogWorkbook(
  buffer: ArrayBuffer,
  customFields: string[],
) {
  const workbook = new Workbook()
  await workbook.xlsx.load(buffer as never)
  const worksheet = workbook.getWorksheet("Products") ?? workbook.worksheets[0]
  if (!worksheet) throw new Error("The Excel workbook has no worksheets.")
  const headers: string[] = []
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, column) => {
    headers[column - 1] = cell.text.trim()
  })
  const records: Record<string, unknown>[] = []
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const record = Object.fromEntries(
      headers
        .map((header, index) => {
          const cell = row.getCell(index + 1)
          return [header, workbookCellValue(cell.value, cell.text)] as const
        })
        .filter(([header]) => Boolean(header)),
    )
    if (Object.values(record).some((value) => text(value))) records.push(record)
  })
  if (records.length === 0)
    throw new Error("The Excel workbook has no product rows.")
  if (records.length > MAX_CATALOG_IMPORT_ROWS)
    throw new Error("Import up to 10,000 products at a time.")
  return catalogRowsFromRecords(records, customFields)
}

export async function downloadCatalogTemplate(customFields: string[]) {
  const headers = [
    ...baseHeaders,
    ...customFields.map((field) => `Custom: ${field}`),
  ]
  const workbook = new Workbook()
  const productSheet = workbook.addWorksheet("Products", {
    views: [{ state: "frozen", ySplit: 1 }],
  })
  productSheet.addRow(headers)
  productSheet.getRow(1).font = { bold: true }
  productSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length },
  }
  productSheet.columns.forEach((column, index) => {
    column.width = Math.max(12, Math.min(28, headers[index].length + 2))
  })
  const instructions = [
    ["Catalog bulk import instructions"],
    ["Use the Products sheet and keep the header names unchanged."],
    ["Required columns", "Name, HSN/SAC, MRP, GST %"],
    ["Item Type", "Product or Service; blank defaults to Product"],
    ["GST %", "0, 5, 12, 18, or 28"],
    ["Price Includes Tax / Active", "Yes or No; blank defaults to Yes"],
    ["Discount Type", "None, Percent, or Fixed"],
    ["Discount Value", "Percentage number or fixed rupee amount per unit"],
    ["Stock", "Leave blank when stock is not tracked"],
    ["Barcode", "Format this Excel column as Text to preserve leading zeros"],
    ["Maximum rows", "10,000 products per import"],
  ]
  const instructionSheet = workbook.addWorksheet("Instructions")
  instructions.forEach((row) => instructionSheet.addRow(row))
  instructionSheet.getRow(1).font = { bold: true, size: 14 }
  instructionSheet.getColumn(1).width = 32
  instructionSheet.getColumn(2).width = 64
  await downloadWorkbook(workbook, "perklyn-catalog-template.xlsx")
}

export async function downloadCatalogErrorWorkbook(
  errors: CatalogImportError[],
  originalFileName: string,
) {
  if (errors.length === 0) return
  const sourceHeaders = Array.from(
    new Set(errors.flatMap((item) => Object.keys(item.source))),
  )
  const headers = ["Source Row", ...sourceHeaders, "Error"]
  const workbook = new Workbook()
  const sheet = workbook.addWorksheet("Import errors", {
    views: [{ state: "frozen", ySplit: 1 }],
  })
  sheet.addRow(headers)
  sheet.getRow(1).font = { bold: true }
  errors.forEach((item) =>
    sheet.addRow([
      item.sourceRow,
      ...sourceHeaders.map((header) => item.source[header] ?? ""),
      item.error,
    ]),
  )
  sheet.columns.forEach((column, index) => {
    const header = headers[index]
    column.width =
      header === "Error" ? 60 : Math.max(12, Math.min(28, header.length + 2))
  })
  const baseName = originalFileName.replace(/\.xlsx$/i, "") || "catalog"
  await downloadWorkbook(workbook, `${baseName}-errors.xlsx`)
}
