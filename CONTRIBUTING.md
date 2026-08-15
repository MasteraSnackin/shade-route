# Contributing to ShadeRoute

ShadeRoute is a safety-adjacent, uncalibrated prototype. Contributions must
improve usefulness without overstating route safety, accessibility, medical
benefit or model accuracy.

## Before starting

1. Search [existing issues](https://github.com/MasteraSnackin/shade-route/issues).
2. Open an issue for material product, data-model or architecture changes.
3. Describe the affected pilot area, user need, safety implications and how the
   result can be tested.
4. Do not include personal, patient, employment or precise journey-history data.

Small documentation corrections and narrowly scoped test fixes may go directly
to a pull request.

## Local workflow

Use the pinned toolchain and checked-in dependency lock:

```bash
nvm install
nvm use
npm ci --ignore-scripts --no-audit --no-fund
npm run release:check
npm run lint
npm run typecheck
npm test
```

Use `npm run test:unit` for a fast local test pass when a production build is
not required. Run `npm run release:verify` before requesting review.

## Engineering requirements

- Preserve explicit unknown, unavailable, stale and uncertain states.
- Keep route recommendations separate from heat-health and operational context.
- Treat all client and provider payloads as untrusted and enforce time, byte,
  coordinate, cardinality and schema bounds at server boundaries.
- Keep provider credentials server-side. Do not commit `.env.local`, tokens,
  user journeys or exported field observations.
- Add deterministic tests for parsing, geometry, scoring, privacy, error and
  accessibility behaviour affected by the change.
- Retain keyboard operation, visible focus, meaningful labels and a usable
  non-WebGL decision surface.
- Do not add invented observations or describe a route as safe, step-free,
  cool, validated or medically protective without published evidence.

## Data and model changes

State the source, licence, retrieval date, spatial/temporal coverage, processing
method and known limitations for every new dataset. Update
[DATA-LICENSING.md](DATA-LICENSING.md), runtime attribution and provenance
metadata together. Never regenerate `release-manifest.json` merely to conceal
an unexplained source, model or pack change.

Physical observations require the protocol in
[`validation/README.md`](validation/README.md), review for accidental personal
data and an explicit maintainer decision before publication.

## Pull requests

Keep commits focused. Complete the pull-request template and include:

- the user-visible outcome and affected pilot areas;
- tests and manual checks performed;
- screenshots or recordings for interface changes;
- data provenance and licence changes;
- safety, privacy, accessibility and rollback considerations; and
- limitations that remain after the change.

All contributions must follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). The
repository has no project-wide software licence; contribution does not imply
that one has been selected.
