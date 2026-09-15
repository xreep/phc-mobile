/**
 * Delivery orchestration tests.
 *
 * This is where the escalation's judgement calls live, and each one is a case where the obvious
 * implementation is wrong in a way no user would report:
 *
 * - **Fallback is per-contact.** A relay that is up but rejects one bad number must not push the
 *   whole list into a composer — the contacts it already texted would be texted a second time,
 *   and duplicate emergency messages are their own harm.
 * - **`cancelled` is not pending.** The user saw the composer and dismissed it. Nothing is
 *   waiting for them, so a "waiting for you to press send" banner would be false.
 * - **`failed` means nothing got out.** A composer that opened counts as progress, because the
 *   user can still complete it. Calling that failed would send them looking for a second way to
 *   raise the alarm while the first sits on screen, one tap from done.
 * - **The relay runs concurrently.** Three unreachable contacts at a 10-second timeout each is
 *   30 seconds before the composer opens, on top of the 30-second cancel window already spent.
 */

import { dispatchSos } from '@/sos/deliver';
import type { EmergencyContact, SosContext } from '@/sos/types';

const NOW = 1_766_000_000_000;

const CONTACTS: readonly EmergencyContact[] = [
  { id: 'c1', name: 'Meera', relation: 'Sister', phone: '+919876543210' },
  { id: 'c2', name: 'Ravi', relation: 'Neighbour', phone: '+919123456780' },
];

const CONTEXT: SosContext = {
  criticalRules: ['respiratory.spo2.critical'],
  level: 'red',
  vitals: { hr: 132, spo2: 84 },
  location: {
    ok: true,
    location: { latitude: 13.0827, longitude: 80.2707, accuracyM: 12, timestamp: NOW },
  },
  userName: 'Asha',
  now: NOW,
  manual: false,
};

/** A `fetch` that succeeds or fails per phone number, so partial-failure cases are expressible. */
function relay(outcome: (to: string) => 'ok' | number | 'network') {
  return jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { to } = JSON.parse(String(init?.body)) as { to: string };
    const verdict = outcome(to);
    if (verdict === 'network') throw new TypeError('Network request failed');
    if (verdict === 'ok') return { ok: true, status: 200 } as Response;
    return { ok: false, status: verdict } as Response;
  }) as unknown as typeof fetch;
}

function sms(overrides: { available?: boolean; result?: string } = {}) {
  const { available = true, result = 'sent' } = overrides;
  return {
    isAvailableAsync: jest.fn(() => Promise.resolve(available)),
    sendSMSAsync: jest.fn(() => Promise.resolve({ result })),
  };
}

const ENDPOINT = 'https://phc-1234.twil.io/sos';

describe('dispatchSos — the relay reaches everyone', () => {
  it('reports sent, with no composer opened', async () => {
    const fetchImpl = relay(() => 'ok');
    const smsImpl = sms();

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      twilio: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl },
    });

    expect(result.twilioSent).toEqual(['c1', 'c2']);
    expect(result.nativeSmsPending).toBe(false);
    expect(result.failed).toBe(false);
    expect(smsImpl.sendSMSAsync).not.toHaveBeenCalled();
    expect(result.attempts).toEqual([
      { contactId: 'c1', phone: '+919876543210', channel: 'twilio', ok: true, error: undefined },
      { contactId: 'c2', phone: '+919123456780', channel: 'twilio', ok: true, error: undefined },
    ]);
  });

  it('sends one identical message to every contact', async () => {
    // Not personalised on purpose: the content is identical by nature, and per-contact variants
    // would multiply the ways a bug could produce a *different* emergency message for one
    // recipient than another.
    const fetchImpl = relay(() => 'ok');

    const result = await dispatchSos(CONTACTS, CONTEXT, { twilio: { endpoint: ENDPOINT, fetchImpl } });

    const bodies = (fetchImpl as jest.Mock).mock.calls.map(
      (call) => (JSON.parse(String(call[1]?.body)) as { message: string }).message,
    );
    expect(bodies).toEqual([result.message, result.message]);
    expect(result.message).toContain('PHC EMERGENCY - Asha needs help.');
  });

  it('dispatches concurrently rather than one contact at a time', async () => {
    // Both requests must be in flight together. Sequentially, an unreachable list costs the
    // full relay timeout per contact before the fallback composer even opens.
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = jest.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    await dispatchSos(CONTACTS, CONTEXT, { twilio: { endpoint: ENDPOINT, fetchImpl } });

    expect(peak).toBe(2);
  });
});

