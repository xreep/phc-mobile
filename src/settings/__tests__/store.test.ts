/**
 * Persisted settings tests.
 *
 * The store is a schema boundary: everything it reads was written by a *previous build* of the
 * app, and there is no type system across that gap. `src/environment/cache.ts` already records
 * the failure this guards — a field rename turning into `undefined.toFixed()` for every existing
 * install while every test passes on the new schema — and the stakes here are higher, because
 * the blob holds the emergency contact list. A contact list that deserialises into
 * `[{ phone: undefined }]` makes SOS silently unable to reach anyone, and nothing on screen
 * would say so.
 *
 * So the read path is tested against hostile input rather than against what the write path
 * produces. Round-tripping our own output would prove only that `JSON.parse(JSON.stringify(x))`
 * works.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { DATA_SHARING_PREFS } from '@/constants/health-data';
import {
  clearSettings,
  DEFAULT_SETTINGS,
  isSosEnabled,
  readSettings,
  removeContact,
  SETTINGS_KEY,
  setSharingPref,
  upsertContact,
  writeSettings,
  type PersistedSettings,
} from '@/settings/store';
import type { EmergencyContact } from '@/sos/types';

const MEERA: EmergencyContact = {
  id: 'c1',
  name: 'Meera',
  relation: 'Sister',
  phone: '+919876543210',
};

const RAVI: EmergencyContact = {
  id: 'c2',
  name: 'Ravi',
  relation: 'Neighbour',
  phone: '+919123456780',
};

/** Write a raw blob under the real key, the way an older build would have left it. */
async function seed(raw: string): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, raw);
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

describe('the storage key', () => {
  it('carries a schema version', () => {
    // A rename without a version bump makes an old blob deserialise into a half-populated
    // object; with one, it simply misses and the user gets documented defaults.
    expect(SETTINGS_KEY).toMatch(/\.v\d+$/);
  });
});

describe('defaults', () => {
  it('start with no contacts, so a demo tap cannot text a stranger', async () => {
    // The retired `EMERGENCY_CONTACTS` array held two realistic Indian numbers. `+91 98765
    // 43210` normalizes to structurally valid E.164, so no validation layer downstream would
    // have stopped a first press from reaching whoever owns it.
    await expect(readSettings()).resolves.toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.contacts).toEqual([]);
  });

  it('enable the SOS opt-in and nothing else', () => {
    // PRD §7.2.4/§7.2.6: everything off by default except SOS. Derived from the pref list so
    // adding a pref that defaults on has to change the declaration, not just this expectation.
    expect(DEFAULT_SETTINGS.sharing).toEqual(
      Object.fromEntries(DATA_SHARING_PREFS.map((p) => [p.key, p.defaultOn])),
    );
    expect(isSosEnabled(DEFAULT_SETTINGS)).toBe(true);
    expect(DEFAULT_SETTINGS.sharing.anon_aggregate).toBe(false);
    expect(DEFAULT_SETTINGS.sharing.cloud_backup).toBe(false);
    expect(DEFAULT_SETTINGS.sharing.family_share).toBe(false);
  });
});

