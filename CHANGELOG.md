# Changelog

All notable changes to ShadeRoute are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). This project
has not yet published a stable release.

## [Unreleased]

### Added

- Mobile-first route comparison for the Waterloo–St Thomas’ and King’s
  Cross–UCLH pilot areas.
- Time-dependent clear-sky shade estimates with visible model uncertainty and
  missing coverage.
- Device-local journey, evidence and offline-pilot workflows.
- Pinned Node.js/npm toolchain and deterministic verification commands.
- Least-privilege CI with immutable action revisions and grouped dependency
  updates for npm and GitHub Actions.
- Issue forms, pull-request guidance, contribution, support, security and
  conduct policies.
- Explicit third-party data and service attribution guidance, kept separate
  from the unresolved software-licence decision.
- Deterministic SHA-256 release manifest for the dependency lock, model sources
  and runtime pilot data.
- Release-bound, model-first fixed-point and complete-walk validation schemas,
  analysers and empty evidence templates; no observations are claimed.
- Controlled local Valhalla profile, fixed synthetic pilot checks and a bounded
  experimental Pareto path-search foundation for future shade-aware graphs.

### Changed

- Updated React, Vinext, Vite and Cloudflare development tooling to compatible
  patched releases, and removed the disabled, unreferenced D1/Drizzle example
  scaffold. The complete locked dependency audit is clear.
- Ground-shadow rendering now distinguishes certain, possible, unknown and
  search-limited areas, with low-sun and model-limit explanations.
- Route labels reserve “Least direct sun” for sensitivity-separated evidence;
  overlapping alternatives are described as the lowest displayed estimate.
- Custom routing accepts a best-effort “avoid known steps” preference and
  invalidates matching routes when that preference changes; it does not claim
  step-free access.

### Limitations

- No published physical field calibration.
- No UK-wide model or routing coverage.
- No production service-level commitment.

These changes are planned for `v0.1.0`. See [RELEASE.md](RELEASE.md) for the
complete pre-release limitations and reproduction procedure.