describe('dispatchSos — partial relay failure', () => {
  it('falls back for only the contact it could not reach', async () => {
    const fetchImpl = relay((to) => (to === '+919876543210' ? 'ok' : 500));
    const smsImpl = sms();

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      twilio: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl },
    });

    expect(result.twilioSent).toEqual(['c1']);
    // The composer is addressed to c2 alone. Including c1 would text them twice.
    expect(smsImpl.sendSMSAsync).toHaveBeenCalledTimes(1);
    expect(smsImpl.sendSMSAsync).toHaveBeenCalledWith(['+919123456780'], result.message);
    expect(result.nativeSmsPending).toBe(true);
    expect(result.failed).toBe(false);
  });

  it('records a row per contact per channel, so the UI can show a complete picture', async () => {
    const fetchImpl = relay((to) => (to === '+919876543210' ? 'ok' : 500));

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      twilio: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl: sms() },
    });

    expect(result.attempts).toEqual([
      { contactId: 'c1', phone: '+919876543210', channel: 'twilio', ok: true, error: undefined },
      {
        contactId: 'c2',
        phone: '+919123456780',
        channel: 'twilio',
        ok: false,
        error: 'The SOS relay failed (500).',
      },
      { contactId: 'c2', phone: '+919123456780', channel: 'native_sms', ok: true, error: undefined },
    ]);
  });
});

describe('dispatchSos — the relay reaches nobody', () => {
  it('rolls the whole list into one composer', async () => {
    const fetchImpl = relay(() => 'network');
    const smsImpl = sms();

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      twilio: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl },
    });

    expect(result.twilioSent).toEqual([]);
    expect(smsImpl.sendSMSAsync).toHaveBeenCalledTimes(1);
    expect(smsImpl.sendSMSAsync).toHaveBeenCalledWith(
      ['+919876543210', '+919123456780'],
      result.message,
    );
    expect(result.nativeSmsPending).toBe(true);
    expect(result.failed).toBe(false);
  });

  it('falls back when no relay is configured, without waiting for a timeout', async () => {
    // The unconfigured build. This is why a missing `EXPO_PUBLIC_TWILIO_SOS_URL` is a
    // degradation and not an outage: the alert still reaches a composer.
    const smsImpl = sms();

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      twilio: { endpoint: null },
      sms: { smsImpl },
    });

    expect(result.nativeSmsPending).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.attempts.filter((a) => a.channel === 'twilio')).toHaveLength(2);
    expect(result.attempts[0].error).toContain('No SOS relay configured');
  });

  it('fails only when the composer could not open either', async () => {
    const result = await dispatchSos(CONTACTS, CONTEXT, {
      twilio: { endpoint: null },
      sms: { smsImpl: sms({ available: false }) },
    });

    expect(result.failed).toBe(true);
    expect(result.nativeSmsPending).toBe(false);
    expect(result.attempts.filter((a) => a.channel === 'native_sms')).toEqual([
      {
        contactId: 'c1',
        phone: '+919876543210',
        channel: 'native_sms',
        ok: false,
        error: 'This device cannot send SMS.',
      },
      {
        contactId: 'c2',
        phone: '+919123456780',
        channel: 'native_sms',
        ok: false,
        error: 'This device cannot send SMS.',
      },
    ]);
  });
});

