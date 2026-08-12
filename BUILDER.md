# Builder report — functionality and reliability

## Mission outcome

The ShadeRoute engine and server surface now provide bounded, typed and
recoverable behaviour for live routing, regional heat context, offline pilot
packs and device-local evidence. No styling decisions are included in this
report.

## Implemented application capabilities

- Primary and optional fallback Valhalla routing with independent attempt windows.
- Server and client route validation against pilot bounds and requested endpoints.
- Worker-based schedule scoring and departure advice with stale-generation guards.
- Explicit walking-pace propagation through scores, saved journeys and comparisons.
- Atomic, removable offline packs that never cache `/api/*`.
- Strict device-local saved journeys, operational feedback and decision evidence.
- Neutral, cached UKHSA heat context that remains outside the scoring model.

## Reliability defects closed

### Non-object JSON crash

**Before:** `POST /api/route` parsed syntactically valid JSON and immediately read
`body.origin`. A `null` or array payload could therefore throw instead of
returning a controlled validation response.

**Fix:** parse to `unknown`, require a plain record, then validate the two points.
The API returns `INVALID_POINTS` with HTTP 400 and private headers.

### Unbounded external JSON

**Before:** the heat-context proxy used `response.json()` without an actual-byte
limit. A missing or dishonest `Content-Length` could bypass a declaration-only
check in other paths.

**Fix:** a shared stream reader counts bytes, validates UTF-8, releases locks and
returns typed expected errors. It now protects route requests, route-provider
responses and UKHSA responses.

### Live route request without a full deadline

**Before:** cancellation protected superseded requests but did not guarantee a
settled promise if a fetch implementation ignored `AbortSignal` or stalled while
reading the body.

**Fix:** `LiveRouteRequestClient` races both fetch and body parsing against a
ten-second deadline, while preserving explicit superseded, cancelled and
disposed states.

## API summary

| Route | Success | Expected failures |
| --- | --- | --- |
| `POST /api/route` | `{ areaId, routes }` | 400 invalid/outside; 413 oversized; 503 temporary routing failure |
| `GET /api/heat-context` | Narrow UKHSA context | 503 neutral unavailable context |

The route API never stores inputs and every response is private and non-cacheable.

## Verification

- Null and hostile request bodies.
- Actual-byte and declared-length limits.
- Invalid UTF-8 and unreadable streams.
- Primary timeout followed by independent fallback.
- Client cancellation and implementations that ignore abort.
- Invalid route geometry, summaries, manoeuvres and model bounds.
- Full production build, static checks and deterministic test suite.

## Remaining operational work

- Run the routing service under controlled ownership before relying on it in a
  public pilot.
- Add privacy-bounded health and latency monitoring without coordinates.
- Document incident ownership and provider service expectations.
- Keep custom routing online-only unless a routable offline graph is deliberately
  added and tested.
