/**
 * The Dashboard's answer to "why is the vitals row empty?" when the live feed is selected.
 *
 * The notice must be absent in exactly two states — simulated source, and live with readings —
 * because a permanent status row would train the user to ignore it. And the only tappable
 * state is permission-required, because that is the only one a tap can fix.
 */

import { fireEvent, render } from '@testing-library/react-native';

import { noticeFor, SensorFeedNotice } from '@/components/sensor-feed-notice';

describe('noticeFor', () => {
  it('is silent on the simulated source whatever the feed says', () => {
    expect(noticeFor({ live: false, status: 'error', failure: null, vitalReadingCount: 0 })).toBeNull();
  });

  it('is silent once live readings exist', () => {
    expect(noticeFor({ live: true, status: 'live', failure: null, vitalReadingCount: 3 })).toBeNull();
  });

  it('says it is waiting when live but no reading carries a vital', () => {
    // The count is of *vital* readings: the phone's own motion summaries arrive from the first
    // poll even when the band has never synced, and must not silence the one notice that says so.
    const notice = noticeFor({ live: true, status: 'live', failure: null, vitalReadingCount: 0 });
    expect(notice?.title).toMatch(/waiting/i);
    expect(notice?.actionable).toBe(false);
  });

  it('asks for access, tappably, when permission is required', () => {
    const notice = noticeFor({
      live: true,
      status: 'permission-required',
      failure: null,
      vitalReadingCount: 0,
    });
    expect(notice?.actionable).toBe(true);
    expect(notice?.hint).toMatch(/heart rate/i);
  });

  it('surfaces the failure message for unavailable and error', () => {
    const failure = { kind: 'sdk' as const, message: 'Health Connect is not available on this device.' };
    expect(
      noticeFor({ live: true, status: 'unavailable', failure, vitalReadingCount: 0 })?.hint,
    ).toBe(failure.message);
    expect(
      noticeFor({ live: true, status: 'error', failure: { kind: 'read', message: 'busy' }, vitalReadingCount: 2 })
        ?.hint,
    ).toBe('busy');
  });
});

describe('SensorFeedNotice', () => {
  it('renders nothing when there is no notice', async () => {
    const screen = await render(
      <SensorFeedNotice live={false} status="idle" failure={null} vitalReadingCount={0} onRequestAccess={jest.fn()} />,
    );
    expect(screen.toJSON()).toBeNull();
  });

  it('calls onRequestAccess only from the permission-required state', async () => {
    const onRequestAccess = jest.fn();
    const screen = await render(
      <SensorFeedNotice
        live
        status="permission-required"
        failure={null}
        vitalReadingCount={0}
        onRequestAccess={onRequestAccess}
      />,
    );
    fireEvent.press(screen.getByRole('button'));
    expect(onRequestAccess).toHaveBeenCalledTimes(1);
  });

  it('is not a button while waiting', async () => {
    const screen = await render(
      <SensorFeedNotice live status="live" failure={null} vitalReadingCount={0} onRequestAccess={jest.fn()} />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/waiting/i)).toBeTruthy();
  });
});
