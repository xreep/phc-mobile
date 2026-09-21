/**
 * Endpoint configuration tests.
 *
 * `resolveRelayEndpoint` is a validator on a build-time string that nobody type-checks, and
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
 *
 * The variable was renamed from `EXPO_PUBLIC_TWILIO_SOS_URL` to `EXPO_PUBLIC_SOS_RELAY_URL` when
 * the relay stopped being Twilio-only (ADR-007). The old name is still read so a `.env.local`
 * written for the previous build keeps working for one release; the new name wins when both are
 * set.
 */

import {
  CANCEL_WINDOW_MS,
  isRelayConfigured,
  RELAY_TIMEOUT_MS,
  resolveRelayAppKey,
  resolveRelayEndpoint,
  resolveRelayRoute,
} from '@/sos/config';

const NEW_NAME = 'EXPO_PUBLIC_SOS_RELAY_URL';
const OLD_NAME = 'EXPO_PUBLIC_TWILIO_SOS_URL';
const KEY_NAME = 'EXPO_PUBLIC_SOS_RELAY_KEY';

const original = {
  [NEW_NAME]: process.env[NEW_NAME],
  [OLD_NAME]: process.env[OLD_NAME],
  [KEY_NAME]: process.env[KEY_NAME],
};

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  setEnv(NEW_NAME, undefined);
  setEnv(OLD_NAME, undefined);
  setEnv(KEY_NAME, undefined);
});

afterEach(() => {
  for (const [name, value] of Object.entries(original)) setEnv(name, value);
});

describe('resolveRelayEndpoint', () => {
  function withEndpoint(value: string | undefined): string | null {
    setEnv(NEW_NAME, value);
    return resolveRelayEndpoint();
  }

  it('accepts an https URL and returns it trimmed', () => {
    expect(withEndpoint('https://phc-sos-relay.example.workers.dev/sos')).toBe(
      'https://phc-sos-relay.example.workers.dev/sos',
    );
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
    expect(withEndpoint('https://<WORKER_URL>/sos')).toBeNull();
  });

  it('does not reject a legitimate URL that merely contains the word "your"', () => {
    // The guard is on `YOUR_` specifically, not on the word — over-matching here would reject
    // someone's real domain and silently downgrade every alert.
    expect(withEndpoint('https://your-company.twil.io/sos')).toBe(
      'https://your-company.twil.io/sos',
    );
  });

  it('falls back to the legacy EXPO_PUBLIC_TWILIO_SOS_URL for one release', () => {
    // A `.env.local` written for the previous build must keep working: the relay accepts the
    // legacy body too, so nothing about the rename should silently downgrade an install to the
    // composer.
    setEnv(OLD_NAME, 'https://phc-1234.twil.io/sos');
    expect(resolveRelayEndpoint()).toBe('https://phc-1234.twil.io/sos');
  });

  it('prefers the new name when both are set', () => {
    setEnv(OLD_NAME, 'https://old.example/sos');
    setEnv(NEW_NAME, 'https://new.example/sos');
    expect(resolveRelayEndpoint()).toBe('https://new.example/sos');
  });

  it('does not let a blank new name shadow a usable old one', () => {
    setEnv(NEW_NAME, '   ');
    setEnv(OLD_NAME, 'https://old.example/sos');
    expect(resolveRelayEndpoint()).toBe('https://old.example/sos');
  });

  it('does not let an unusable old name rescue an unusable new one', () => {
    setEnv(NEW_NAME, 'http://new.example/sos');
    setEnv(OLD_NAME, 'http://old.example/sos');
    expect(resolveRelayEndpoint()).toBeNull();
  });
});

describe('resolveRelayRoute', () => {
  // The configured URL is the `/sos` endpoint (what the runbook tells people to set). `/health`
  // and `/link` are its siblings on the same Worker, so they are resolved relative to it rather
  // than configured separately — one variable, not three that can disagree.
  it('resolves sibling routes of the configured /sos endpoint', () => {
    expect(resolveRelayRoute('health', 'https://relay.example/sos')).toBe('https://relay.example/health');
    expect(resolveRelayRoute('link', 'https://relay.example/sos')).toBe('https://relay.example/link');
  });

  it('keeps a path prefix in front of /sos', () => {
    expect(resolveRelayRoute('link', 'https://relay.example/v1/sos')).toBe('https://relay.example/v1/link');
  });

  it('tolerates a trailing slash', () => {
    expect(resolveRelayRoute('health', 'https://relay.example/sos/')).toBe('https://relay.example/health');
  });

  it('reads the environment when no endpoint is given', () => {
    setEnv(NEW_NAME, 'https://relay.example/sos');
    expect(resolveRelayRoute('health')).toBe('https://relay.example/health');
  });

  it('returns null when the relay is not configured', () => {
    expect(resolveRelayRoute('health')).toBeNull();
    expect(resolveRelayRoute('health', null)).toBeNull();
  });
});

describe('resolveRelayAppKey', () => {
  it('is null when unset or blank, so no header is sent', () => {
    expect(resolveRelayAppKey()).toBeNull();
    setEnv(KEY_NAME, '   ');
    expect(resolveRelayAppKey()).toBeNull();
  });

  it('returns the key trimmed', () => {
    setEnv(KEY_NAME, '  phc-demo-key  ');
    expect(resolveRelayAppKey()).toBe('phc-demo-key');
  });

  it('treats a placeholder as unset', () => {
    setEnv(KEY_NAME, 'YOUR_RELAY_APP_KEY');
    expect(resolveRelayAppKey()).toBeNull();
  });
});

describe('isRelayConfigured', () => {
  it('agrees with resolveRelayEndpoint', () => {
    setEnv(NEW_NAME, 'https://phc-1234.twil.io/sos');
    expect(isRelayConfigured()).toBe(true);

    setEnv(NEW_NAME, '[YOUR_TWILIO_FUNCTION_URL]');
    expect(isRelayConfigured()).toBe(false);
  });
});

describe('the specified constants', () => {
  it('keeps the cancel window at the PRD’s 30 seconds', () => {
    // PRD §7.2.5 states the number. It is a specification, not a tuning knob, so it gets a
    // test rather than a comment.
    expect(CANCEL_WINDOW_MS).toBe(30_000);
  });

  it('keeps the relay timeout at 10 seconds, which the relay’s own deadline is sized inside', () => {
    // The Worker gives each adapter 3.5 s under an 8 s dispatch deadline *because* the phone
    // allows 10. Shortening this without shortening those turns every slow-but-successful
    // delivery into a composer fallback plus a duplicate text.
    expect(RELAY_TIMEOUT_MS).toBe(10_000);
  });
});
