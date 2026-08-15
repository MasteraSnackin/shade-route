# Controlled local walking routing

This service runs a digest-pinned Valhalla scripted image against the dated
14 August 2026 Greater London OpenStreetMap extract. It is bound to loopback
and is intended for local development and controlled pilot testing, not direct
public access.

## Start

From this directory:

```bash
docker compose -f compose.yml up -d
```

The first start downloads the pinned Greater London extract and builds routing
tiles. The download is 128,158,846 bytes; the generated graph and container
image require additional disk space. Readiness may take several minutes.

Release inputs are frozen in `compose.yml`:

- Valhalla image digest:
  `sha256:24ef7955899dececb94e26c6dfb89d64fabfae875f980432694b0261eb6c251b`
- Geofabrik snapshot: `greater-london-260814.osm.pbf`
- Snapshot SHA-256:
  `4256631d48cc50719013c7f3acc503a1add8700818748f6dc9505da564e9b1e0`
- Snapshot MD5 published by Geofabrik:
  `e563227d9954b7e675e337b8fb8371f9`

The container does not prove that graph output is byte-identical across host
architectures. Treat the pinned inputs and synthetic route checks as the
reproducibility boundary; retain a verified graph for rollback.

Check the service without sending a real person's journey:

```bash
curl -fsS http://127.0.0.1:8002/status
```

After the ShadeRoute application is running, exercise both published synthetic
pilot journeys and the application liveness endpoint:

```bash
npm run check:local-pilot
```

The check requires the application response to identify both the primary role
and the loopback provider class, then prints only those opaque markers, the pilot
identifier, tested access preference, route count and request duration. It
exercises both standard and avoid-known-steps requests, and does not print fixed
coordinates, provider URLs or returned geometry.

Copy the repository's `.env.example` to `.env.local` and keep
`VALHALLA_URL=http://127.0.0.1:8002/route`. The application will use the guarded
same-origin route proxy; browsers must not call Valhalla directly.

## Data and privacy

- Source: Geofabrik Greater London OpenStreetMap extract dated 14 August 2026.
- OSM data is licensed under ODbL; retain OpenStreetMap attribution.
- Generated files are deliberately ignored by Git.
- Exact custom endpoints reach this service only after a user requests a route.
- Do not log request bodies, coordinates, polylines or query text.

For a public pilot, place the service behind TLS, authentication or a private
network, platform rate limiting and health monitoring. Configure a genuinely
independent fallback. Do not expose port 8002 to the public internet.

## Refresh and rollback

Change the pinned image digest and dated extract deliberately, verify the
download checksum, then rebuild in a new volume. Run the fixed synthetic pilot
checks before switching traffic. Retain the previous graph until the new one is
verified so rollback does not depend on rebuilding.
