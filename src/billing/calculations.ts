import type {
  BillingTotals,
  CalculatedLine,
  CartLine,
} from "./types"

const clampMoney = (value: number) =>
  Math.max(0, Math.round(Number.isFinite(value) ? value : 0))

const splitTax = (taxPaise: number, interstate: boolean) =>
  interstate
    ? { cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise }
    : {
        cgstPaise: Math.floor(taxPaise / 2),
        sgstPaise: taxPaise - Math.floor(taxPaise / 2),
        igstPaise: 0,
      }

export function calculateBillingTotals(
  inputLines: CartLine[],
  cartDiscountPaise: number,
  sellerStateCode: string,
  placeOfSupplyCode: string,
): BillingTotals {
  const lines = inputLines.filter(
    (line) =>
      line.name.trim() &&
      line.quantity > 0 &&
      line.unitPricePaise >= 0,
  )
  const bases = lines.map((line) => {
    const grossBeforeDiscountPaise = clampMoney(
      line.unitPricePaise * line.quantity,
    )
    const lineDiscountPaise = Math.min(
      clampMoney(line.lineDiscountPaise),
      grossBeforeDiscountPaise,
    )
    return {
      grossBeforeDiscountPaise,
      lineDiscountPaise,
      netPaise: grossBeforeDiscountPaise - lineDiscountPaise,
    }
  })
  const netTotal = bases.reduce((sum, line) => sum + line.netPaise, 0)
  const appliedCartDiscount = Math.min(
    clampMoney(cartDiscountPaise),
    netTotal,
  )
  const allocations = bases.map((line) =>
    netTotal
      ? Math.floor((appliedCartDiscount * line.netPaise) / netTotal)
      : 0,
  )
  let remainder =
    appliedCartDiscount - allocations.reduce((sum, value) => sum + value, 0)
  const allocationOrder = bases
    .map((line, index) => ({
      index,
      fraction: netTotal
        ? (appliedCartDiscount * line.netPaise) % netTotal
        : 0,
    }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (const item of allocationOrder) {
    if (remainder <= 0) break
    allocations[item.index] += 1
    remainder -= 1
  }

  const interstate =
    Boolean(sellerStateCode) &&
    Boolean(placeOfSupplyCode) &&
    sellerStateCode !== placeOfSupplyCode
  const calculatedLines: CalculatedLine[] = lines.map((line, index) => {
    const base = bases[index]
    const allocatedCartDiscountPaise = allocations[index]
    const discountedPaise = Math.max(
      0,
      base.netPaise - allocatedCartDiscountPaise,
    )
    let taxablePaise: number
    let taxPaise: number
    if (line.priceIncludesTax) {
      taxablePaise = Math.round(
        (discountedPaise * 10000) / (10000 + line.gstRateBps),
      )
      taxPaise = discountedPaise - taxablePaise
    } else {
      taxablePaise = discountedPaise
      taxPaise = Math.round((taxablePaise * line.gstRateBps) / 10000)
    }
    const taxes = splitTax(taxPaise, interstate)
    return {
      ...line,
      lineNumber: index + 1,
      lineDiscountPaise: base.lineDiscountPaise,
      grossBeforeDiscountPaise: base.grossBeforeDiscountPaise,
      allocatedCartDiscountPaise,
      taxablePaise,
      ...taxes,
      totalPaise:
        taxablePaise +
        taxes.cgstPaise +
        taxes.sgstPaise +
        taxes.igstPaise,
    }
  })

  return {
    lines: calculatedLines,
    subtotalPaise: bases.reduce(
      (sum, line) => sum + line.grossBeforeDiscountPaise,
      0,
    ),
    lineDiscountPaise: bases.reduce(
      (sum, line) => sum + line.lineDiscountPaise,
      0,
    ),
    cartDiscountPaise: appliedCartDiscount,
    taxablePaise: calculatedLines.reduce(
      (sum, line) => sum + line.taxablePaise,
      0,
    ),
    cgstPaise: calculatedLines.reduce(
      (sum, line) => sum + line.cgstPaise,
      0,
    ),
    sgstPaise: calculatedLines.reduce(
      (sum, line) => sum + line.sgstPaise,
      0,
    ),
    igstPaise: calculatedLines.reduce(
      (sum, line) => sum + line.igstPaise,
      0,
    ),
    totalPaise: calculatedLines.reduce(
      (sum, line) => sum + line.totalPaise,
      0,
    ),
  }
}

export const formatInr = (paise: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
  }).format(paise / 100)

export const rupeesToPaise = (value: string | number) =>
  clampMoney(Number(value) * 100)
