/**
 * Persisted user settings (PRD §7.2.4 Settings, §7.2.6 privacy).
 *
 * ## Why these have to be persisted rather than held in `useState`
 * The Settings screen used to keep its toggles in component state and read its contacts from
 * a hardcoded array. That is fine for a shell, and wrong the moment SOS is real: the consent
 * gate PRD §7.2.6 describes ("no raw health data leaves device without explicit user opt-in")
 * has to survive a remount to mean anything, and an emergency contact list that resets when
 * the process restarts cannot be relied on in an emergency.
 *
 * ## Validate on read, same as the environment cache
 * The stored blob is JSON written by a *previous build*. `src/environment/cache.ts` documents
 * the failure this prevents — a field rename turning into `undefined.toFixed()` for every
 * existing install while every test passes on the new schema — and the reasoning is identical
 * here, with a sharper edge: a malformed contact list that deserialises into
 * `[{ phone: undefined }]` would make the SOS path silently unable to reach anyone.
 *
 * So the key carries a schema version, every field is checked, and anything unreadable falls
 * back to {@link DEFAULT_SETTINGS} rather than being partially trusted.
 *
 * ## There are deliberately no seeded demo contacts
 * The previous `EMERGENCY_CONTACTS` constant held two realistic-looking Indian numbers. Now
 * that a real send path exists, shipping those as defaults would mean a demo tap texts a
 * stranger — `+91 98765 43210` normalises to a structurally valid E.164 number, so no
 * validation layer would stop it. `health-data.ts` already states this principle for the
 * weather constant it deleted ("keeping a plausible-looking fallback beside a live feed is how
 * a demo value ends up on screen with nothing saying so"); the same applies with real
 * consequences. The list starts empty and the screen says why.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { DataSharingPref, SensorSourceOption } from '@/constants/health-data';
import { DATA_SHARING_PREFS, DEFAULT_SENSOR_SOURCE, SENSOR_SOURCES } from '@/constants/health-data';
import { normalizePhone } from '@/sos/phone';
import type { EmergencyContact } from '@/sos/types';

/** Bump the suffix on any breaking shape change. Old entries then miss rather than
 *  deserialise into a half-populated object. */
export const SETTINGS_KEY = 'phc.settings.v1';

export type SharingPrefs = Readonly<Record<DataSharingPref['key'], boolean>>;

export type PersistedSettings = {
  /** Empty until the user adds someone. See the module note on why nothing is seeded. */
  readonly contacts: readonly EmergencyContact[];
  /** Named in the SOS message so a contact knows who needs help. Blank is allowed. */
  readonly userName: string;
  readonly sharing: SharingPrefs;
  readonly sensorSource: SensorSourceOption['key'];
};

const DEFAULT_SHARING: SharingPrefs = Object.freeze(
  Object.fromEntries(DATA_SHARING_PREFS.map((pref) => [pref.key, pref.defaultOn])),
) as SharingPrefs;

export const DEFAULT_SETTINGS: PersistedSettings = Object.freeze({
  contacts: [],
  userName: '',
  sharing: DEFAULT_SHARING,
  sensorSource: DEFAULT_SENSOR_SOURCE,
});

const SHARING_KEYS = new Set<string>(DATA_SHARING_PREFS.map((pref) => pref.key));
const SOURCE_KEYS = new Set<string>(SENSOR_SOURCES.map((option) => option.key));

/**
 * Accept a stored contact only if it can still reach someone.
 *
 * The phone number is re-normalized on read rather than trusted. A build that stored numbers
 * in a looser format, or a hand-edited storage blob, would otherwise put a string the Twilio
 * relay rejects into the send path — and the first time anyone finds out is during an
 * emergency. Anything unnormalizable is dropped, which is visible in the UI as a missing
 * contact rather than invisible as a failing send.
 */
