# Performance and technical excellence report

## Outcome

The current engine is correctly sized for the two corridor pilots: route and
schedule scoring is below one frame budget only when performed off the main
thread, while the map-wide ground-shadow raster remains the dominant cost. One
low-risk hot-loop optimisation reduced the median full-frame cost by 10.8%
without changing a single output pixel.

## Core algorithms profiled

### Route exposure

1. Densify walking geometry at approximately eight-metre intervals.
2. Project longitude/latitude samples to British National Grid.
3. Recalculate solar position as the walker advances through the journey.
4. March a ray through the four-metre terrain/surface grid to a 250 m cap.
5. Compare minimum and maximum surface envelopes to classify shade, sun,
   uncertainty or missing coverage.
6. Aggregate one or more journeys and label route trade-offs.

Complexity is approximately `O(route samples × ray cells × journey count ×
departure slots)`, bounded by the pilot size, route count and schedule limits.

### Ground-shadow raster

The map visual projects directional offsets across every source/target grid
cell. Complexity is approximately `O(grid cells × cast offsets)`. The result is
a binary display layer, not the route model's min/max uncertainty channel.

### Worker orchestration

Five raster planes are copied once during worker initialisation. Requests are
generation-tagged and pending work is coalesced to the latest message. A running
synchronous calculation cannot yet be interrupted.

## Benchmark method

- Runtime: Node.js 24.14.
- Pilot: King’s Cross, 625 × 573 = 358,125 cells.
- Raster inputs: validity, legacy height, terrain, minimum surface and maximum surface.
- Routes: three, with 221, 224 and 228 prepared samples.
- Warm-up: five runs.
- Measurement: 25 runs.
- Correctness control: full-pixel FNV-1a hash and shadow percentage.

Run the benchmark with:

```bash
npm run benchmark:engine
```

## Results

| Workload | Result |
| --- | --- |
| Baseline low-sun shadow-frame median | 93.362 ms |
| Optimised low-sun shadow-frame median | 83.288 ms |
| Median reduction | 10.8% |
| Final measured p95 | 121.012 ms |
| Output hash before and after | `46d567aa` |
| Shadow coverage before and after | 96.11867364746945% |
| Nine times × three routes × eight journeys | 54.988 ms median; 61.009 ms p95 |
| Five-plane worker copy | 5,013,750 bytes; 0.282 ms median |

These are local engine measurements, not low-end-phone or hosted latency claims.

## Implemented quick win

### Early rejection of painted target cells

Overlapping cast paths repeatedly loaded validity and elevation data for target
cells that were already known to be shadowed. The renderer now checks its
painted mask before those reads. Shorter casts and obstacle footprints therefore
eliminate redundant work for later offsets.

A regression fixture uses overlapping casts and verifies identical output. The
full pilot hash and coverage are also unchanged.

## Ranked findings

### Quick wins

1. **Completed — skip already-painted target work.** Measured 10.8% median gain.
2. Split absolute and legacy elevation loops so current pilot frames do not
   repeatedly branch on model format.
3. Preclassify unmodelled direction ranges in prepared route geometry rather
   than rescanning instruction text for every sample.
4. Reuse bounded scratch masks only after proving that lifecycle and concurrent
   requests cannot expose stale pixels.

### Medium efforts

1. Add cooperative/chunked cancellation. Coalescing removes queued work but
   cannot interrupt an active 83 ms shadow render or 55 ms advice scan.
2. Prototype a terrain-safe scanline or directional-horizon representation and
   compare exact shadow-edge error against the current ray caster.
3. Add explicit search-limit and uncertainty metadata to the visual shadow
   frame so the map and route model communicate the same low-sun limitation.
4. Tile larger grids and model provenance before adding another city or a
   UK-wide extent.

### Research bets

1. Directional horizon caches with incremental time stepping.
2. GPU/WebGL or WebGPU shadow casting with deterministic CPU parity fixtures.
3. Shared raster planes across workers using cross-origin isolation.
4. Shade-aware routing costs inside a controlled routing graph rather than
   scoring only the provider's alternatives.

## Correctness risks

- The map-wide visual silently stops casts at 250 m; route scoring explicitly
  reports a `ray-search-limit` reason.
- The ground visual uses maximum surface heights and has no uncertain-shadow
  channel, while route scoring uses both minimum and maximum envelopes.
- A future malformed grid containing non-finite absolute values could fall back
  to the legacy height for a visual ray. Exhaustive checks found zero such valid
  cells in either current pilot pack.
- Four-metre min/max aggregation protects an uncertainty envelope but cannot
  reproduce every one-metre shadow edge.

## Maintainability controls

- Strict TypeScript interfaces at worker and route boundaries.
- Stable, bounded worker protocols with explicit grid versions.
- Bounded LRU prepared-route cache.
- Deterministic geometry, terrain and raster tests.
- Reproducible benchmark committed beside the test suite.
- Unknown daylight can never make a route score better.

## Recommendation

Do not pursue GPU rendering or a large horizon product before field calibration.
The next engineering change should make the visual disclose its low-sun search
limit, followed by cooperative cancellation if real low-end-device traces show
that an 80–120 ms worker task still harms interaction or battery use.
