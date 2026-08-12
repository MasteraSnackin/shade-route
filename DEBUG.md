# Debug report — ShadeRoute completion pass

## Scope

The completion pass examined application startup, local data loading, custom
routing, concurrent scoring, responsive layout and the visible success/error
states. The defects below were consistent and reproducible in the local
environment rather than intermittent provider behaviour.

## Ranked hypotheses

1. **Boundary validation defect:** syntactically valid but structurally invalid
   route JSON could escape the request parser.
2. **Selector leakage:** an unscoped element selector could make an embedded
   component inherit page-level footer layout.
3. **Unbounded asynchronous work:** a network implementation that ignored abort
   could leave a live-route action pending indefinitely.
4. **Server/client cancellation confusion:** upstream route and heat timeouts
   aborted a signal but did not force a non-compliant promise to settle.
5. **Hidden input-method dependency:** exact map-point selection was available
   to pointer users but had no equivalent keyboard confirmation action.
6. **False empty state:** a failed local-place data request was presented as an
   ordinary search with no matches.
7. **Weak offline verification:** a successful HTTP response was treated as a
   verified file without checking its bytes.

All seven hypotheses were confirmed. They were fixed at their originating
boundaries without redesigning unrelated code.

## History and parallel isolation

The history scan found the original pilot commit (`37f7fcd`) followed by the
first quality pass (`a5ab801`). The defects were therefore checked against the
original pilot surface rather than attributed to an undocumented intermediate
change. Independent agents investigated server deadlines, visual containment,
offline integrity and requirement coverage in parallel. They used disjoint file
ownership and focused test commands in the shared worktree; no speculative
branch was merged.

## Defect 1 — route API crash on `null`

### Expected

`POST /api/route` should return a private HTTP 400 response for every malformed
or structurally invalid request body.

### Actual

The previous parser accepted `null` as valid JSON and then dereferenced
`body.origin`, causing an uncaught `TypeError`.

### Execution trace

```text
POST body "null"
  -> JSON parse succeeds
  -> body assumed to be an object
  -> body.origin access
  -> TypeError before controlled validation response
```

### Root cause and fix

The transport parser and domain validator were conflated. The route now parses
to `unknown`, checks for a plain record and only then reads `origin` and
`destination`. Typed API errors distinguish invalid, oversized, outside-pilot
and temporary-provider cases.

### Preventive evidence

Regression tests cover `null`, arrays, invalid UTF-8, empty bodies, oversized
streams and valid objects with invalid points.

## Defect 2 — nested playback footer inherited page-footer CSS

### Expected

The footer inside the shade time explorer should remain a small component-level
layout. Only the direct footer of the site shell should receive page attribution
spacing and typography.

### Actual

Global `footer` selectors matched both elements, leaking the page-footer rules
into the time explorer.

### Root cause and fix

The selector described an element type rather than the intended ownership
boundary. Every page-level rule is now scoped to `.site-shell > footer`. A
source-level regression test checks that the generic selector does not return.

## Defect 3 — stalled route request could remain unresolved

### Expected

A custom route lookup should resolve as success, typed failure or cancellation
within a bounded time, including while the response body is being read.

### Actual

The client depended on provider compliance with `AbortSignal`. A non-compliant
test/provider implementation could keep either fetch or `response.json()` pending.

### Root cause and fix

Abort was treated as the deadline rather than one cancellation mechanism. The
client now races both stages against an explicit ten-second deadline and maps
the result to `REQUEST_TIMEOUT`. New user intent still maps to a silent
`superseded` cancellation.

## Defect 4 — upstream deadlines depended on provider cooperation

### Expected

The routing fallback and heat-context proxy should settle within their stated
server deadlines even if an upstream fetch or response body ignores abort.

### Actual

Timers called `AbortController.abort()`, but the routes still directly awaited
the supplied promises. Hostile tests with a never-settling fetch and a
never-ending response stream remained pending.

### Root cause and fix

Passing a signal was mistaken for enforcing a deadline. `raceWithAbort` now
races both headers and bounded body parsing against the active signal. A timed
out route attempt yields to the independent fallback; a timed out heat request
degrades to labelled stale or unavailable context. Tests deliberately use work
that never reads the signal.

## Defect 5 — map-point selection was pointer-only

MapLibre exposed keyboard panning, but selecting the panned position still
required a map click. While point-picking is active, the map now shows a centre
marker, keyboard instructions and a 44 px **Use map centre** action. The action
passes through the same parent bounds check as pointer and geolocation input.

## Defect 6 — local place-load failure looked like no results

The place combobox caught every fetch or parse failure and replaced the local
records with an empty array. It now distinguishes loading, available and error
states, retains the two bundled pilot landmarks, cancels stale area requests and
offers a bounded retry. A genuine zero-match query remains a separate state.

## Defect 7 — offline verification checked presence, not integrity

The service worker previously accepted any non-opaque HTTP 200 response. A
truncated or same-length-corrupt file could therefore be promoted while the UI
said **Verified on this device**. Offline protocol v2 pins exact byte lengths
and SHA-256 digests, checks every staged and promoted response, stores the
canonical manifest with the cache and re-hashes ready caches on later checks.
A failed replacement preserves the previous pack; a corrupt ready cache is
removed and cannot remain labelled ready.

## Related improvements

- Shared bounded JSON streaming for all external JSON paths.
- Corrected heat-context heading hierarchy.
- Keyboard skip link to the focusable journey planner.
- Restrained loading skeleton with reduced-motion support.
- Minimum touch targets for dense planning and playback controls.

## Validation artefacts

- `docs/audit/before-1440.png` — desktop baseline.
- `docs/audit/before-mobile-390.png` — mobile baseline.
- `docs/audit/after-desktop.png` — final desktop view.
- `docs/audit/after-mobile-390.png` — final mobile view.
- `docs/audit/map-centre-keyboard.png` — map state after the mobile
  keyboard-centre selection flow.
- `docs/audit/shade-time-movement.mp4` — six-second, application-only recording
  of the time control and model output from 05:41 to 11:11 in 30-minute steps.
- Deterministic regression tests in `tests/`.

The recording contains only the local ShadeRoute viewport. It demonstrates that
the time control updates the visible model state; it does not demonstrate model
accuracy. The heat-context unavailable state visible in the audit screenshots
is the non-blaming external-service error treatment.

## Areas to monitor

- Provider latency and fallback frequency without logging coordinates.
- Service-worker update behaviour under storage pressure on real devices.
- Browser Worker failures and synchronous-fallback frequency.
- Route-order changes after physical shade calibration.

No screenshots are presented as evidence of model accuracy; they establish only
the rendered and interactive application state.
