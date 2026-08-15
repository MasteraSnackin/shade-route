# Performance and technical excellence report

## Outcome

The current engine is correctly sized for the two corridor pilots: route and
schedule scoring is below one player interval only when performed off the main
thread, while the map-wide ground-shadow raster remains the dominant cost. The
uncertainty-aware renderer exposes certain, possible, unknown and
search-limited display channels without changing output between its generic
reference path and production fast path.

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
cell. Complexity is approximately `O(grid cells × cast offsets)`. Minimum and
maximum surface planes now separate certain from possible shade. Missing or
edge-limited rays remain unknown, and unconfirmed rays longer than 250 m use a
distinct search-limited channel rather than being shown as clear or shaded.

### Worker orchestration

Five raster planes are copied once during worker initialisation. Requests are
generation-tagged and pending work is coalesced to the latest message. A running
synchronous calculation cannot yet be interrupted. The four visual classes are
encoded in the existing RGBA frame, so the worker transfers no extra per-cell
buffer.

## Benchmark method

- Runtime: Node.js 24.14.
- Pilot: King’s Cross, 625 × 573 = 358,125 cells.
- Raster inputs: validity, legacy height, terrain, minimum surface and maximum surface.
- Routes: three, with 221, 224 and 228 prepared samples.
- Warm-up: five runs.
- Measurement: 25 runs.
- Correctness control: full-pixel FNV-1a hash and shadow percentage.
- Comparison: pre-optimisation reference path and production fast path run in
  the same process.

Run the benchmark with:

```bash
npm run benchmark:engine
```

## Results

| Workload | Result |
| --- | --- |
| Generic low-sun reference median | 133.812 ms |
| Production low-sun fast-path median | 54.896 ms |
| Paired median reduction | 59.0% |
| Production p95 | 63.431 ms |
| Output hash for both paths | `97be4a9b` |
| Shadow coverage for both paths | 78.23413612565446% |
| Nine times × three routes × eight journeys | 82.464 ms median; 87.254 ms p95 |
| Five-plane worker copy | 5,013,750 bytes; 0.346 ms median; 0.955 ms p95 |

The reference run explicitly disables both renderer fast paths. A deterministic
fixture and the full-pixel hash verify output parity. The recorded paired run is
in `docs/audit/engine-benchmark-20260815.json`. Timings vary with CPU load, so
the paired run and unchanged output are the relevant controls. These are local
Node.js engine measurements, not low-end-phone, battery or hosted-latency
claims.

The earlier `docs/audit/engine-benchmark-20260812.json` records the previous
binary-shadow implementation and is retained only as historical evidence. Its
hash and coverage are not comparable with the current four-channel renderer.

## Implemented quick win

### Early rejection of painted target cells

Overlapping cast paths repeatedly loaded validity and elevation data for target
cells that were already known to be shadowed. On sufficiently dense generic
casts, the renderer now checks its painted mask before those reads. Shorter
casts and obstacle footprints therefore eliminate redundant work for later
offsets.

A regression fixture uses overlapping casts and verifies identical output. The
full pilot hash and coverage are also unchanged.

### Search-limited absolute-elevation loop

When all absolute-elevation cells are valid and the natural cast exceeds the
250 m cap, possible-but-unconfirmed cells will necessarily be displayed as
search-limited. A specialised loop therefore establishes certain shade from
the minimum surface plane without doing unused maximum-plane work. This
recovered the initial uncertainty-rendering regression without weakening any
channel.

## Ranked findings

### Quick wins

1. **Completed — skip already-painted target work.** Exact-union regression
   fixtures verify parity; the low-sun pilot benchmark measures the combined
   production fast paths rather than attributing a separate percentage here.
2. **Completed for the dominant low-sun path — split the complete absolute-
   elevation loop and omit unused maximum-plane work.**
3. Preclassify unmodelled direction ranges in prepared route geometry rather
   than rescanning instruction text for every sample.
4. Reuse bounded scratch masks only after proving that lifecycle and concurrent
   requests cannot expose stale pixels.

### Medium efforts

1. Add cooperative/chunked cancellation. Coalescing removes queued work but
   cannot interrupt an active render or advice scan. The recorded local medians
   are 54.896 ms and 82.464 ms respectively, but device behaviour remains
   unmeasured.
2. Prototype a terrain-safe scanline or directional-horizon representation and
   compare exact shadow-edge error against the current ray caster.
3. **Completed — expose explicit search-limit and uncertainty metadata in the
   visual frame, worker protocol, map status and labelled overlay key.**
4. Tile larger grids and model provenance before adding another city or a
   UK-wide extent.

### Research bets

1. Directional horizon caches with incremental time stepping.
2. GPU/WebGL or WebGPU shadow casting with deterministic CPU parity fixtures.
3. Shared raster planes across workers using cross-origin isolation.
4. Shade-aware routing costs inside a controlled routing graph rather than
   scoring only the provider's alternatives.

## Correctness risks

- The map-wide visual stops casts at 250 m and labels unresolved cells; it still
  cannot determine what lies beyond that bound.
- The ground visual and route scorer both use minimum/maximum surface envelopes,
  but they rasterise and sample at different spatial resolutions, so their edges
  should not be presented as identical observations.
- Non-finite or partly covered height cells now become unknown and can propagate
  an unknown cast; this is fail-closed but may reduce the visually resolved area.
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
The next engineering change should be real-device tracing, followed by
cooperative cancellation if low-end-phone evidence shows that an 80–120 ms
worker task still harms interaction or battery use.
