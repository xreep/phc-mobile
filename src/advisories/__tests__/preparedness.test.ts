/**
 * The static advisory content — what it must cover, and what it must never claim.
 *
 * Fixed text needs a different kind of test from a rule. There is no arithmetic to pin and no
 * boundary to probe; what can go wrong is that someone edits the copy and the copy stops being
 * honest, or that a required topic quietly disappears in a rewrite. So this file asserts two
 * things about the content that no amount of proofreading enforces:
 *
 *   1. **Coverage.** The specific health risks this module exists to cover are still covered —
 *      waterborne disease, contaminated water, wound and skin infection, and evacuation readiness
 *      for flood; medication supply and elderly mobility before a cyclone, injury and infection
 *      after one. A rewrite that drops one of these leaves a card that still looks complete.
 *   2. **No false provenance and no false liveness.** `environment/types.ts` forbids attributing
 *      an advisory to an agency the app has not contacted, and the mock this app replaced did
 *      exactly that with "IMD" and "CPCB". Static evacuation guidance carrying a real agency's
 *      name is the highest-stakes version of that mistake, so the ban is a test rather than a
 *      comment. The same goes for present-tense liveness — "currently", "right now", "today" —
 *      which would turn reference text into a claim about conditions.
 */

import {
  PREPAREDNESS_ADVISORIES,
  PREPAREDNESS_BADGE,
  PREPAREDNESS_DISCLAIMER,
  PREPAREDNESS_INTRO,
  stepCount,
  type PreparednessAdvisory,
} from '../preparedness';

