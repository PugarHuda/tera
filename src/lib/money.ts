// Amounts typed in major units (the Pricing Builder, the Migration Planner) -> Stripe's minor units.
export const digits = (currency: string) => new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;

const PLAIN = /^\d+(\.\d+)?$/; // no "0x10", "1e3", "Infinity" or blanks

/** Minor units, or why not: not a plain decimal, or more decimals than the currency has (29.999 USD, 3000.5 JPY). */
export function minorOf(raw: string, currency: string, what: string): number | string {
  const d = digits(currency);
  const s = raw.trim();
  if (d === 0 && /[.,]/.test(s)) return `${what}: ${currency.toUpperCase()} has no minor unit, so the amount cannot have decimals`;
  const minor = Math.round(Number(s) * 10 ** d);
  if (!PLAIN.test(s) || !Number.isFinite(minor) || Math.abs(Number(s) * 10 ** d - minor) > 1e-6) return `${what}: "${raw}" is not a valid ${currency.toUpperCase()} amount`;
  return minor;
}
