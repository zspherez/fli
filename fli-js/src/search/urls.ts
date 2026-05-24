/**
 * URL helpers for the FlightsFrontendService RPCs.
 * 1:1 port of fli/search/_urls.py.
 */

/**
 * Append optional `curr`/`hl`/`gl` parameters to a URL.
 *
 * - `currency` is uppercased ("usd" → "USD") because Google rejects lowercase
 *   codes silently.
 * - `language` is passed through verbatim (BCP-47).
 * - `country` is uppercased (ISO 3166-1 alpha-2).
 *
 * All values are percent-encoded; returns `url` unchanged when all three are null.
 */
export function withLocaleParams(
  url: string,
  currency: string | null | undefined,
  language: string | null | undefined,
  country: string | null | undefined,
): string {
  const params: string[] = [];
  if (currency) params.push(`curr=${encodeURIComponent(currency.toUpperCase())}`);
  if (language) params.push(`hl=${encodeURIComponent(language)}`);
  if (country) params.push(`gl=${encodeURIComponent(country.toUpperCase())}`);
  if (params.length === 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${params.join("&")}`;
}
