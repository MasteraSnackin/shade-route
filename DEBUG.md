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

All three hypotheses were confirmed. They were fixed at their originating
boundaries without redesigning unrelated code.

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
- Deterministic regression tests in `tests/`.

## Areas to monitor

- Provider latency and fallback frequency without logging coordinates.
- Service-worker update behaviour under storage pressure on real devices.
- Browser Worker failures and synchronous-fallback frequency.
- Route-order changes after physical shade calibration.

No screenshots are presented as evidence of model accuracy; they establish only
the rendered and interactive application state.