describe('dispatchSos — skipTwilio', () => {
  it('goes straight to the composer without touching the network', async () => {
    // PRD §7.2.5's "no connectivity" branch. The caller already knows the network is down;
    // spending 10 seconds of an emergency re-proving it is the cost this avoids.
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const smsImpl = sms();

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      skipTwilio: true,
      twilio: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(smsImpl.sendSMSAsync).toHaveBeenCalledWith(
      ['+919876543210', '+919123456780'],
      result.message,
    );
    // No twilio rows at all — the path was not attempted, which is different from having failed.
    expect(result.attempts.every((a) => a.channel === 'native_sms')).toBe(true);
    expect(result.nativeSmsPending).toBe(true);
  });
});

describe('dispatchSos — composer outcomes', () => {
  it('does not report pending when the user dismissed the composer', async () => {
    const result = await dispatchSos(CONTACTS, CONTEXT, {
      twilio: { endpoint: null },
      sms: { smsImpl: sms({ result: 'cancelled' }) },
    });

    expect(result.nativeSmsPending).toBe(false);
    // Recorded as an `ok` attempt, though: the composer did open. The user made a choice, and
    // that is not a delivery failure to escalate.
    expect(result.attempts.filter((a) => a.channel === 'native_sms').every((a) => a.ok)).toBe(true);
    // But with nothing sent and nothing pending, the dispatch as a whole achieved nothing.
    expect(result.failed).toBe(true);
  });

  it('reports pending on an unknown outcome, because iOS often declines to say', async () => {
    const result = await dispatchSos(CONTACTS, CONTEXT, {
      twilio: { endpoint: null },
      sms: { smsImpl: sms({ result: 'unknown' }) },
    });

    expect(result.nativeSmsPending).toBe(true);
  });

  it('still reports pending when the relay reached some contacts', async () => {
    // Pending outranks sent in the UI for a reason — the honest headline is the thing that
    // still needs the user. Both facts are kept here so the modal can say both.
    const fetchImpl = relay((to) => (to === '+919876543210' ? 'ok' : 'network'));

    const result = await dispatchSos(CONTACTS, CONTEXT, {
      twilio: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl: sms() },
    });

    expect(result.twilioSent).toEqual(['c1']);
    expect(result.nativeSmsPending).toBe(true);
  });
});

describe('dispatchSos — degenerate input', () => {
  it('fails with a composed message when there are no contacts', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const smsImpl = sms();

    const result = await dispatchSos([], CONTEXT, {
      twilio: { endpoint: ENDPOINT, fetchImpl },
      sms: { smsImpl },
    });

    expect(result.failed).toBe(true);
    expect(result.attempts).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(smsImpl.sendSMSAsync).not.toHaveBeenCalled();
    // The message is still composed. The machine refuses this case before it gets here, but a
    // result with an empty `message` would render a blank "what was sent" disclosure if it ever
    // did — and an empty string is indistinguishable from a composition bug.
    expect(result.message).toContain('PHC EMERGENCY');
  });

  it('sends an alert with no coordinates rather than no alert', async () => {
    // The property the whole location layer is built around: a failed fix degrades the message,
    // it does not abort the dispatch.
    const fetchImpl = relay(() => 'ok');

    const result = await dispatchSos(
      CONTACTS,
      { ...CONTEXT, location: { ok: false, reason: 'timeout' } },
      { twilio: { endpoint: ENDPOINT, fetchImpl } },
    );

    expect(result.twilioSent).toEqual(['c1', 'c2']);
    expect(result.message).toContain('Location: unavailable (no GPS fix in time)');
  });

  it('never throws, even when both channels blow up', async () => {
    const fetchImpl = jest.fn(() => {
      throw new Error('boom');
    }) as unknown as typeof fetch;

    await expect(
      dispatchSos(CONTACTS, CONTEXT, {
        twilio: { endpoint: ENDPOINT, fetchImpl },
        sms: {
          smsImpl: {
            isAvailableAsync: () => Promise.reject(new Error('boom')),
            sendSMSAsync: () => Promise.reject(new Error('boom')),
          },
        },
      }),
    ).resolves.toMatchObject({ failed: true });
  });
});
