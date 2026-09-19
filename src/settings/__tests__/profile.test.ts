/**
 * User profile tests.
 *
 * Same validate-on-read reasoning as `store.test.ts`: `parseProfile` reads a blob a *previous
 * build* wrote (or a hand-edited one), so it is tested against hostile input, not against its
 * own output. The other half of this module — `vulnerabilityFactors` / `isVulnerable` — is
 * pure classification with no engine wiring behind it yet; `profile-regression` in
 * `src/__tests__/` is what proves that.
 */

import {
  AGE_BANDS,
  DEFAULT_PROFILE,
  isVulnerable,
  parseProfile,
  vulnerabilityFactors,
  type UserProfile,
} from '@/settings/profile';

describe('DEFAULT_PROFILE', () => {
  it('starts unknown/false/false/false, the least assuming state', () => {
    expect(DEFAULT_PROFILE).toEqual({
      ageBand: 'unknown',
      chronicCondition: false,
      outdoorWorker: false,
      pregnant: false,
    });
  });

  it('is not vulnerable', () => {
    expect(isVulnerable(DEFAULT_PROFILE)).toBe(false);
    expect(vulnerabilityFactors(DEFAULT_PROFILE)).toEqual([]);
  });
});

describe('AGE_BANDS', () => {
  it('lists every AgeBand exactly once, in the order the picker should show them', () => {
    expect(AGE_BANDS.map((band) => band.key)).toEqual([
      'unknown',
      'under18',
      '18to39',
      '40to59',
      '60plus',
    ]);
  });
});

describe('parseProfile — validating what a previous build left behind', () => {
  it('falls back to defaults on non-object input', () => {
    for (const value of [null, undefined, 'nope', 42, []]) {
      expect(parseProfile(value)).toEqual(DEFAULT_PROFILE);
    }
  });

  it('round-trips a well-formed profile', () => {
    const profile: UserProfile = {
      ageBand: '60plus',
      chronicCondition: true,
      outdoorWorker: true,
      pregnant: false,
    };
    expect(parseProfile(profile)).toEqual(profile);
  });

  it('rejects an unknown age band rather than trusting it', () => {
    expect(parseProfile({ ageBand: 'ancient' })).toMatchObject({ ageBand: 'unknown' });
  });

  it('treats a non-string age band as unknown', () => {
    for (const ageBand of [42, null, { years: 61 }]) {
      expect(parseProfile({ ageBand })).toMatchObject({ ageBand: 'unknown' });
    }
  });

  it('requires a real true for each boolean rather than anything truthy', () => {
    expect(
      parseProfile({ chronicCondition: 'yes', outdoorWorker: 1, pregnant: 'true' }),
    ).toEqual(DEFAULT_PROFILE);
  });

  it('tolerates a missing field, filling in the default for that field alone', () => {
    expect(parseProfile({ ageBand: '40to59' })).toEqual({
      ...DEFAULT_PROFILE,
      ageBand: '40to59',
    });
  });

  it('ignores unknown extra fields', () => {
    expect(parseProfile({ ageBand: '18to39', favouriteColour: 'blue' })).toEqual({
      ...DEFAULT_PROFILE,
      ageBand: '18to39',
    });
  });
});

describe('vulnerabilityFactors', () => {
  it('flags 60plus but not any other age band', () => {
    expect(vulnerabilityFactors({ ...DEFAULT_PROFILE, ageBand: '60plus' })).toEqual([
      'age60plus',
    ]);
    for (const ageBand of ['unknown', '18to39', '40to59'] as const) {
      expect(vulnerabilityFactors({ ...DEFAULT_PROFILE, ageBand })).toEqual([]);
    }
  });

  it('flags under18', () => {
    expect(vulnerabilityFactors({ ...DEFAULT_PROFILE, ageBand: 'under18' })).toEqual([
      'under18',
    ]);
  });

  it('flags chronicCondition, outdoorWorker, and pregnant independently', () => {
    expect(
      vulnerabilityFactors({ ...DEFAULT_PROFILE, chronicCondition: true }),
    ).toEqual(['chronicCondition']);
    expect(vulnerabilityFactors({ ...DEFAULT_PROFILE, outdoorWorker: true })).toEqual([
      'outdoorWorker',
    ]);
    expect(vulnerabilityFactors({ ...DEFAULT_PROFILE, pregnant: true })).toEqual(['pregnant']);
  });

  it('combines every applicable factor', () => {
    const profile: UserProfile = {
      ageBand: '60plus',
      chronicCondition: true,
      outdoorWorker: true,
      pregnant: true,
    };
    expect(vulnerabilityFactors(profile)).toEqual([
      'age60plus',
      'chronicCondition',
      'outdoorWorker',
      'pregnant',
    ]);
  });
});

describe('isVulnerable', () => {
  it('is true exactly when at least one factor applies', () => {
    expect(isVulnerable(DEFAULT_PROFILE)).toBe(false);
    expect(isVulnerable({ ...DEFAULT_PROFILE, pregnant: true })).toBe(true);
    expect(isVulnerable({ ...DEFAULT_PROFILE, ageBand: '60plus' })).toBe(true);
  });
});
