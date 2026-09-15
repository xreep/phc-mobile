/**
 * Static flood and cyclone preparedness advisories (PRD §4, disaster-response persona).
 *
 * ## Why this is a separate module rather than a seventh risk category
 * `RiskCategoryKey` is a closed union of the six categories PRD §7.2.2 specifies, and every one
 * of them is a *verdict on a measurement*: a heat index, an SpO₂ reading, a motion window. Adding
 * `'flood'` to that union would put a green/amber/red pill on content that has no input to score,
 * which is the one thing the engine's colours are not allowed to mean. It would also break the
 * `RiskCategory` intersection that `CategoryAssessment` and `RiskCard` both depend on.
 *
 * So this content is deliberately outside the engine. It carries no level, no score, and no rule
 * id, and nothing here reaches `assessRisk`. What it borrows from `rules/heat.ts` and
 * `rules/respiratory.ts` is only their *shape* — a one-sentence statement of the risk followed by
 * imperative steps, most urgent first — because that shape is what makes a recommendation
 * readable, and it is worth being consistent about across the app.
 *
 * ## Why nothing here is attributed to an agency
 * `environment/types.ts` sets the rule this module follows: an advisory's provenance is "never a
 * government agency the app has not contacted", because the mock this app replaced labelled its
 * cards "IMD" and "CPCB". A flood advisory is exactly the case where that matters most — an
 * evacuation instruction carrying a real agency's name is a different kind of claim from general
 * guidance, and this app has no feed from IMD, NDMA, or anyone else. The content below is
 * therefore presented as what it is: general preparedness guidance, not a warning issued for a
 * place at a time. `PREPAREDNESS_DISCLAIMER` is the label that says so, and it is not optional —
 * see `components/preparedness-card.tsx`.
 *
 * ## What "static" costs, and why it is still worth shipping
 * Because none of it is conditional, all of it is visible whether or not there is a flood, and
 * whether or not the device has ever reached the network. That second property is the point for
 * the persona: the guidance is most needed exactly when the towers are down, and a card that
 * needs a fetch to render is a card that is blank during a cyclone. Live hazard feeds would be a
 * genuine improvement and are not built — that is roadmap, and `docs/deployment.md` is where it
 * is described as such.
 */

/** The two hazards covered. A closed union so the screen cannot render a third by accident. */
export type PreparednessHazard = 'flood' | 'cyclone';

/**
 * One block of an advisory.
 *
 * `risk` then `steps` mirrors a `Recommendation`'s `headline` then `actions`: say what the danger
 * is, then say what to do about it. A list of instructions with no stated reason gets skimmed.
 */
export type AdvisorySection = {
  readonly heading: string;
  /** The hazard in one or two sentences — the analogue of a rung's `headline`. */
  readonly risk: string;
  /** Imperative steps, most urgent first — the analogue of a rung's `actions`. */
  readonly steps: readonly string[];
};

export type PreparednessAdvisory = {
  readonly id: PreparednessHazard;
  readonly title: string;
  /** One line under the title, before the sections are expanded. */
  readonly summary: string;
  readonly sections: readonly AdvisorySection[];
};

/** Neutral chip on each card. Never a risk level — there is no measurement to level. */
export const PREPAREDNESS_BADGE = 'General advisory';

/**
 * The disclaimer, verbatim on every card.
 *
 * It sits directly beneath the title rather than in a footnote, because the failure it prevents
 * is a reader glancing at this card immediately after the live heat and air-quality cards above
 * it and carrying the assumption of liveness across. Those cards report a measurement taken for
 * their coordinates minutes ago; this one would read identically during a drought.
 */
export const PREPAREDNESS_DISCLAIMER = 'General advisory — not based on live conditions';

/** Section heading on the Environment screen, matching "Active advisories" above it. */
export const PREPAREDNESS_HEADING = 'Preparedness guides';

/**
 * The contrast, stated once for the section.
 *
 * The per-card disclaimer says what these cards are *not*; this says what they are *instead*, and
 * names the live cards explicitly so the difference is a stated fact rather than something the
 * reader has to infer from a lighter shade of chip.
 */
