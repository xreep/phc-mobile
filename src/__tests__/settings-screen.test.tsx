/**
 * Settings screen tests.
 *
 * The screen was a placeholder with hardcoded rows until SOS became real. What makes it worth
 * testing now is that it is the *only* place a user can put a phone number into the send path,
 * and the failure it has to prevent is silent: a number saved without a country code, or saved
 * to state but never to disk, looks correct on screen and is discovered during an emergency.
 *
 * So these tests are about persistence and about the country-code refusal, not about layout.
 * Each one drives the real `SettingsProvider` over the real store against the AsyncStorage jest
 * mock, then asserts through a *fresh* mount — a remount is the only way to tell "saved" from
 * "still in component state".
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import SettingsScreen from '@/app/settings';
import { SettingsProvider } from '@/settings/provider';
import { readSettings, SETTINGS_KEY } from '@/settings/store';

const INSETS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/**
 * In react-native-testing-library v14, **every** interaction is async: `render`, `fireEvent`,
 * `unmount`, and `rerender` all return promises and all must be awaited.
 *
 * The failure modes are each misleading in a different way, which is why this is written down:
 * an unawaited `render` yields a promise whose `getByText` is `undefined`, so assertions fail on
 * "not a function"; an unawaited `fireEvent` fires the handler but never flushes the re-render,
 * so the screen looks as though the press did nothing; and an unawaited `unmount` leaves an act
 * scope open, which breaks *every subsequent test in the file* with an "overlapping act() calls"
 * warning and empty renders. The last one is the expensive one — the symptom appears in tests
 * that are themselves correct.
 */
function renderSettings() {
  return render(
    <SafeAreaProvider initialMetrics={INSETS}>
      <SettingsProvider>
        <SettingsScreen />
      </SettingsProvider>
    </SafeAreaProvider>,
  );
}

const originalRelay = process.env.EXPO_PUBLIC_TWILIO_SOS_URL;

beforeEach(async () => {
  await AsyncStorage.clear();
  delete process.env.EXPO_PUBLIC_TWILIO_SOS_URL;
});

afterEach(() => {
  if (originalRelay === undefined) delete process.env.EXPO_PUBLIC_TWILIO_SOS_URL;
  else process.env.EXPO_PUBLIC_TWILIO_SOS_URL = originalRelay;
});

/** Open the add-contact sheet and fill it in. */
async function addContact(
  screen: Awaited<ReturnType<typeof renderSettings>>,
  fields: { name: string; relation?: string; phone: string },
) {
  await fireEvent.press(screen.getByText('+ Add emergency contact'));

  await fireEvent.changeText(screen.getByLabelText('Contact name'), fields.name);
  if (fields.relation !== undefined) {
    await fireEvent.changeText(screen.getByLabelText('Relationship'), fields.relation);
  }
  await fireEvent.changeText(screen.getByLabelText('Phone number'), fields.phone);
}

