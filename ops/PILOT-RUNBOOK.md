# Controlled hosted-pilot runbook

This runbook defines the minimum controls for a hosted ShadeRoute pilot. It is
not proof that those controls are currently in place. Every unresolved item
marked **release blocker** must be closed before public pilot traffic is enabled.

## Required topology

- Serve the application through TLS.
- Keep the primary Valhalla service on a private network or authenticated
  service-to-service endpoint. Do not expose its port directly to the internet.
- Configure a fallback operated independently of the primary. The public
  FOSSGIS endpoint in `.env.example` is for fair-use development, not the hosted
  pilot fallback.
- Keep provider credentials in the hosting platform's server-side secret store.
  They must not be placed in client bundles, logs or committed environment files.
- Apply platform rate limits in front of `/api/route`; the in-process guard is
  not shared between runtime instances.

The server-side routing variables are `VALHALLA_URL`, `VALHALLA_AUTH_HEADER`,
`VALHALLA_AUTH_TOKEN`, `VALHALLA_FALLBACK_URL`,
`VALHALLA_FALLBACK_AUTH_HEADER`, `VALHALLA_FALLBACK_AUTH_TOKEN`,
`ROUTE_REQUESTS_PER_MINUTE` and `ROUTE_MAX_CONCURRENT`. Optional provider keys
listed in `.env.example` are also server secrets.

## Release blockers

| Gate | Evidence required before launch | Current state |
| --- | --- | --- |
| Service owner | Named person with authority to stop the pilot | **Release blocker: unassigned** |
| Alert recipient | Tested on-call route and acknowledgement expectation | **Release blocker: unassigned** |
| Rollback owner | Named person able to switch application and routing versions | **Release blocker: unassigned** |
| Hosted URLs | Reviewed application, primary, fallback and status endpoints | **Release blocker: unset** |
| Independent fallback | Contract/terms, authentication and a successful synthetic response | **Release blocker: unverified** |
| DPIA | Signed data-protection impact assessment covering precise journey endpoints | **Release blocker: not recorded** |
| Provider retention | Documented request/log retention, processor terms and deletion route | **Release blocker: not recorded** |
| Log review | Sample confirming that prohibited fields below are absent | **Release blocker: not recorded** |
| Synthetic monitoring | External probes for both pilot journeys with alert delivery tested | **Release blocker: hosted probe not configured** |
| Rollback rehearsal | Timed switch to the prior app image and routing graph | **Release blocker: not recorded** |
| Field gate | Published protocol status and explicit decision on whether collected evidence meets the pilot threshold | **Release blocker: no published observations** |
| Device gate | Real-device checks on agreed iOS/Android browsers, keyboard, screen reader, high zoom and reduced motion | **Release blocker: matrix and results unset** |

## Privacy-bounded telemetry

Operational events may contain an opaque request identifier, pilot area ID,
access preference, primary/fallback role, coarse provider class, response status
category, route count and latency bucket. Do not record:

- origins, destinations, coordinates, bounding boxes or route geometry;
- request or response bodies, search text or saved journeys;
- provider URLs, authentication headers or tokens;
- IP addresses, advertising identifiers, account identifiers or medical data;
- free text, precise timestamps tied to a person, or raw user-agent strings.

Confirm the hosting platform's default access and edge logs obey the same rule;
application-level redaction cannot remove fields already captured upstream.

## Probes and alerting

`npm run check:local-pilot` checks liveness, local Valhalla readiness and the two
fixed, non-personal pilot journeys. It deliberately prints no coordinates,
provider URLs or geometry. Run it before local promotion.

The current script requires a loopback primary marker and is not yet a hosted
monitor. Before launch, provide an external equivalent that:

1. sends the same fixed Waterloo standard and King’s Cross
   `avoid-known-steps` requests through the public application origin;
2. requires a successful primary response with one to three bounded routes;
3. probes primary and fallback readiness without putting secrets in the URL;
4. emits only the permitted telemetry fields above; and
5. pages the assigned recipient after the reviewed consecutive-failure and
   latency thresholds.

The threshold values and monitoring URL are **release blockers until recorded
and tested**. A liveness response alone must not be treated as dependency
readiness.

## Promotion and rollback

Promote an immutable application build, release manifest and dated routing graph
together. Retain the last verified application image and graph until the pilot
window closes. Before switching traffic, verify the release manifest, production
dependency audit, CI checks, both synthetic journeys and fallback response.

Rollback when the assigned owner confirms incorrect route/model output,
dependency failure, privacy leakage or sustained alert breach. Stop new pilot
traffic if safe rollback is not immediately available. Switch to the last
verified application and graph, repeat the fixed probes, record only
coordinate-free incident times and version identifiers, and preserve relevant
redacted operational evidence. Do not claim recovery until primary and fallback
checks pass and the owner closes the incident.