export const PREPAREDNESS_INTRO =
  'Fixed reference text, always shown. Nothing below is triggered by a reading, a forecast, or a warning from any agency — unlike the heat and air-quality cards above, which come from live measurements for your location.';

const FLOOD: PreparednessAdvisory = {
  id: 'flood',
  title: 'Flood',
  summary: 'Health risks during and after flooding, and what to do about each.',
  sections: [
    {
      heading: 'Drinking water and food',
      risk:
        'Floodwater carries sewage, so it spreads cholera, typhoid, and hepatitis A. The dehydration that follows diarrhoea is what turns those into emergencies, fastest in small children and older adults.',
      steps: [
        'Do not drink, cook with, or brush your teeth with floodwater, or with water from a well that has flooded.',
        'Boil drinking water for one full minute, or use treatment tablets, until the supply is declared safe.',
        'Throw away any food that touched floodwater, including sealed packets.',
        'Start oral rehydration salts at the first loose stool, and get medical help if it does not settle.',
      ],
    },
    {
      heading: 'Cuts and skin contact',
      risk:
        'A small cut that touches floodwater can become a serious infection within a day. Standing water also carries leptospirosis, which gets in through broken skin rather than by being swallowed.',
      steps: [
        'Cover every cut and sore with a waterproof dressing before you wade.',
        'Wash any skin that touched floodwater with clean water and soap as soon as you can.',
        'Wear closed shoes — most flood injuries come from debris you cannot see under the water.',
        'Get medical help for a wound that reddens, swells, smells, or comes with a fever.',
      ],
    },
    {
      heading: 'If you may have to leave',
      risk:
        'Evacuation happens at short notice, and medicines are the thing most often left behind. Anyone who needs help to walk needs a plan made before the water rises, not while it is rising.',
      steps: [
        'Keep a week of medicines, a written list of doses, and your prescriptions together in one waterproof bag.',
        'Add ID, a torch, a charged power bank, and drinking water to the same bag.',
        'Agree now who helps anyone who cannot walk or manage stairs unaided.',
        'Learn the route to the nearest shelter on higher ground before you need it.',
      ],
    },
  ],
};

const CYCLONE: PreparednessAdvisory = {
  id: 'cyclone',
  title: 'Cyclone',
  summary: 'What to prepare before landfall, and what causes injuries afterwards.',
  sections: [
    {
      heading: 'Before the storm',
      risk:
        'Pharmacies, clinics, and mains power can all be out for days after landfall. Regular medication is the supply that runs out first — for blood pressure, diabetes, heart conditions, or epilepsy, missed doses are the risk, not the storm.',
      steps: [
        'Refill every regular prescription to at least a week ahead while shops are still open.',
        'Ask your pharmacist how long any cold-chain medicine, such as insulin, keeps without refrigeration.',
        'Charge a power bank for anything medical that needs electricity.',
        'Move anyone who needs a walker, a wheelchair, or help on stairs to a ground floor or a shelter early, while moving them is still easy.',
      ],
    },
    {
      heading: 'After the storm',
      risk:
        'Most cyclone injuries happen after the wind drops, from debris, broken glass, and fallen power lines. In the heat and damp that follow, cuts get infected quickly and water supplies stay unsafe long after the flooding looks gone.',
      steps: [
        'Treat every fallen wire as live and keep well away from it.',
        'Wear closed shoes and gloves before clearing anything.',
        'Clean and cover every cut the same day, however small it looks.',
        'Keep boiling or treating drinking water until the supply is declared safe.',
      ],
    },
  ],
};

/**
 * Both advisories, in the order they render.
 *
 * Flood first because it is the longer-lived hazard of the two: a cyclone's guidance is spent
 * within a few days of landfall, while the flood section stays relevant for as long as the water
 * and the wounds do.
 */
export const PREPAREDNESS_ADVISORIES: readonly PreparednessAdvisory[] = [FLOOD, CYCLONE];

/** Total number of steps in one advisory — shown on the collapsed card so the size is visible. */
export function stepCount(advisory: PreparednessAdvisory): number {
  return advisory.sections.reduce((total, section) => total + section.steps.length, 0);
}
