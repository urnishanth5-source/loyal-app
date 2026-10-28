import { describe, expect, it } from "vitest"
import { Workbook } from "exceljs"
import {
  MAX_CATALOG_IMPORT_ROWS,
  catalogRowsFromRecords,
  parseCatalogWorkbook,
} from "./catalogExcel"

describe("catalog Excel import", () => {
  it("supports up to 10,000 rows per workbook", () => {
    expect(MAX_CATALOG_IMPORT_ROWS).toBe(10000)
  })

  it("converts Excel values into catalog items", () => {
    const result = catalogRowsFromRecords(
      [
        {
          Name: "Cotton Shirt",
          "Item Type": "Product",
          Stock: 12,
          "HSN/SAC": "6205",
          Unit: "piece",
          Barcode: "0012345",
          MRP: 999,
          "GST %": 5,
          "Price Includes Tax": "Yes",
          "Discount Type": "Fixed",
          "Discount Value": 100,
          Active: "Yes",
          "Custom: Season": "Summer",
        },
      ],
      [],
    )

    expect(result.errors).toEqual([])
    expect(result.rows[0].item).toMatchObject({
      name: "Cotton Shirt",
      barcode: "0012345",
      pricePaise: 99900,
      gstRateBps: 500,
      discountType: "fixed",
      discountValue: 10000,
      stockQuantity: 12,
      customValues: { Season: "Summer" },
    })
  })

  it("allows duplicate product names", () => {
    const result = catalogRowsFromRecords(
      [
        { Name: "Shirt", "HSN/SAC": "6205", MRP: 500, "GST %": 5 },
        { Name: "Shirt", "HSN/SAC": "6205", MRP: 700, "GST %": 5 },
      ],
      [],
    )
    expect(result.rows).toHaveLength(2)
    expect(result.errors).toEqual([])
  })

  it("rejects duplicate barcodes within the workbook", () => {
    const result = catalogRowsFromRecords(
      [
        {
          Name: "Shirt A",
          "HSN/SAC": "6205",
          MRP: 500,
          "GST %": 5,
          Barcode: "123",
        },
        {
          Name: "Shirt B",
          "HSN/SAC": "6205",
          MRP: 700,
          "GST %": 5,
          Barcode: "123",
        },
      ],
      [],
    )
    expect(result.rows).toHaveLength(1)
    expect(result.errors[0].error).toContain(
      "Barcode is duplicated in this workbook.",
    )
  })

  it("parses a real xlsx Products worksheet", async () => {
    const workbook = new Workbook()
    const worksheet = workbook.addWorksheet("Products")
    worksheet.addRow(["Name", "HSN/SAC", "MRP", "GST %", "Barcode"])
    worksheet.addRow(["Linen Shirt", "6205", 1299, 12, "000987"])
    const buffer = await workbook.xlsx.writeBuffer()

    const result = await parseCatalogWorkbook(
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer,
      [],
    )

    expect(result.errors).toEqual([])
    expect(result.rows[0].item).toMatchObject({
      name: "Linen Shirt",
      barcode: "000987",
      pricePaise: 129900,
      gstRateBps: 1200,
    })
  })
})
