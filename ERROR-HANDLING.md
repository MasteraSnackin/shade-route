# Error handling — ShadeRoute

## Purpose

ShadeRoute handles journey locations and safety-adjacent model outputs. Failures
must therefore be bounded, explicit and recoverable without presenting stale or
incomplete calculations as current. This document defines the implemented error
contract for the browser, Web Workers and Worker API.

## Principles

1. **Validate before work.** Reject malformed coordinates, payloads, grid data,
   routes and local records at the boundary.
2. **Use typed expected errors.** Validation, cancellation, timeout and temporary
   provider failure are normal control states, not programming crashes.
3. **Fail closed.** An unknown route, grid or score cannot become a recommendation.
4. **Preserve the last safe state only when labelled.** A stale UKHSA record is
   explicitly marked stale; an older route calculation is never shown as current.
5. **Bound external work.** Requests, responses, coordinates, instructions, local
   records, cache entries and execution time all have limits.
6. **Give a next action.** User messages explain whether to retry, change input or
   use a bundled pilot journey.
7. **Do not leak context.** API errors omit coordinates, upstream payloads and
   internal stack details, and route responses are private and non-cacheable.
8. **Clean up.** Abort listeners, timers, workers, blob URLs, geolocation watches
   and stream locks are released deterministically.

## Error taxonomy

| Category | Type or contract | Retryable | User treatment |
| --- | --- | --- | --- |
| Invalid route request | `RouteApiErrorCode` with HTTP 400 | No | Correct the points or pilot |
| Oversized route request | `REQUEST_TOO_LARGE`, HTTP 413 | No | Choose the two points again |
| Routing unavailable | `ROUTING_UNAVAILABLE`, HTTP 503 | Yes | Retry or use bundled routes |
| Live-route timeout | `LiveRouteRequestError` / `REQUEST_TIMEOUT` | Yes | Check connection, retry or use pilot |
| Superseded request | `LiveRouteRequestCancelledError` | Not applicable | Silent; newer intent owns the UI |
| Invalid upstream route | `INVALID_RESPONSE` | No for that response | Reject; never score it |
| Heat context unavailable | Neutral `503` payload | Later | Show source link; never alter score |
| Scoring superseded | `RouteScoringCancelledError` | Not applicable | Silent; retain no stale result |
| Incomplete grid/model | Expected model error | After data change | Show unavailable/limited state |
| Local storage unavailable | Actionable `Error` message | Environment-dependent | Explain nothing changed |
| Unknown local schema | Parse failure without overwrite | No automatic retry | Ask user to export/clear deliberately |
| Offline-pack verification failure | Worker result with message | Yes | Retain a previous pack during failed replacement; remove a corrupt active pack |

## API error contract

### Route API

Error responses have this stable shape:

```json
{
  "error": "Human-readable, non-blaming message",
  "code": "ROUTING_UNAVAILABLE",
  "retryable": true
}
```

Supported codes:

- `INVALID_REQUEST`
- `REQUEST_TOO_LARGE`
- `INVALID_POINTS`
- `OUTSIDE_PILOT_AREA`
- `ROUTE_BUSY` (`429`, retryable, with `Retry-After`)
- `ROUTING_UNAVAILABLE`

Every response includes `Cache-Control: private, no-store`, `Pragma: no-cache`
and `X-Content-Type-Options: nosniff`.

### Bounded JSON

`readBoundedJson` reads a `Request` or `Response` stream without trusting
`Content-Length`. It counts actual bytes, rejects invalid UTF-8, cancels an
oversized stream and releases the reader lock. Expected transport failures are
represented by `BoundedJsonError`:

```ts
type BoundedJsonErrorCode =
  | "empty_body"
  | "invalid_json"
  | "payload_too_large"
  | "unreadable_body";
```

The route request limit is 4 KiB, route-provider response limit is 1.5 MiB and
UKHSA response limit is 256 KiB.

## Browser request handling

`LiveRouteRequestClient` owns exactly one current request:

- Starting another request cancels the predecessor as `superseded`.
- A ten-second client deadline covers both response headers and body parsing.
- The deadline still resolves the caller if a test or provider implementation
  ignores `AbortSignal`.
- A monotonically increasing generation rejects late responses.
- Errors retain a stable code, retryability and internal `cause` without exposing
  the cause to the user.
- `dispose()` prevents use after application teardown.

Cancellation is not announced as failure when it represents newer user intent.
Timeout and network failures are announced in the existing alert region and give
the bundled pilot as a recovery route.

## Upstream fallback and degradation

### Walking routes

The server runs each configured Valhalla endpoint with an independent 3.5-second
attempt inside an eight-second total deadline. A hanging or malformed primary
does not consume the fallback's entire budget. Header fetches and bounded body
reads are explicitly raced against the attempt signal, so the deadline still
settles if an upstream implementation ignores abort. The server accepts only
HTTPS endpoints, except loopback HTTP in local development.

