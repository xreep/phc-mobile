/**
 * Endpoint configuration tests.
 *
 * `resolveTwilioEndpoint` is a validator on a build-time string that nobody type-checks, and
 * both of its failure directions are bad in a specific way:
 *
 * - **Too strict** rejects a working relay, so every alert silently degrades to a composer the
 *   user has to tap — an outcome that looks fine in a demo and is useless for someone unconscious.
 * - **Too permissive** POSTs an emergency payload containing a name and GPS coordinates to
 *   whatever the typo resolved to, over cleartext if the scheme said `http:`.
 *
 * The placeholder guard exists because the brief for this module named the endpoint as
 * `[YOUR_TWILIO_FUNCTION_URL]`, which is exactly the string a half-configured `.env.local` ends
 * up holding — and it is not obviously wrong at a glance in a log line.
 */

import { CANCEL_WINDOW_MS, isTwilioConfigured, resolveTwilioEndpoint } from '@/sos/config';

describe('resolveTwilioEndpoint', () => {
  const original = process.env.EXPO_PUBLIC_TWILIO_SOS_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.EXPO_PUBLIC_TWILIO_SOS_URL;
    else process.env.EXPO_PUBLIC_TWILIO_SOS_URL = original;
  });

  function withEndpoint(value: string | undefined): string | null {
    if (value === undefined) delete process.env.EXPO_PUBLIC_TWILIO_SOS_URL;
    else process.env.EXPO_PUBLIC_TWILIO_SOS_URL = value;
    return resolveTwilioEndpoint();
  }

  it('accepts an https URL and returns it trimmed', () => {
    expect(withEndpoint('https://phc-1234.twil.io/sos')).toBe('https://phc-1234.twil.io/sos');
    expect(withEndpoint('  https://phc-1234.twil.io/sos  ')).toBe('https://phc-1234.twil.io/sos');
  });

  it('rejects http, so an emergency payload cannot go out in cleartext', () => {
    // The body carries a name, vitals, and GPS coordinates. This is the one request in the app
    // where a downgrade to plaintext is a privacy incident rather than an inconvenience.
    expect(withEndpoint('http://phc-1234.twil.io/sos')).toBeNull();
  });

  it('rejects other schemes', () => {
    expect(withEndpoint('ftp://example.com/sos')).toBeNull();
    expect(withEndpoint('file:///tmp/sos')).toBeNull();
  });

  it('treats the unset and blank cases as unconfigured rather than as an error', () => {
    expect(withEndpoint(undefined)).toBeNull();
    expect(withEndpoint('')).toBeNull();
    expect(withEndpoint('   ')).toBeNull();
  });

  it('rejects a malformed value instead of POSTing to it', () => {
    expect(withEndpoint('not a url')).toBeNull();
    expect(withEndpoint('phc-1234.twil.io/sos')).toBeNull(); // no scheme
  });

  it('rejects the placeholder shapes a half-configured env file holds', () => {
    // Both spellings of "I copied the template and never filled it in".
    expect(withEndpoint('[YOUR_TWILIO_FUNCTION_URL]')).toBeNull();
    expect(withEndpoint('YOUR_TWILIO_FUNCTION_URL')).toBeNull();
    // And the more insidious one: a real-looking URL with the placeholder still inside it,
    // which *does* parse as https and would otherwise be accepted.
    expect(withEndpoint('https://YOUR_SUBDOMAIN.twil.io/sos')).toBeNull();
  });

  it('does not reject a legitimate URL that merely contains the word "your"', () => {
    // The guard is on `YOUR_` specifically, not on the word — over-matching here would reject
    // someone's real domain and silently downgrade every alert.
    expect(withEndpoint('https://your-company.twil.io/sos')).toBe(
      'https://your-company.twil.io/sos',
    );
  });
});

describe('isTwilioConfigured', () => {
  const original = process.env.EXPO_PUBLIC_TWILIO_SOS_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.EXPO_PUBLIC_TWILIO_SOS_URL;
    else process.env.EXPO_PUBLIC_TWILIO_SOS_URL = original;
  });

  it('agrees with resolveTwilioEndpoint', () => {
    process.env.EXPO_PUBLIC_TWILIO_SOS_URL = 'https://phc-1234.twil.io/sos';
    expect(isTwilioConfigured()).toBe(true);

    process.env.EXPO_PUBLIC_TWILIO_SOS_URL = '[YOUR_TWILIO_FUNCTION_URL]';
    expect(isTwilioConfigured()).toBe(false);
  });
});

describe('the specified constants', () => {
  it('keeps the cancel window at the PRD’s 30 seconds', () => {
    // PRD §7.2.5 states the number. It is a specification, not a tuning knob, so it gets a
    // test rather than a comment.
    expect(CANCEL_WINDOW_MS).toBe(30_000);
  });
});
