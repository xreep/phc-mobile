/**
 * Community screen tests (PRD §4, ASHA persona).
 *
 * Two things on this screen can fail in a way that a reviewer would not notice, and both are
 * about what is *shown* rather than about what is computed:
 *
 * 1. **Figures appearing before consent.** `aggregate.test.ts` proves the suppression is right;
 *    it says nothing about whether the screen renders the aggregate while the pref is off. A
 *    conditional moved up one level during a refactor would leak every count and break no
 *    aggregation test.
 * 2. **The concept-demo label going missing.** This is the one screen in the app that shows
 *    invented figures — `environment.tsx` deliberately refuses to — so the label is not
 *    decoration, it is the thing that makes showing them defensible at all. A card removed
 *    during a layout change would leave a screen that reads exactly like live data.
 *
 * So both are asserted in both states, through the real `SettingsProvider` over the real store,
 * against the AsyncStorage mock — and the opt-in is checked across a remount, because a consent
 * gate that resets on restart is a toggle rather than consent.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import CommunityScreen from '@/app/community';
import { DEMO_AREA, MIN_REPORTABLE_COUNT } from '@/community';
import { SettingsProvider } from '@/settings/provider';
import { readSettings, setSharingPref, SETTINGS_KEY, DEFAULT_SETTINGS } from '@/settings/store';

const INSETS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** Every RNTL v14 interaction is async — see the note in `settings-screen.test.tsx`. */
function renderCommunity() {
  return render(
    <SafeAreaProvider initialMetrics={INSETS}>
      <SettingsProvider>
        <CommunityScreen />
      </SettingsProvider>
    </SafeAreaProvider>,
  );
}

const CONSENT_LABEL = 'Anonymous community insights';
const DEMO_BANNER = 'Concept demonstration — not live data';
const HEADLINE = '3 nearby people at elevated heat risk';

/** Seed storage as though the user had already opted in, so a test can start from that state
 *  without going through the switch. */
async function seedOptedIn() {
  await AsyncStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify(setSharingPref(DEFAULT_SETTINGS, 'anon_aggregate', true)),
  );
}

/** Anything that would be a figure about the ward. Asserted absent as a group, because the leak
 *  worth preventing is "a count got out", not "this particular string got out". */