describe('readSettings — validating what a previous build left behind', () => {
  it('round-trips a well-formed blob', async () => {
    const settings: PersistedSettings = {
      contacts: [MEERA, RAVI],
      userName: 'Asha',
      sharing: { sos: true, anon_aggregate: true, cloud_backup: false, family_share: false },
      sensorSource: 'ble_esp32',
    };

    expect(await writeSettings(settings)).toBe(true);
    await expect(readSettings()).resolves.toEqual(settings);
  });

  it('drops a contact whose number cannot reach anyone, keeping the rest', async () => {
    // The central case. A bare national number, a blank, and a missing field each become a
    // contact the relay would reject — visible in the UI as a missing row, which someone can
    // act on, rather than invisible as a failing send.
    await seed(
      JSON.stringify({
        contacts: [
          MEERA,
          { id: 'bad1', name: 'No code', relation: '', phone: '9876543210' },
          { id: 'bad2', name: 'Blank', relation: '', phone: '' },
          { id: 'bad3', name: 'Missing phone', relation: '' },
          RAVI,
        ],
      }),
    );

    const settings = await readSettings();

    expect(settings.contacts).toEqual([MEERA, RAVI]);
  });

  it('re-normalizes a loosely stored number rather than trusting it', async () => {
    // An earlier build may have stored numbers as typed. Trusting that would hand the relay a
    // string with spaces in it.
    await seed(
      JSON.stringify({
        contacts: [{ id: 'c1', name: 'Meera', relation: 'Sister', phone: '+91 98765 43210' }],
      }),
    );

    const settings = await readSettings();

    expect(settings.contacts[0].phone).toBe('+919876543210');
  });

  it('rejects a contact with no usable id, which would break list identity', async () => {
    await seed(
      JSON.stringify({
        contacts: [
          { id: '', name: 'Meera', relation: 'Sister', phone: '+919876543210' },
          { id: 42, name: 'Ravi', relation: '', phone: '+919123456780' },
        ],
      }),
    );

    await expect(readSettings()).resolves.toMatchObject({ contacts: [] });
  });

  it('accepts a missing relation as blank, since it is cosmetic', () => {
    // Distinguished from the phone deliberately: a missing relation costs a label on a row, a
    // missing phone costs the alert. Only one of them should drop the contact.
    return seed(
      JSON.stringify({ contacts: [{ id: 'c1', name: 'Meera', phone: '+919876543210' }] }),
    ).then(async () => {
      const settings = await readSettings();
      expect(settings.contacts).toEqual([
        { id: 'c1', name: 'Meera', relation: '', phone: '+919876543210' },
      ]);
    });
  });

  it('survives a contacts field that is not an array', async () => {
    for (const contacts of [null, 'nope', 42, { c1: MEERA }]) {
      await seed(JSON.stringify({ contacts }));
      await expect(readSettings()).resolves.toMatchObject({ contacts: [] });
    }
  });

  it('survives entries that are not objects', async () => {
    await seed(JSON.stringify({ contacts: [null, 'meera', 7, [], MEERA] }));

    await expect(readSettings()).resolves.toMatchObject({ contacts: [MEERA] });
  });

  it('builds sharing from the known keys, not from the stored object’s keys', async () => {
    // A pref removed from the app must not linger, and a pref *added* to the app must get its
    // documented default rather than `undefined` — which would read as `false` at every call
    // site and silently switch off a feature that ships on.
    await seed(
      JSON.stringify({
        sharing: { sos: false, retired_pref: true, cloud_backup: 'yes' },
      }),
    );

    const settings = await readSettings();

    expect(settings.sharing).toEqual({
      sos: false, // stored, honoured
      anon_aggregate: false, // absent, default
      cloud_backup: false, // wrong type, default rather than truthy-coerced
      family_share: false,
    });
    expect(settings.sharing).not.toHaveProperty('retired_pref');
  });

  it('keeps SOS on when the stored sharing block is unreadable', async () => {
    // Failing closed here would be the wrong default: it silently disables the emergency path
    // for an install whose settings blob got corrupted, and nothing would say so. The user's
    // explicit "off" is honoured above; an *absence* of information is not an "off".
    for (const sharing of [null, 'nope', 42]) {
      await seed(JSON.stringify({ sharing }));
      await expect(readSettings()).resolves.toMatchObject({ sharing: DEFAULT_SETTINGS.sharing });
    }
  });

  it('rejects an unknown sensor source', async () => {
    await seed(JSON.stringify({ sensorSource: 'telepathy' }));

    await expect(readSettings()).resolves.toMatchObject({ sensorSource: 'simulated' });
  });

  it('treats a non-string userName as blank', async () => {
    await seed(JSON.stringify({ userName: { first: 'Asha' } }));

    await expect(readSettings()).resolves.toMatchObject({ userName: '' });
  });

  it('falls back to defaults on unparseable JSON', async () => {
    await seed('{ this is not json');

    await expect(readSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to defaults on a JSON scalar', async () => {
    for (const raw of ['null', '"a string"', '42', '[]']) {
      await seed(raw);
      // `[]` is an object, so it reaches `parseSettings` and yields empty contacts plus every
      // other default — the same observable state, arrived at by a different route.
      await expect(readSettings()).resolves.toEqual(DEFAULT_SETTINGS);
    }
  });

  it('never rejects when storage itself is broken', async () => {
    // Storage being unavailable must not stop the app from starting. Defaults are a correct
    // state to start in; the only thing lost is the user's previous choices.
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValue(new Error('no storage'));

    await expect(readSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });
});

describe('writeSettings', () => {
  it('reports a failed write instead of swallowing it', async () => {
    // The reason this returns a boolean at all: a user who adds an emergency contact and sees
    // it in the list believes it is saved. If the write failed, they need to know before the
    // emergency, not during it.
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full'));

    await expect(writeSettings(DEFAULT_SETTINGS)).resolves.toBe(false);
  });
});

describe('clearSettings', () => {
  it('removes the blob and does not throw when storage is broken', async () => {
    await writeSettings({ ...DEFAULT_SETTINGS, userName: 'Asha' });
    await clearSettings();
    await expect(readSettings()).resolves.toEqual(DEFAULT_SETTINGS);

    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValue(new Error('nope'));
    await expect(clearSettings()).resolves.toBeUndefined();
  });
});

describe('upsertContact', () => {
  it('appends a new contact', () => {
    const next = upsertContact(DEFAULT_SETTINGS, MEERA);

    expect(next.contacts).toEqual([MEERA]);
    expect(DEFAULT_SETTINGS.contacts).toEqual([]); // unchanged
  });

  it('replaces in place by id, so an edit keeps its position in the list', () => {
    const two = upsertContact(upsertContact(DEFAULT_SETTINGS, MEERA), RAVI);
    const edited = upsertContact(two, { ...MEERA, name: 'Meera S.' });

    expect(edited.contacts.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(edited.contacts[0].name).toBe('Meera S.');
  });

  it('normalizes the number on the way in', () => {
    const next = upsertContact(DEFAULT_SETTINGS, { ...MEERA, phone: '+91 98765 43210' });

    expect(next.contacts[0].phone).toBe('+919876543210');
  });

  it('refuses an unusable number rather than storing it', () => {
    // Returning the settings unchanged is what lets the editor keep the form open and explain
    // the country-code requirement. Storing it would put a number the relay rejects in the
    // send path with the UI showing a saved contact.
    for (const phone of ['9876543210', '', 'call mum', '+0919876543210']) {
      expect(upsertContact(DEFAULT_SETTINGS, { ...MEERA, phone })).toBe(DEFAULT_SETTINGS);
    }
  });

  it('does not corrupt an existing contact when the edit is invalid', () => {
    const saved = upsertContact(DEFAULT_SETTINGS, MEERA);
    const attempted = upsertContact(saved, { ...MEERA, phone: '9876543210' });

    expect(attempted).toBe(saved);
    expect(attempted.contacts[0].phone).toBe('+919876543210');
  });
});

describe('removeContact', () => {
  it('removes only the named contact', () => {
    const two = upsertContact(upsertContact(DEFAULT_SETTINGS, MEERA), RAVI);

    expect(removeContact(two, 'c1').contacts).toEqual([RAVI]);
  });

  it('is a no-op for an unknown id', () => {
    const one = upsertContact(DEFAULT_SETTINGS, MEERA);

    expect(removeContact(one, 'nope').contacts).toEqual([MEERA]);
  });
});

describe('setSharingPref and isSosEnabled', () => {
  it('changes one pref and leaves the others alone', () => {
    const next = setSharingPref(DEFAULT_SETTINGS, 'anon_aggregate', true);

    expect(next.sharing).toEqual({ ...DEFAULT_SETTINGS.sharing, anon_aggregate: true });
  });

  it('gates SOS on the sos pref specifically', () => {
    // Read through a function so no call site reaches into `sharing` and picks the wrong key —
    // `family_share` sounds close enough to be picked by mistake, and it is off by default,
    // which would disable SOS for every user.
    expect(isSosEnabled(setSharingPref(DEFAULT_SETTINGS, 'sos', false))).toBe(false);
    expect(isSosEnabled(setSharingPref(DEFAULT_SETTINGS, 'family_share', false))).toBe(true);
  });

  it('requires a real true rather than anything truthy', () => {
    const forged = { ...DEFAULT_SETTINGS, sharing: { ...DEFAULT_SETTINGS.sharing, sos: 1 } };

    expect(isSosEnabled(forged as unknown as PersistedSettings)).toBe(false);
  });
});
