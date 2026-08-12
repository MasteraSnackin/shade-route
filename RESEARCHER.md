# Algorithmic research report

## Research question

Is ShadeRoute's current combination of alternative walking routes, a 2.5D
LiDAR-derived surface model and time-dependent ray casting an appropriate basis
for a practical two-corridor prototype, and what should replace or extend it?

## Current approach

ShadeRoute asks Valhalla for up to three pedestrian alternatives, then scores
each route independently. At roughly eight-metre intervals it recalculates the
sun as the walker advances and tests obstruction against an absolute-terrain
grid plus minimum/maximum surface elevations. Missing data is conservative and
the interface shows the route/time trade-off.

This is the right tool for the present pilot because it is explainable, bounded,
works entirely in a browser Worker and can be checked against simple geometric
fixtures. It is not yet the right basis for a claim of optimum shade, thermal
comfort or medical protection.

## Evidence review

### Dynamic exposure matters

The 2024 *Sustainable Cities and Society* study on a pedestrian network treats
solar exposure as time-dependent and explicitly considers people with differing
walking abilities. That supports ShadeRoute's decision to advance solar time
along the journey rather than score every point at one timestamp:
[Dynamic analysis of a pedestrian network](https://doi.org/10.1016/j.scs.2024.105631).

### Multi-criteria routing is viable but changes the claim

A 2026 operational routing study combines network distance, airborne land
surface temperature and pedestrian-perspective tree canopy in a weighted graph.
It reports substantial comfort-proxy gains but also a 72% distance increase in
one example. This supports showing trade-offs rather than collapsing everything
into a hidden score:
[User-Comfort Pathfinding](https://doi.org/10.3390/ijgi15070313).

ShadeRoute should not import the paper's thermal-comfort framing without local
observations. Land-surface temperature is not personal heat exposure, and Google
Street View-derived canopy would introduce currency, licensing and viewpoint
questions.

### Horizon rasters can accelerate repeated solar work

GRASS `r.sun` can calculate terrain shadows directly or consume precomputed
horizon-angle rasters, which its documentation identifies as substantially
faster for repeated calculations. It also warns that larger sampling steps can
reduce accuracy and that low sun is expensive:
[GRASS r.sun documentation](https://grass.osgeo.org/grass-stable/manuals/r.sun.html).

The method is promising for repeated daily playback, but a naive 72-direction,
16-bit horizon product for the 358,125-cell King’s Cross grid would be about
49 MiB before metadata or compression. A corridor-limited or lower-resolution
prototype must beat the current 83 ms frame without making offline packs
unreasonable.

### Image-derived shade is complementary, not a drop-in replacement

The 2024 CIKM work uses foundation-model segmentation of high-resolution
satellite imagery and integrates shade ratios into a multilayer road graph:
[Shaded Route Planning Using Active Segmentation](https://doi.org/10.1145/3627673.3679234).

This can observe some real surfaces that a dated height composite misses, but a
single image also captures one season, sun position and acquisition time. It is
better suited to independent validation or change detection than replacing a
time-dependent geometric model.

### The source data has material age variation

The Environment Agency describes its 2022 1 m DSM as a composite using surveys
from June 2000 to April 2022 and recommends the metadata catalogue to identify
the survey used at a location:
[Defra Data Services Platform — 1 m DSM](https://dsp.environment.data.gov.uk/dataset/9ba4d5ac-d596-445a-9056-dae3ddec0178).

Coverage percentage alone therefore cannot represent freshness. A per-cell or
per-tile survey epoch and change mask should become a separate evidence axis.

### Open routing is appropriate for alternatives

Valhalla is an open-source routing engine using OpenStreetMap and supports
pedestrian costing, manoeuvres and alternative routes:
[Valhalla routing overview](https://valhalla.github.io/valhalla/api/turn-by-turn/overview/).

Provider alternatives are a practical hackathon boundary, but they do not prove
that the least-exposed path in the complete walking graph was considered. A
future optimum-shade claim would require time-dependent edge costs inside a
controlled graph.

## Tier 1 — quick wins

### Completed: eliminate redundant painted-cell work

The ground-shadow renderer now skips validity and elevation reads for targets
already painted by a footprint or shorter cast. The King’s Cross median fell
from 93.362 ms to 83.288 ms with an identical full-pixel hash.

### Next: align visual and scoring uncertainty

Add a visual-frame reason when the 250 m search cap can truncate a low-sun cast,
and distinguish certain from possible shadows. This changes explanation rather
than ranking and closes a current semantic mismatch.

### Next: add survey epoch to evidence

Use the EA survey metadata index to attach a local acquisition range or tile
epoch. Do not merge freshness into geometric coverage; show both.

### Next: preclassify route instruction evidence

Prepared route geometry should carry unmodelled/indoor instruction ranges so
the scoring loop does not repeatedly run text matching for every sample.

## Tier 2 — medium efforts

### Directional horizon prototype

Build a benchmark-only horizon representation for the two corridors. Measure:

- Byte size after realistic compression.
- Full-day runtime and battery proxy.
- Shadow-edge disagreement against the absolute-elevation ray caster.
- Sensitivity at low solar altitude and pack boundaries.

Adopt it only if the stored and decoded product materially improves repeated
playback without hiding uncertainty.

### Controlled shade-aware graph

Self-host a bounded Valhalla or another open graph and attach time-bucketed
exposure to pedestrian edges. Generate a Pareto set for time and exposure rather
than one weighted route. This would allow ShadeRoute to state what search space
was considered and avoid dependence on a public fair-use endpoint.

### Provenance-aware tiles

Replace monolithic corridor files with tiles carrying validity, terrain,
surface envelope, survey epoch and processing version. Ray queries must request
the full search buffer, not merely the visible or route bounding box.

### Field-calibrated error model

Collect the protocol already defined in `validation/`, stratified by corridor,
sun altitude, azimuth, pavement side, obstacle type and season. Report point
classification, route direct-sun error and route-order regret on held-out data.
Only then fit source-specific uncertainty bounds.

## Tier 3 — research bets

### Virtual horizons and incremental time stepping

Recent work on rasterised virtual horizons suggests a matrix-friendly approach
to urban shading. The pilot should compare it against current exact fixtures,
not adopt it from headline speed alone:
[Virtual Horizon Method](https://doi.org/10.26868/25222708.2025.1302).

### GPU casting inside the map renderer

MapLibre permits custom 3D layers that share the depth buffer:
[CustomLayerInterface](https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/).
A GPU version could render shadows directly, but deterministic parity,
context-loss recovery, device support and an accessible non-map explanation are
prerequisites.

### Observed thermal and canopy layers

Thermal imagery, canopy segmentation and current street imagery could inform
change detection or a separately labelled comfort layer. They must not be
presented as direct human heat exposure without measurement and governance.

### Shared-memory raster execution

Shared raster planes could reduce copies across main, scoring and shadow workers,
but require cross-origin isolation and introduce deployment and compatibility
cost. Current measured copy time is only 0.282 ms median, so this is not a
priority.

## Recommended sequence

1. Field-calibrate the current explanation and ranking.
2. Add survey freshness and align visual/search-limit uncertainty.
3. Benchmark a corridor-sized horizon representation.
4. Add cooperative cancellation if low-end devices show a problem.
5. Prototype a controlled Pareto routing graph only after the model evidence is
   credible.

The present 2.5D ray caster should remain the reference implementation until a
candidate beats it on speed, pack size and measured error rather than speed alone.
