# Feature documentation template

Every doc in `docs/features/` should follow this structure. Copy the headings below; every claim
under every heading must be honest to the validation ladder (**Built / Unit tested / Integration
tested / Device validated / Real-world validated / Mock-demo / Planned / Blocked**) and must trace to
a file in this repo — no invented dataset, government API, accuracy figure, false-positive rate, or
battery figure.

```markdown
# <Feature name>

## Feature
One-sentence description of what this is.

## Objective
What user or PS requirement this feature serves, and why it exists.

## Problem
What gap or risk this feature closes. Reference the PS/PRD section if applicable.

## Architecture
How this feature fits the rest of the system — which providers/modules it touches, what depends on
it, what it depends on. Link `docs/architecture/overview.md` where relevant.

## Implementation
The approach taken, and why (link an ADR under `docs/decisions/` if one exists for this feature).

## Files
The concrete file paths that implement this feature.

## Data Flow
Where the data comes from, how it is transformed, where it ends up. Note anything that leaves the
device.

## Tests
What is tested, at what level (see `docs/testing/validation-levels.md`), and where the test files
live.

## Device Validation
Has this run on a real device? If yes, which device, when, what was observed. If no, say so plainly
— do not imply validation that has not happened.

## Known Limitations
What this feature does not do yet, and any unverified assumption (e.g. platform-version quirks).

## Security
Permissions required, what is read/write, anything that could be a security concern.

## Privacy
What data this feature touches, whether it is transmitted or stored, and how (link
`docs/security/privacy-architecture.md`).

## Future Improvements
What the roadmap has planned for this feature (link `docs/ROADMAP.md` milestones where applicable).

## Status
One line using the ladder, e.g. "Built · Unit tested · Integration tested — not device validated."
```