describe('emergency contacts', () => {
  it('says plainly that there is nowhere to send, rather than showing an empty list', async () => {
    // The honest default. Seeding demo numbers here would have texted a stranger on the first
    // press, and showing a blank card would leave the user thinking SOS was ready.
    const screen = await renderSettings();

    await waitFor(() =>
      expect(
        screen.getByText(
          'No contacts yet. Emergency SOS has nowhere to send until you add at least one.',
        ),
      ).toBeTruthy(),
    );
  });

  it('adds a contact and persists it, not just to component state', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());

    await addContact(screen, { name: 'Meera', relation: 'Sister', phone: '+91 98765 43210' });
    await fireEvent.press(screen.getByText('Save contact'));

    await waitFor(() => expect(screen.getByText('Meera')).toBeTruthy());
    expect(screen.getByText('Sister · +91 98765 43210')).toBeTruthy();

    // The assertion that matters: it reached storage, normalized. A contact list that lives only
    // in component state resets with the process and cannot be relied on in an emergency.
    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.contacts).toEqual([
        { id: expect.any(String), name: 'Meera', relation: 'Sister', phone: '+919876543210' },
      ]);
    });
  });

  it('shows a saved contact on a fresh mount', async () => {
    const first = await renderSettings();
    await waitFor(() => expect(first.getByText('+ Add emergency contact')).toBeTruthy());
    await addContact(first, { name: 'Ravi', phone: '+919123456780' });
    await fireEvent.press(first.getByText('Save contact'));
    await waitFor(() => expect(first.getByText('Ravi')).toBeTruthy());
    await first.unmount();

    const second = await renderSettings();

    await waitFor(() => expect(second.getByText('Ravi')).toBeTruthy());
    // No relation given, so the row shows the number alone rather than a leading separator.
    expect(second.getByText('+91 91234 56780')).toBeTruthy();
  });

  it('refuses a number with no country code and explains why', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());

    await addContact(screen, { name: 'Meera', phone: '9876543210' });

    // The explanation, not just a disabled button: the user is meeting a deliberate refusal and
    // needs to know it is not a bug.
    expect(
      screen.getByText(
        'Include the country code, for example +91 for India. SOS will not guess it — a wrong code sends the alert to a stranger.',
      ),
    ).toBeTruthy();

    await fireEvent.press(screen.getByText('Save contact'));

    // Nothing saved, and the sheet stays open so the number can be fixed.
    expect(screen.getByLabelText('Phone number')).toBeTruthy();
    await expect(readSettings()).resolves.toMatchObject({ contacts: [] });
  });

  it('echoes back the number that will actually be dialled', async () => {
    // The only feedback available short of sending a test message, and the typo it catches is
    // otherwise silent until an emergency.
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());

    await addContact(screen, { name: 'Meera', phone: '00919876543210' });

    expect(screen.getByText('Will send to +91 98765 43210')).toBeTruthy();
  });

  it('edits a contact in place rather than adding a second one', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());
    await addContact(screen, { name: 'Meera', relation: 'Sister', phone: '+919876543210' });
    await fireEvent.press(screen.getByText('Save contact'));
    await waitFor(() => expect(screen.getByText('Meera')).toBeTruthy());

    await fireEvent.press(screen.getByText('Meera'));
    // Seeded with the stored E.164, so an edit round-trip cannot quietly change the number.
    expect(screen.getByLabelText('Phone number').props.value).toBe('+919876543210');
    await fireEvent.changeText(screen.getByLabelText('Contact name'), 'Meera S.');
    await fireEvent.press(screen.getByText('Save contact'));

    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.contacts).toHaveLength(1);
      expect(stored.contacts[0].name).toBe('Meera S.');
      expect(stored.contacts[0].phone).toBe('+919876543210');
    });
  });

  it('removes a contact', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());
    await addContact(screen, { name: 'Meera', phone: '+919876543210' });
    await fireEvent.press(screen.getByText('Save contact'));
    await waitFor(() => expect(screen.getByText('Meera')).toBeTruthy());

    await fireEvent.press(screen.getByText('Meera'));
    await fireEvent.press(screen.getByText('Remove contact'));

    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({ contacts: [] });
    });
    expect(
      screen.getByText(
        'No contacts yet. Emergency SOS has nowhere to send until you add at least one.',
      ),
    ).toBeTruthy();
  });

  it('offers no delete on a contact that does not exist yet', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());

    await fireEvent.press(screen.getByText('+ Add emergency contact'));

    expect(screen.getByText('Add emergency contact')).toBeTruthy();
    expect(screen.queryByText('Remove contact')).toBeNull();
  });
});

