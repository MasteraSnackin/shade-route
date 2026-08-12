# ShadeRoute completion plan

Status: Verified & Polished

## Product goal

Deliver a credible mobile-first prototype that helps heat-vulnerable people,
carers and frontline or outdoor workers compare walking routes by journey time
and potential direct-sun exposure without overstating model certainty.

## Completion gates

- [x] Two bundled London hospital corridors and one-to-three real route alternatives.
- [x] Arbitrary endpoints inside each bounded pilot area through a guarded routing proxy.
- [x] Time-dependent 3D ground shadows and route-section exposure states.
- [x] Repeated-journey schedules, modelled walking-pace presets and departure advice.
- [x] Explicit access warnings, data coverage, source dates and responsible-use limits.
- [x] Device-local saved journeys, operational feedback and decision-evidence export.
- [x] Explicit, verified and removable offline packs for bundled pilot journeys.
- [x] Complete the visual, functional, trust, error-handling and performance audit.
- [x] Complete public-facing README and engineering documentation.
- [x] Pass lint, type-checking, production build, deterministic tests and browser checks.
- [x] Record final evidence and mark this plan Verified & Polished.

## External evidence gates

These are deliberately not marked complete by engineering tests:

- Physical shade observations on both corridors across representative sun angles.
- Route-order accuracy and direct-sun error measured against those observations.
- Real-device offline reload and storage-pressure testing.
- Assistive-technology testing with representative users.
- Operational ownership, data-refresh policy, legal review and pilot-partner approval.

## Decision log

- Visual effects are subordinate to legibility, reduced-motion support and the needs
  of heat-vulnerable users.
- Routing, shade calculations and downloads are not presented optimistically before
  completion; safety-relevant state must be confirmed before the UI claims success.
- Missing or incomplete model data cannot improve a route's score. Unknown daylight
  is conservatively counted as potential direct sun.
- No project-wide software licence is assumed until the maintainer selects one.
