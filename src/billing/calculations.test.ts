import { describe, expect, it } from "vitest"
import { calculateBillingTotals } from "./calculations"
import type { CartLine } from "./types"

const line = (patch: Partial<CartLine> = {}): CartLine => ({
  id: "line-1",
  itemType: "product",
  name: "Test item",
  hsnSac: "1234",
  unit: "unit",
  quantity: 1,
  unitPricePaise: 11800,
  gstRateBps: 1800,
  priceIncludesTax: true,
  lineDiscountPaise: 0,
  ...patch,
})

describe("billing calculations", () => {
  it("extracts inclusive GST and splits intrastate tax", () => {
    const totals = calculateBillingTotals([line()], 0, "33", "33")
    expect(totals.taxablePaise).toBe(10000)
    expect(totals.cgstPaise).toBe(900)
    expect(totals.sgstPaise).toBe(900)
    expect(totals.igstPaise).toBe(0)
    expect(totals.totalPaise).toBe(11800)
  })

  it("adds exclusive GST and uses IGST for interstate sales", () => {
    const totals = calculateBillingTotals(
      [line({ unitPricePaise: 10000, priceIncludesTax: false })],
      0,
      "33",
      "29",
    )
    expect(totals.taxablePaise).toBe(10000)
    expect(totals.igstPaise).toBe(1800)
    expect(totals.totalPaise).toBe(11800)
  })

  it("allocates a cart discount exactly across multiple lines", () => {
    const totals = calculateBillingTotals(
      [
        line({ id: "a", unitPricePaise: 10000, gstRateBps: 0 }),
        line({ id: "b", unitPricePaise: 20000, gstRateBps: 0 }),
      ],
      1001,
      "33",
      "33",
    )
    expect(
      totals.lines.reduce(
        (sum, item) => sum + item.allocatedCartDiscountPaise,
        0,
      ),
    ).toBe(1001)
    expect(totals.totalPaise).toBe(28999)
  })

  it("supports three-decimal quantities and clamps excessive discounts", () => {
    const totals = calculateBillingTotals(
      [
        line({
          quantity: 1.25,
          unitPricePaise: 8000,
          gstRateBps: 0,
          lineDiscountPaise: 20000,
        }),
      ],
      5000,
      "33",
      "33",
    )
    expect(totals.subtotalPaise).toBe(10000)
    expect(totals.lineDiscountPaise).toBe(10000)
    expect(totals.totalPaise).toBe(0)
  })
})
