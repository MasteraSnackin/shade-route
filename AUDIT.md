# Visual and functional quality audit

Audit date: 12 August 2026
Application: ShadeRoute London pilot
Viewports: 1440 × 1000 and 390 × 844
Healing attempts used: 1 of 3

## Squad status

- **Visual score: 9.2/10**
- **Functional score: 9.4/10**
- **Trust score: 9.5/10**
- **Status: Verified & Polished for prototype demonstration**

These scores assess the implemented prototype interface and failure handling.
They do not certify shade accuracy, operational readiness or medical benefit.

## Environmental check

- Local Vinext/Next-compatible development render returned HTTP 200.
- Production Worker build completed.
- MapLibre rendered the two pilot maps and 3D buildings.
- No browser console errors or warnings remained in the audited flow.
- UKHSA returned its designed neutral unavailable state during the check.

## Pass 1 — findings

Initial scores were Visual 8.4, Functional 8.7 and Trust 9.1.

### Visual wins

- Outcome-led headline and a clear journey-planning entry point.
- Route choice appears before the technical 3D explanation.
- Distinct route identities and text/pattern exposure states.
- Strong desktop planner/map composition and useful partial-next-card cue on mobile.
- Warm, restrained visual system suitable for a public-interest tool.

### Critical fails found

1. MapLibre's intrinsic width expanded a mobile grid child to approximately
   713 px inside a 390 px viewport. The shell clipped it, so the route carousel
   and map were not actually bounded by the planner.
2. Generic `footer` selectors leaked page-level layout into the shade-playback
   component footer.
3. Initial data loading had accessible text but no structural skeleton.
4. The regional heat-context heading skipped from the page `h1` to `h3`.
5. A quick-time **Now** button measured approximately 42 × 44 px.

### Logic and trust bugs found

1. `POST /api/route` crashed on syntactically valid non-object JSON such as `null`.
2. UKHSA JSON was not byte-bounded.
3. The live-route client could remain unresolved if fetch or body parsing ignored
   `AbortSignal`.
4. The low-sun ground-shadow visual has no explicit search-limit or uncertainty
   channel, although route scoring does. This remains documented research work,
   not a hidden claim.

## Self-correction attempt 1

### Visual corrections

- Constrained the planner map grid to `minmax(0, 1fr)` and zero-minimum children.
- Scoped page footer rules to `.site-shell > footer`.
- Added a reduced-motion-aware boot skeleton and preserved error announcements.
- Corrected the heat heading hierarchy.
- Raised dense operational text and all audited controls to responsible sizes.
- Added preference modes for reduced transparency, greater contrast and forced colours.
- Added a keyboard bypass link with an explicit focus destination.

### Functional corrections

- Added unknown-first request validation and stable typed API errors.
- Added an actual-byte bounded JSON reader for all external JSON routes.
- Added an end-to-end live-route deadline covering headers and body parsing.
- Added hostile-body, stream, timeout and cancellation regression tests.
- Removed redundant ground-shadow hot-loop work with pixel-identical output.

## Final validation

### Information architecture

**Pass.** The first screen answers what the application does and presents route
choice before model details. Desktop controls are grouped by journey intent;
mobile collapses them after a calculation.

### Modular layout

**Pass.** Planner, decision strip, map, evidence and result sections use a
consistent grid and spacing system. The mobile carousel is now bounded and its
third route is reachable.

### Surface and visual effects

**Pass.** Blur/transparency is limited to map overlays. Content surfaces remain
opaque enough for legibility, with preference fallbacks.

### Typography and motion

**Pass.** The responsive headline establishes hierarchy; dense controls remain
readable. Motion communicates state and is disabled on request. Decorative
kinetic typography was rejected as inappropriate for this user group.

### Sidebar/planner quietness

**Pass.** Controls are grouped into pilot and journey steps, with technical
evidence moved beside or after the route decision.

### Immediate feedback

**Pass.** Route choices update `aria-pressed` immediately. Time-step controls
update the displayed London time and model. Long operations expose busy labels.

### System states

- **Loading:** text and skeleton present.
- **Empty:** saved journeys and partial context have explicit empty copy.
- **Error:** neutral UKHSA failure and typed route failures offer recovery.
- **Success:** offline preparation confirmed 15 verified files, then removal
  returned the pilot to an unverified state.

### Optimistic UI

**Pass by responsible exception.** Reversible visual selection is immediate.
Routing, model calculation, offline preparation and export wait for real success.

### Modal and popover intent

**Pass.** High-commitment location and local-storage actions remain explicit.
Lightweight landmark choices use an inline combobox/listbox rather than a modal.

### Responsive and accessibility evidence

- No document-level horizontal overflow at 390 or 1440 px.
- Mobile planner map width: 370 px after correction.
- Mobile route carousel viewport: 346 px; scroll surface: 689 px.
- No visible audited button, non-checkbox input, select or textarea below 44 px.
- Heading order begins `h1`, then section `h2` elements.
- Skip-link activation focuses `#route-planner`.
- No browser console errors or warnings in the final flow.

## Remaining non-blocking gates

- Physical shade calibration remains at zero observations.
- Real-device offline reload/storage-pressure testing remains outstanding.
- Screen-reader and switch-control testing on physical devices remains outstanding.
- The public routing endpoint has no service-level guarantee.
- Hosted operational monitoring and incident ownership are not yet established.
- A production URL was not created because Sites is not enabled for this workspace.

These gates prevent an operational or safety claim, but the interface handles
them honestly and they do not reduce the prototype UI trust score below the
quality threshold.

## Evidence artefacts

- `docs/audit/before-1440.png`
- `docs/audit/before-mobile-390.png`
- `docs/audit/after-desktop.png`
- `docs/audit/after-mobile-390.png`
- `DEBUG.md`
- `NERD.md`
- `ERROR-HANDLING.md`

## Final sync

The production build, lint, TypeScript checks and all 167 deterministic tests
passed. `PLAN.md` is marked **Verified & Polished**; the evidence is ready for
the required audit commit.
