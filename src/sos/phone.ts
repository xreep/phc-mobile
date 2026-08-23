/**
 * Phone-number normalization for the SOS paths (PRD §7.2.5).
 *
 * Both delivery paths need E.164 (`+919876543210`): the Twilio REST API rejects anything
 * else outright, and `sms:` URIs are only reliably routed by the platform dialer when the
 * number carries its country code. Users type numbers with spaces, dashes, and brackets, so
 * one normalizer sits at the store boundary and everything downstream can assume E.164.
 *
 * ## Why a bare 10-digit number is rejected rather than assumed
 * The app targets India (PRD §2), so `+91` would be the obvious default to prepend — and
 * that is exactly the assumption worth refusing to make. A wrong country code does not
 * degrade gracefully: it silently routes an emergency to a stranger in another country, and
 * the failure only surfaces when it matters. Requiring an explicit `+<country code>` costs
 * the user four keystrokes once, and the Settings field says so inline.
 */

/**
 * E.164 allows at most 15 digits including the country code, and no real number is shorter
 * than 8 with one. The leading digit cannot be 0 — that is a trunk prefix, not a country.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Every character E.164 forbids but humans type anyway. */
const SEPARATORS = /[\s\-().]/g;

/**
 * Strip formatting and canonicalize the international prefix.
 *
 * Returns null when the result is not a valid E.164 number, which the caller must treat as
 * "unusable for SOS" rather than storing it anyway. `00` is accepted as a synonym for `+`
 * because it is how the prefix is dialled across most of Europe and Asia and users
 * reasonably type it.
 */
export function normalizePhone(input: string): string | null {
  if (typeof input !== 'string') return null;

  const stripped = input.replace(SEPARATORS, '');
  if (stripped.length === 0) return null;

  // `00…` → `+…`. Done before validation so both spellings converge on one stored form.
  const canonical = stripped.startsWith('00') ? `+${stripped.slice(2)}` : stripped;

  if (!E164.test(canonical)) return null;
  return canonical;
}

/** Whether a string is already storable. Thin wrapper, but it reads better at call sites. */
export function isValidPhone(input: string): boolean {
  return normalizePhone(input) !== null;
}

/**
 * Group an E.164 number for display: `+919876543210` → `+91 98765 43210`.
 *
 * Presentation only — never store or transmit this form. The grouping is deliberately
 * generic (country code, then even chunks) rather than per-country: a wrong-but-consistent
 * grouping is a cosmetic issue, whereas carrying a table of national numbering plans is a
 * maintenance burden that buys nothing for an emergency contact list.
 */
export function formatPhoneForDisplay(phone: string): string {
  const normalized = normalizePhone(phone);
  if (normalized === null) return phone;

  // Longest-first so `+91` wins over `+9`. Only the country codes the app is likely to see
  // are listed; anything else falls through to a 2-digit assumption, which is cosmetic.
  const countryCodeLength = ['+91', '+1', '+44', '+61', '+65', '+971'].reduce(
    (length, code) => (normalized.startsWith(code) ? code.length - 1 : length),
    2,
  );

  const country = normalized.slice(0, countryCodeLength + 1);
  const rest = normalized.slice(countryCodeLength + 1);
  if (rest.length === 0) return country;

  // Split into 5s from the left, which suits the 10-digit national numbers this app mostly
  // sees and stays readable for anything else.
  const groups = rest.match(/.{1,5}/g) ?? [rest];
  return `${country} ${groups.join(' ')}`;
}