An unknown access preference fails with typed `INVALID_ACCESS_PREFERENCE` and
HTTP 400 before any upstream request. The supported avoid-steps preference is
best effort over mapped step data and never changes the product's unconfirmed
step-free disclosure.

A stateful cross-request circuit breaker is deliberately not used in this
prototype: it would be process-local, inconsistent across Worker isolates and
could suppress a recovered public service. Bounded independent attempts provide
deterministic degradation without shared mutable infrastructure.

### UKHSA context

The heat proxy uses a ten-minute fresh cache and a one-hour stale window. A stale
record is labelled; if no safe record exists, the route returns a neutral
unavailable payload. UKHSA context is informational and cannot change route
scoring, so provider failure cannot corrupt a routing decision.

### Web Workers

Scoring and shadow clients initialise grids by version, send generation-tagged
requests and ignore responses from replaced work. Worker construction, runtime
or message failures cause pending requests to reject. A deterministic synchronous
calculation path keeps the pilot usable where Worker support is unavailable.

### Offline pilot packs

Offline protocol v2 binds the selected data and generated application files to
an exact byte-length and SHA-256 manifest. The service worker validates each
download before staging, revalidates the complete staging and final caches, and
stores the canonical manifest beside the ready pack. Later readiness checks
re-hash the saved responses. A failed replacement never removes the preceding
ready pack; corruption found in a currently ready pack removes that cache and
clears the browser's readiness record. Online route and heat APIs are never
included in or served from these caches.

## Validation layers

### Route server

- Request is a JSON object with finite coordinate pairs.
- Both points lie inside one supported pilot bounding box.
- Response size is bounded before decoding.
- Polyline decoding stops before coordinate 10,001.
- Distance and duration are finite and positive.
- Start/end geometry matches the requested points.
- The complete route lies inside the modelled bounds.
- Geometry length agrees with the reported summary.
- Manoeuvre indexes lie inside the route geometry.
- Near-identical alternatives are removed; at most three remain.

### Route client

The client validates the area identity, route count, identifier uniqueness,
coordinate and direction limits, endpoint match, bounds and summaries again.
This protects the UI even if the API contract regresses.

### Local and exported data

Saved journeys, feedback, offline status and decision evidence use strict,
versioned schemas. Unknown future versions are not silently overwritten. Counts
and byte sizes are capped, fields are normalised and untrusted JSON parsers
return a failure state rather than throwing through the UI.

## User-interface states

| State | Implementation rule |
| --- | --- |
| Loading | Immediate disabled/busy label and restrained skeleton where layout is not established |
| Empty | Explain what is absent and give a relevant action; absence of partial OSM records is not treated as real-world absence |
| Error | Use `role="alert"` only for actionable failure; preserve the user's input |
| Success | Use a restrained status announcement after confirmed save, export or offline verification |
| Limited confidence | Show coverage, source age and reasons beside the decision |
| Superseded | Do not announce; the newer action owns feedback |

Optimistic UI is suitable for reversible visual selection, such as choosing a
route card. It is not used for routing, shade calculations, downloads or offline
verification, because claiming success before confirmation would be misleading.

## Logging and diagnostics

- Expected validation and cancellation paths do not spam logs.
- Browser diagnostics may record a generic developer message after the UI has
  degraded safely; they must not include journey coordinates or free-text notes.
- API responses never contain upstream bodies or stack traces.
- A hosted pilot should add privacy-bounded counts and latency measurements for
  timeouts, fallbacks, invalid responses and worker failures.

There is currently no central trace or incident system. This is an operational
readiness gate, not a hidden capability.

## Testing strategy

Deterministic tests cover:

- Null, array, malformed, invalid-UTF-8 and oversized JSON.
- Locked, failing and incorrectly declared streams.
- Per-endpoint timeout, total timeout, fallback and client cancellation.
- A fetch implementation that ignores abort while headers or body remain pending.
- Invalid endpoints, route bounds, summaries, manoeuvres and coordinate counts.
- Stale result suppression in routing and scoring clients.
- Heat parsing, cache response contracts and bounded provider payloads.
- Offline byte/hash verification, atomic promotion, corruption removal,
  selected-area isolation and previous-pack retention.
- Strict evidence and local-storage schemas.

Unexpected defects should receive a minimal regression test at the narrowest
boundary where the invalid state first became observable.

## Review checklist

Before merging a new asynchronous or external-data feature, confirm:

- [ ] Inputs and outputs have explicit size and shape bounds.
- [ ] Expected failures have a typed code or result.
- [ ] Timeout and cancellation are distinct.
- [ ] A late response cannot replace newer state.
- [ ] Cleanup runs on success, failure, cancellation and component teardown.
- [ ] The user message says what happened and what to do next.
- [ ] No message or log reveals coordinates, health inference or free-text notes.
- [ ] Retry is bounded and used only for a plausibly transient failure.
- [ ] Degraded data is labelled and cannot improve a recommendation.
- [ ] Tests cover the hostile and partial-response paths, not only success.
