export function formatCatalogPrice(price, currency) {
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return null;
  const normalizedCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  const supportedCurrencies = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('currency')
    : null;
  const currencyIsKnown = /^[A-Z]{3}$/.test(normalizedCurrency)
    && (!supportedCurrencies || supportedCurrencies.includes(normalizedCurrency));

  if (currencyIsKnown) {
    try {
      return {
        text: new Intl.NumberFormat('fr-FR', {
          style: 'currency',
          currency: normalizedCurrency,
        }).format(price),
        currencyKnown: true,
      };
    } catch {
      // Une devise non prise en charge n'est jamais remplacée par EUR.
    }
  }

  return {
    text: new Intl.NumberFormat('fr-FR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(price),
    currencyKnown: false,
  };
}
