# ShadeRoute v0.1 pilot pre-release

This repository is preparing a reproducible `v0.1.0` pilot baseline. It is a
pre-release for evaluation in two bounded London pilot areas, not a production
service or evidence of field validation.

## Reproducible baseline

The baseline pins Node.js `24.14.0` and npm `11.9.0`. The lockfile, complete
deployed application inventory, model sources and every runtime file under
`public/data/` are SHA-256 fingerprinted in
[`release-manifest.json`](release-manifest.json). The application inventory
covers the app and API, client components, libraries, workers, service worker
and build/runtime configuration, including the controlled Valhalla Compose
definition, plus every deployed public asset outside the separately
fingerprinted data packs. The manifest records model version
`prototype-2026-08-15` and data-pack version `pilot-data-2026-08-15-v4`. It
also fingerprints the fixed-point and route-walk validation protocols
separately from any future evidence rows.

From a clean checkout:

```bash
nvm install
nvm use
npm ci --ignore-scripts --no-audit --no-fund
npm run release:verify
```

`npm run release:check` fails if a locked dependency, executable source, listed
model source or pilot data artefact differs from the checked-in manifest. After
an intended change, run `npm run release:manifest`, review every version and
hash change, then run the checks again. A model behaviour change requires a
deliberate model version decision; regenerating the hashes alone is not
sufficient review. The content manifest deliberately does not claim an immutable
Git commit. Record the exact commit only after the reviewed tree is committed,
as required by the release gate below.

## Dependency audit position

On 15 August 2026, `npm audit --audit-level=moderate` and
`npm audit --omit=dev --audit-level=high` both reported zero vulnerabilities in
the locked tree. The unused D1/Drizzle example scaffold was removed; D1 remains
disabled in `.openai/hosting.json`.

Re-run both audits before release and treat this dated result as a recorded
snapshot, not a continuing assurance. Dependabot is configured to surface later
compatible fixes.

## Pre-release limitations

- ShadeRoute is an uncalibrated clear-sky geometric model. It has no published
  physical field-calibration results and must not be represented as validated.
- It estimates potential direct sun and shade. It does not measure heat,
  temperature, cloud, air quality, radiant exposure or current street conditions.
- Coverage is limited to the Waterloo–St Thomas’ and King’s Cross–UCLH pilot
  areas. The checked-in packs do not provide UK-wide routing or shade coverage.
- Environment Agency LiDAR inputs combine surveys from 2000–2022. Buildings,
  trees, awnings, scaffolding, vehicles and other obstacles can be missing,
  changed or simplified.
- Route, surface, crossing and access information can be incomplete or stale.
  No route is certified step-free, open, accessible or safe.
- Compared routes are bounded alternatives returned by the configured router;
  they are not proof of a globally optimal shade-aware route.
- External routing and context services can be unavailable or rate-limited.
  This pre-release has no availability, support or incident-response SLA.
- The application is planning support only. It must not replace emergency,
  medical, employer, local-authority or on-site safety guidance.

## Release gate

Before creating a GitHub pre-release:

1. Confirm the working tree contains only reviewed release changes.
2. Run the complete command sequence above on the pinned toolchain.
3. Confirm `release-manifest.json` is current and the version fields match the
   intended model and data pack.
4. Record the exact commit in the GitHub release notes; do not put a moving
   branch name in place of the commit.
5. Label the GitHub release as a pre-release and repeat the limitations above.
6. Attach no claims of accuracy, safety or field performance unless the
   underlying observations and method are published and reviewable.
7. Record the owner's software-licence decision. If no `LICENSE` is added, make
   clear that public visibility does not grant reuse or redistribution rights.
8. Review [DATA-LICENSING.md](DATA-LICENSING.md) against the exact data and live
   providers included in the release.
9. For a hosted pilot, close every release blocker in
   [ops/PILOT-RUNBOOK.md](ops/PILOT-RUNBOOK.md).

This file does not select or grant a software licence. Dataset licences and
attribution duties remain separate from any future software-licence decision.

## Version and tag procedure

For each later release:

1. Choose the version using Semantic Versioning and update `package.json`,
   `package-lock.json`, this file and the changelog together.
2. Update any deliberately changed model/data-pack versions, regenerate the
   manifest and review the hashes rather than accepting them mechanically.
3. Run `npm run release:verify` from a clean checkout of the intended commit.
4. Create an annotated `v<version>` tag on that exact commit and create the
   GitHub release from the immutable tag, not from a moving branch.
5. Do not move or reuse a published tag. Correct a faulty release with a new
   patch version and explain the change in `CHANGELOG.md`.
