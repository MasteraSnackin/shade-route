# ShadeRoute

ShadeRoute is a mobile-first London prototype that compares real walking-route
alternatives by journey time and potential direct sunlight under clear skies.
It was built for Frontline London with two hospital pilot corridors:

- London Waterloo Station to St Thomas’ Hospital
- King’s Cross Station to University College Hospital

The product supports cached pilot journeys, live custom routing inside either
pilot area, repeated occupational journeys, access warnings and explicit
sun/shade/uncertain/unknown route sections. Its 3D map animates estimated
building and vegetation shadows through the day, while a guarded two-hour scan
can suggest a lower-exposure route and departure time when the model evidence
is strong enough. The selected route can also be inspected step by step, used
in a reference-only walking mode, saved as an on-device shortcut and paired
with on-device field observations for later export.

## Run locally

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Open `http://localhost:3000/`.

## Verify

```bash
npm test
npm run lint
```

`npm test` builds the production Worker and runs the route, production raster,
London-time, product-claim and deterministic geometry suites.

## Data and services

- Local basemap and walking-route data: OpenStreetMap contributors, ODbL.
- Nearby drinking-water, toilet, bench and individual-tree records: a dated,
  partial OpenStreetMap snapshot; absence is never presented as evidence that
  an amenity is unavailable.
- Official cooling-space context: Greater London Authority Cool Space Data
  2025 under the London Datastore terms. These are dated register entries, not
  live availability. The GLA does not warrant their quality or accuracy and
  does not endorse ShadeRoute.
- Height grids: Environment Agency LiDAR Composite 1 m DSM minus DTM, OGL v3.
- Solar position: SunCalc v2.
- Regional context: the official UKHSA London heat-health alert metric through
  a cached, fail-neutral `/api/heat-context` proxy. It is displayed separately
  and never changes the route score.
- Live custom walking routes: the public FOSSGIS Valhalla service through the
  server-side `/api/route` proxy. Responses are private and are not cached.

The two pilot basemaps, conservative validity masks, height grids and showcase routes are bundled under
`public/data/`. `scripts/prepare-data.mjs` rebuilds those packs from the source
material under `data/`. OSM building multipolygons, inner holes and explicit
height evidence are retained. Ground-shadow rasterisation runs in a browser
worker, with a deterministic synchronous fallback when workers are unavailable.

## Responsible-use boundary

ShadeRoute is an uncalibrated clear-sky geometric model. It does not measure
temperature, thermal comfort or heat-illness risk, and it does not certify
routes as step-free. Unknown model sections are conservatively counted as
potential direct sun so missing data cannot make a route rank better.

Automatic departure advice is withheld when daylight coverage is below 90%,
at low sun angles, when sensitivity ranges overlap, when a material improvement
is absent, or when every eligible route contains a known stair or escalator
instruction. The displayed sensitivity range is not a statistical confidence
interval.

The field-validation protocol and empty observation template are in
`validation/`. Do not replace those unknowns with invented evidence.