function figuresOnScreen(screen: Awaited<ReturnType<typeof renderCommunity>>) {
  return [
    screen.queryByText(/nearby (people|person) at elevated/),
    screen.queryByText(/participants shared a reading/),
    screen.queryByText('By category'),
    screen.queryByText('Ward summary'),
    screen.queryByText('Heat Stress'),
  ].filter((node) => node !== null);
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('before the user opts in', () => {
  it('shows no figures at all — not a count, not a total, not a category', async () => {
    const screen = await renderCommunity();
    await waitFor(() => expect(screen.getByText('Community insights are off')).toBeTruthy());

    expect(figuresOnScreen(screen)).toEqual([]);
  });

  it('still labels itself a concept demonstration', async () => {
    const screen = await renderCommunity();
    await waitFor(() => expect(screen.getByText(DEMO_BANNER)).toBeTruthy());
  });

  it('offers the opt-in inline, switched off', async () => {
    const screen = await renderCommunity();
    await waitFor(() => expect(screen.getByLabelText(CONSENT_LABEL)).toBeTruthy());
    expect(screen.getByLabelText(CONSENT_LABEL).props.value).toBe(false);
  });

  it('names the ward in the header without publishing anything about it', async () => {
    // The area is the user's own, so it is not a disclosure — and a screen that would not even
    // say which ward it means is hard to evaluate as a demo.
    const screen = await renderCommunity();
    await waitFor(() => expect(screen.getByText(`${DEMO_AREA} · concept demo`)).toBeTruthy());
  });
});

describe('after the user opts in', () => {
  it('shows the aggregate', async () => {
    const screen = await renderCommunity();
    await waitFor(() => expect(screen.getByLabelText(CONSENT_LABEL)).toBeTruthy());

    await fireEvent(screen.getByLabelText(CONSENT_LABEL), 'valueChange', true);

    await waitFor(() => expect(screen.getByText(HEADLINE)).toBeTruthy());
    expect(screen.getByText('14 participants shared a reading in the past 60-minute window.'))
      .toBeTruthy();
    expect(screen.queryByText('Community insights are off')).toBeNull();
  });

  it('keeps the concept-demonstration label above the figures', async () => {
    await seedOptedIn();
    const screen = await renderCommunity();

    await waitFor(() => expect(screen.getByText(HEADLINE)).toBeTruthy());
    expect(screen.getByText(DEMO_BANNER)).toBeTruthy();
    expect(
      screen.getByText(
        /no community server and no way to send or receive a report(.|\n)*not real people/,
      ),
    ).toBeTruthy();
  });

  it('says nothing is shared either way, so the switch is not mistaken for an upload', async () => {
    await seedOptedIn();
    const screen = await renderCommunity();

    await waitFor(() =>
      expect(screen.getByText(/Nothing is shared whether the switch is on or off/)).toBeTruthy(),
    );
  });

  it('lists every category, publishing two and withholding four', async () => {
    await seedOptedIn();
    const screen = await renderCommunity();
    await waitFor(() => expect(screen.getByText('By category')).toBeTruthy());

    for (const label of [
      'Heat Stress',
      'Respiratory',
      'Cardiovascular',
      'Fall Detection',
      'Dehydration',
      'Fatigue',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }

    // Four withheld rows, each rendered as the same placeholder — see `demo-cohort.ts`.
    expect(screen.getAllByText('—')).toHaveLength(4);
  });

  it('explains what a withheld row means rather than leaving it to read as all-clear', async () => {
    await seedOptedIn();
    const screen = await renderCommunity();

    await waitFor(() =>
      expect(
        screen.getByText(
          `A count is only shown once at least ${MIN_REPORTABLE_COUNT} participants are in it. ` +
            '2 of 6 categories reach that here; the other 4 show —.',
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText(/could be 0, 1, or 2 — it does not say which/)).toBeTruthy();
  });

  it('lets the user turn it back off, and hides the figures again', async () => {
    await seedOptedIn();
    const screen = await renderCommunity();
    await waitFor(() => expect(screen.getByText(HEADLINE)).toBeTruthy());

    await fireEvent(screen.getByLabelText(CONSENT_LABEL), 'valueChange', false);

    await waitFor(() => expect(screen.getByText('Community insights are off')).toBeTruthy());
    expect(figuresOnScreen(screen)).toEqual([]);
  });
});

describe('the consent gate', () => {
  it('persists, so it is consent rather than a toggle', async () => {
    const screen = await renderCommunity();
    await waitFor(() => expect(screen.getByLabelText(CONSENT_LABEL)).toBeTruthy());

    await fireEvent(screen.getByLabelText(CONSENT_LABEL), 'valueChange', true);
    await waitFor(async () => {
      await expect(readSettings()).resolves.toMatchObject({
        sharing: { anon_aggregate: true },
      });
    });

    // A remount is the only way to tell "saved" from "still in component state".
    await screen.unmount();
    const second = await renderCommunity();
    await waitFor(() => expect(second.getByText(HEADLINE)).toBeTruthy());
  });

  it('is the same pref Settings shows, not a second switch beside it', async () => {
    // Two keys would let a user consent in one screen and decline in the other, with no
    // defensible answer as to which won.
    const screen = await renderCommunity();
    await waitFor(() => expect(screen.getByLabelText(CONSENT_LABEL)).toBeTruthy());

    await fireEvent(screen.getByLabelText(CONSENT_LABEL), 'valueChange', true);

    await waitFor(async () => {
      const stored = await readSettings();
      expect(stored.sharing.anon_aggregate).toBe(true);
      // Nothing else moved — in particular the SOS gate, which shares the same record.
      expect(stored.sharing.sos).toBe(true);
      expect(stored.sharing.cloud_backup).toBe(false);
      expect(stored.sharing.family_share).toBe(false);
    });
  });

  it('stays off when storage is empty, rather than defaulting open', async () => {
    const screen = await renderCommunity();
    await waitFor(() => expect(screen.getByText('Community insights are off')).toBeTruthy());
    await expect(AsyncStorage.getItem(SETTINGS_KEY)).resolves.toBeNull();
  });
});