describe('your name', () => {
  it('persists on blur, trimmed', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByLabelText('Your name')).toBeTruthy());

    await fireEvent.changeText(screen.getByLabelText('Your name'), '  Asha  ');
    await fireEvent(screen.getByLabelText('Your name'), 'blur');

    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({ userName: 'Asha' });
    });
  });

  it('shows the stored name once storage resolves', async () => {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ userName: 'Asha' }));

    const screen = await renderSettings();

    // The `nameDraft: string | null` pattern exists for this: a draft initialised to `''` would
    // render empty and then be committed over the stored value on the first blur.
    await waitFor(() => expect(screen.getByLabelText('Your name').props.value).toBe('Asha'));
  });
});

describe('how SOS sends', () => {
  it('says the relay is unconfigured, and what that means for the user', async () => {
    const screen = await renderSettings();

    await waitFor(() => expect(screen.getByText('Automatic relay not configured')).toBeTruthy());
    expect(
      screen.getByText(
        'Set EXPO_PUBLIC_TWILIO_SOS_URL in .env.local to send automatically. Until then SOS opens your SMS app with the message ready — you press send.',
      ),
    ).toBeTruthy();
  });

  it('says the relay is configured when it is', async () => {
    process.env.EXPO_PUBLIC_TWILIO_SOS_URL = 'https://phc-1234.twil.io/sos';

    const screen = await renderSettings();

    await waitFor(() => expect(screen.getByText('Automatic relay configured')).toBeTruthy());
  });

  it('states the composer limitation in calm conditions', async () => {
    // It cannot be discovered during an emergency, so it is said here, where there is time to
    // read it.
    const screen = await renderSettings();

    await waitFor(() =>
      expect(
        screen.getByText(
          'The SMS fallback works without mobile data, but it always needs you to press send — Android and iOS never let an app send a text on its own.',
        ),
      ).toBeTruthy(),
    );
  });
});

describe('data sharing', () => {
  it('persists a toggle', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByLabelText('Anonymous community insights')).toBeTruthy());

    await fireEvent(screen.getByLabelText('Anonymous community insights'), 'valueChange', true);

    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.sharing.anon_aggregate).toBe(true);
    });
  });

  it('persists turning the SOS opt-in off', async () => {
    // PRD §7.2.6's consent gate. It has to survive a remount to mean anything — an opt-out that
    // resets on restart is not consent management, it is a toggle.
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByLabelText('Emergency SOS alerts')).toBeTruthy());
    expect(screen.getByLabelText('Emergency SOS alerts').props.value).toBe(true);

    await fireEvent(screen.getByLabelText('Emergency SOS alerts'), 'valueChange', false);

    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({ sharing: { sos: false } });
    });

    await screen.unmount();
    const second = await renderSettings();
    await waitFor(() =>
      expect(second.getByLabelText('Emergency SOS alerts').props.value).toBe(false),
    );
  });

  it('says what turning SOS off actually stops', async () => {
    const screen = await renderSettings();

    await waitFor(() =>
      expect(
        screen.getByText(
          'All sharing is off by default except emergency SOS. No raw health data leaves your device. Turning off emergency SOS stops the app alerting your contacts at all, including automatically.',
        ),
      ).toBeTruthy(),
    );
  });
});

describe('sensor source', () => {
  it('persists the selection', async () => {
    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('ESP32 Prototype (BLE)')).toBeTruthy());

    await fireEvent.press(screen.getByText('ESP32 Prototype (BLE)'));

    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({ sensorSource: 'ble_esp32' });
    });
  });
});

describe('a failed write', () => {
  it('warns rather than silently forgetting a contact the user believes is saved', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full'));

    const screen = await renderSettings();
    await waitFor(() => expect(screen.getByText('+ Add emergency contact')).toBeTruthy());

    await act(async () => {
      await fireEvent(screen.getByLabelText('Emergency SOS alerts'), 'valueChange', false);
    });

    await waitFor(() => expect(screen.getByText('Changes could not be saved')).toBeTruthy());
    expect(
      screen.getByText(
        'Device storage rejected the write, so anything you change here will be lost when the app restarts. Free up space and reopen Settings.',
      ),
    ).toBeTruthy();

    jest.restoreAllMocks();
  });
});
