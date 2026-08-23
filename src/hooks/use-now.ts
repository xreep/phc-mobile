/**
 * A clock that a component may read during render.
 *
 * ## Why a hook rather than `Date.now()`
 * Two things make a bare `Date.now()` in a render body wrong here, and only one of them is
 * a lint rule:
 *
 * 1. **It is impure.** This project builds with the React Compiler
 *    (`experiments.reactCompiler`), which memoises render output on the assumption that a
 *    component is a function of its props and state. A clock read is neither, so the
 *    compiler is free to reuse a previous result — and `react-hooks/purity` rejects it
 *    outright rather than letting that surprise ship.
 * 2. **It never advances on its own.** A component that reads the clock during render only
 *    sees a new time when something *else* re-renders it. Every "updated N minutes ago"
 *    line in this app is `formatAge(now - timestamp)`, so a `now` that only moves when the
 *    data moves produces a label that is correct for an instant and then quietly wrong for
 *    as long as the data holds still — half an hour, in the case of the environment feed.
 *    The label keeps claiming the reading is two minutes old for the entire interval.
 *
 * That second failure is the one worth naming: it is silent, it looks right in every
 * screenshot taken just after a fetch, and no test that renders once can catch it.
 *
 * ## Why the AppState listener is not redundant with the interval
 * React Native throttles and suspends JS timers while the app is backgrounded, so a phone
 * left in a pocket for two hours does not accumulate two hours of ticks. Without the
 * foreground re-read, the first frame after returning to the app renders the age the clock
 * had when it stopped — the exact moment a user is most likely to be checking how current
 * the data is. Re-reading on `active` makes that frame correct instead of correcting it one
 * interval later.
 */

import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * The current instant in epoch ms, re-read every `intervalMs` and on foreground.
 *
 * @param intervalMs How often to advance. Choose it from the *granularity being displayed*
 *   rather than from a wish for precision: a tick finer than the smallest unit
 *   `formatAge` prints only costs re-renders that change nothing on screen.
 */
export function useNow(intervalMs: number): number {
  // Lazy initialiser, not a render-body call: it runs once during mount rather than on
  // every render, which is what keeps the component itself pure.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === 'active') setNow(Date.now());
    };

    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, []);

  return now;
}