function advisory(id: 'flood' | 'cyclone'): PreparednessAdvisory {
  const found = PREPAREDNESS_ADVISORIES.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no ${id} advisory`);
  return found;
}

/** Every sentence in one advisory, so a coverage check cannot be fooled by which field it is in. */
function allText(item: PreparednessAdvisory): string {
  return [
    item.title,
    item.summary,
    ...item.sections.flatMap((section) => [section.heading, section.risk, ...section.steps]),
  ].join(' ');
}

describe('the module covers both hazards, and only those two', () => {
  it('carries exactly a flood and a cyclone advisory', () => {
    expect(PREPAREDNESS_ADVISORIES.map((item) => item.id)).toEqual(['flood', 'cyclone']);
  });

  it('gives every advisory a title, a summary, and at least two sections of steps', () => {
    for (const item of PREPAREDNESS_ADVISORIES) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.summary.length).toBeGreaterThan(0);
      expect(item.sections.length).toBeGreaterThanOrEqual(2);
      for (const section of item.sections) {
        expect(section.heading.length).toBeGreaterThan(0);
        // `risk` before `steps` is the whole shape borrowed from the engine's ladders: a list of
        // instructions with no stated reason gets skimmed.
        expect(section.risk.length).toBeGreaterThan(0);
        expect(section.steps.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('counts its own steps, which is what the collapsed card shows', () => {
    // 3 sections x 4 steps, and 2 x 4. Asserted because the number is user-visible copy: a
    // toggle reading "Show steps (0)" would be a bug the type system cannot see.
    expect(stepCount(advisory('flood'))).toBe(12);
    expect(stepCount(advisory('cyclone'))).toBe(8);
  });
});

describe('the flood advisory covers the four risks it exists for', () => {
  const text = allText(advisory('flood')).toLowerCase();

  it.each([
    ['waterborne disease, named rather than implied', /cholera|typhoid|hepatitis|leptospirosis/],
    ['not drinking or cooking with floodwater', /do not drink, cook with/],
    ['making water safe', /boil|treatment tablets/],
    ['wound and skin infection', /cut|wound|infection/],
    ['evacuation readiness', /evacuation|shelter|waterproof bag/],
  ])('mentions %s', (_label, pattern) => {
    expect(text).toMatch(pattern);
  });

  it('says what to do about dehydration, not only that it happens', () => {
    // The risk sentence names dehydration; without ORS in the steps the card would describe a
    // danger and leave the reader with nothing to do about it.
    expect(text).toMatch(/oral rehydration/);
  });
});

describe('the cyclone advisory covers before and after', () => {
  const item = advisory('cyclone');
  const text = allText(item).toLowerCase();

  it('splits into a pre-storm and a post-storm section', () => {
    expect(item.sections.map((section) => section.heading)).toEqual([
      'Before the storm',
      'After the storm',
    ]);
  });

  it.each([
    ['medication supply', /prescription|medicine|medication/],
    ['cold-chain medicines', /insulin|refrigerat/],
    ['mobility risk for people who need help moving', /walker|wheelchair|stairs/],
    ['post-storm injury', /debris|glass|wire/],
    ['post-storm infection', /infect|cover every cut/],
  ])('mentions %s', (_label, pattern) => {
    expect(text).toMatch(pattern);
  });
});

describe('the content never claims to be something it is not', () => {
  const everything = [
    PREPAREDNESS_BADGE,
    PREPAREDNESS_DISCLAIMER,
    PREPAREDNESS_INTRO,
    ...PREPAREDNESS_ADVISORIES.map(allText),
  ].join(' ');

  it('attributes nothing to an agency the app has never contacted', () => {
    // The mock this app replaced labelled its advisories "IMD" and "CPCB". A static evacuation
    // instruction carrying a real agency's name is a materially different claim from general
    // guidance — see the header of `environment/types.ts`.
    //
    // Word-bounded, because a plain substring match on a short acronym false-positives inside
    // ordinary words. None of these six is an English word, so case-insensitive is safe for them.
    for (const agency of ['imd', 'cpcb', 'ndma', 'airnow', 'noaa', 'epa']) {
      expect(everything).not.toMatch(new RegExp(`\\b${agency}\\b`, 'i'));
    }
  });

  it('does not attribute anything to the WHO, checked case-sensitively', () => {
    // Separate from the list above, and deliberately case-*sensitive*: "who" is a pronoun, and it
    // appears legitimately four times in this content ("agree now who helps anyone…"). A
    // case-insensitive `\bwho\b` guard fails on correct copy, which is worse than no guard — it
    // trains the next person to delete the check. The attribution form is the acronym.
    expect(everything).not.toMatch(/\bWHO\b/);
    // And the guard is not vacuous: the pronoun really is present, so a case-insensitive version
    // of the assertion above would fail.
    expect(everything).toMatch(/\bwho\b/);
  });

  it('never describes present conditions, which is what would make it read as live', () => {
    // "Boil water until the supply is declared safe" is timeless guidance. "Air quality is poor
    // right now" is an observation, and this module has made none.
    const lowered = everything.toLowerCase();
    for (const phrase of ['right now', 'currently', 'today', 'this hour', 'at the moment']) {
      expect(lowered).not.toContain(phrase);
    }
  });

  it('carries no risk level, no score, and no rule id', () => {
    // The structural half of the same claim: even if the copy were perfect, a `level` field would
    // put a traffic-light pill on content with nothing to score. Checked on the objects rather
    // than the type, so adding the field without updating the type still fails.
    for (const item of PREPAREDNESS_ADVISORIES) {
      for (const field of ['level', 'score', 'rule', 'source', 'observedAt']) {
        expect(item).not.toHaveProperty(field);
      }
    }
  });

  it('states the disclaimer exactly as the card must render it', () => {
    expect(PREPAREDNESS_DISCLAIMER).toBe('General advisory — not based on live conditions');
    expect(PREPAREDNESS_BADGE).toBe('General advisory');
  });

  it('names the live cards in the section intro, so the contrast is stated not implied', () => {
    expect(PREPAREDNESS_INTRO).toMatch(/heat and air-quality cards/);
    expect(PREPAREDNESS_INTRO).toMatch(/live measurements/);
  });
});
