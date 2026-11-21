export type CatalogPriceFormat = {
  text: string
  currencyKnown: boolean
}

/** Formats a catalog price without guessing an unknown currency. */
export function formatCatalogPrice(
  price: number | null | undefined,
  currency?: string | null,
): CatalogPriceFormat | null