function parseContact(value: unknown): EmergencyContact | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const { id, name, relation, phone } = record;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof name !== 'string' || typeof phone !== 'string') return null;

  const normalized = normalizePhone(phone);
  if (normalized === null) return null;

  return {
    id,
    name,
    relation: typeof relation === 'string' ? relation : '',
    phone: normalized,
  };
}

function parseSharing(value: unknown): SharingPrefs {
  if (typeof value !== 'object' || value === null) return DEFAULT_SHARING;
  const record = value as Record<string, unknown>;

  // Built from the *known* key list rather than from the stored object's keys, so a pref
  // removed from the app cannot linger and a pref added to the app gets its documented
  // default instead of `undefined`.
  const merged: Record<string, boolean> = { ...DEFAULT_SHARING };
  for (const key of Object.keys(record)) {
    if (SHARING_KEYS.has(key) && typeof record[key] === 'boolean') {
      merged[key] = record[key] as boolean;
    }
  }
  return merged as SharingPrefs;
}

function parseSettings(value: unknown): PersistedSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_SETTINGS;
  const record = value as Record<string, unknown>;

  const contacts = Array.isArray(record.contacts)
    ? record.contacts.map(parseContact).filter((c): c is EmergencyContact => c !== null)
    : [];

  const source = record.sensorSource;

  return {
    contacts,
    userName: typeof record.userName === 'string' ? record.userName : '',
    sharing: parseSharing(record.sharing),
    sensorSource:
      typeof source === 'string' && SOURCE_KEYS.has(source)
        ? (source as SensorSourceOption['key'])
        : DEFAULT_SENSOR_SOURCE,
  };
}

/**
 * Load settings, or the documented defaults.
 *
 * Never rejects. Storage being unavailable must not stop the app from starting, and defaults
 * are a correct state to start in — the only thing lost is the user's previous choices, which
 * the Settings screen shows them plainly.
 */
export async function readSettings(): Promise<PersistedSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    return parseSettings(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Persist settings. Returns whether the write landed, so the UI can warn rather than
 *  silently forget an emergency contact the user believes is saved. */
export async function writeSettings(settings: PersistedSettings): Promise<boolean> {
  try {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** Test/reset helper. */
export async function clearSettings(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SETTINGS_KEY);
  } catch {
    // Nothing actionable.
  }
}

// ---------------------------------------------------------------------------
// Pure reducers. Kept separate from the I/O above so the list semantics are
// unit-testable without storage, and so the provider stays a thin wrapper.
// ---------------------------------------------------------------------------

/**
 * Add or replace a contact.
 *
 * Replaces by `id`, so editing is the same operation as adding and the caller does not need
 * two code paths. Rejects an unnormalizable number by returning the settings unchanged —
 * silently storing it would put a number the relay cannot use in the send path.
 */
export function upsertContact(
  settings: PersistedSettings,
  contact: EmergencyContact,
): PersistedSettings {
  const phone = normalizePhone(contact.phone);
  if (phone === null) return settings;

  const normalized: EmergencyContact = { ...contact, phone };
  const index = settings.contacts.findIndex((existing) => existing.id === contact.id);

  const contacts =
    index === -1
      ? [...settings.contacts, normalized]
      : settings.contacts.map((existing, i) => (i === index ? normalized : existing));

  return { ...settings, contacts };
}

export function removeContact(settings: PersistedSettings, id: string): PersistedSettings {
  return { ...settings, contacts: settings.contacts.filter((contact) => contact.id !== id) };
}

export function setSharingPref(
  settings: PersistedSettings,
  key: DataSharingPref['key'],
  value: boolean,
): PersistedSettings {
  return { ...settings, sharing: { ...settings.sharing, [key]: value } };
}

/**
 * Whether SOS may send at all.
 *
 * The one consent gate that governs an outbound path carrying personal data (PRD §7.2.6).
 * Read through a function so every call site expresses the same intent and none of them
 * reaches into `sharing` directly and forgets which key means what.
 */
export function isSosEnabled(settings: PersistedSettings): boolean {
  return settings.sharing.sos === true;
}
