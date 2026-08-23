/**
 * Phone normalization tests.
 *
 * The property under guard is not "does it parse Indian numbers" but **it must never invent a
 * country code**. `normalizePhone` sits at the only boundary where a typo becomes a real
 * stranger's phone number, and the one dangerous failure mode is the permissive one: accepting
 * something it should have rejected, storing it, and surfacing the mistake during an emergency.
 * So the rejection cases carry more weight here than the acceptance cases.
 */

import { formatPhoneForDisplay, isValidPhone, normalizePhone } from '@/sos/phone';

describe('normalizePhone', () => {
  it('strips the separators humans type', () => {
    for (const input of [
      '+91 98765 43210',
      '+91-98765-43210',
      '+91 (98765) 43210',
      '+91.98765.43210',
      '  +919876543210  ',
    ]) {
      expect(normalizePhone(input)).toBe('+919876543210');
    }
  });

  it('accepts 00 as a synonym for +, so both spellings converge on one stored form', () => {
    expect(normalizePhone('00919876543210')).toBe('+919876543210');
    expect(normalizePhone('00 91 98765 43210')).toBe('+919876543210');
  });

  it('rejects a bare national number rather than assuming +91', () => {
    // The whole point of the module. Prepending a country code here would produce a valid,
    // storable, sendable number that belongs to someone else.
    expect(normalizePhone('9876543210')).toBeNull();
    expect(normalizePhone('098765 43210')).toBeNull();
  });

  it('rejects a leading zero after the plus, which is a trunk prefix and not a country', () => {
    expect(normalizePhone('+0919876543210')).toBeNull();
  });

  it('rejects numbers outside E.164 length bounds', () => {
    expect(normalizePhone('+9112345')).toBeNull(); // 7 digits total
    expect(normalizePhone('+911234567')).toBe('+911234567'); // 9 digits, minimum accepted
    expect(normalizePhone('+911234567890123')).toBe('+911234567890123'); // 15 digits, the max
    expect(normalizePhone('+9112345678901234')).toBeNull(); // 16, over
  });

  it('rejects letters, empty input, and separator-only input', () => {
    expect(normalizePhone('+91 98765 4321O')).toBeNull(); // capital O, not zero
    expect(normalizePhone('call mum')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
    expect(normalizePhone('---')).toBeNull();
  });

  it('rejects an extension, which no SMS path can dial', () => {
    expect(normalizePhone('+919876543210 x22')).toBeNull();
  });

  it('survives a non-string, because persisted JSON is not typed', () => {
    // `settings/store.ts` re-normalizes whatever was on disk. A previous build's shape, or a
    // hand-edited blob, can put anything here and this must not throw.
    expect(normalizePhone(undefined as unknown as string)).toBeNull();
    expect(normalizePhone(null as unknown as string)).toBeNull();
    expect(normalizePhone(919876543210 as unknown as string)).toBeNull();
  });
});

describe('isValidPhone', () => {
  it('agrees with normalizePhone', () => {
    expect(isValidPhone('+91 98765 43210')).toBe(true);
    expect(isValidPhone('9876543210')).toBe(false);
  });
});

describe('formatPhoneForDisplay', () => {
  it('groups the national part after the country code', () => {
    expect(formatPhoneForDisplay('+919876543210')).toBe('+91 98765 43210');
  });

  it('prefers the longest matching country code', () => {
    // `+971` must not be read as a 2-digit `+97`.
    expect(formatPhoneForDisplay('+971501234567')).toBe('+971 50123 4567');
  });

  it('returns unparseable input untouched rather than mangling it', () => {
    // Display-only, so it must be safe on anything — including a value the store already
    // rejected and is showing back to the user.
    expect(formatPhoneForDisplay('not a number')).toBe('not a number');
  });
});
