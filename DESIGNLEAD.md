# Design lead report — visual and interaction quality

## Design objective

Make a complex shade model understandable to a person planning a journey in a
few seconds, while protecting legibility for heat-vulnerable users. The visual
system uses high-contrast warm neutrals, deep green, restrained orange and
purple route identities, compact evidence panels and a decision-first map.

## Information architecture

The primary path is organised around user goals:

1. Understand the product boundary.
2. Choose a pilot and set journey needs.
3. Compare the route trade-off.
4. Explore the 3D explanation and time.
5. Inspect evidence, local context and walking steps.
6. Read the model method and limitations.

On narrow screens, the planner collapses after calculation so route choice and
the map appear before technical controls. **Edit journey** restores the inputs.
A keyboard bypass link moves focus directly to the planner.

## Layout system

- Desktop uses a modular two-column planner: quiet controls on the left and the
  decision strip plus map on the right.
- Route alternatives form three consistent decision cards with route identity,
  duration, trade-off, exposure range and coverage.
- Evidence, local context and result cards use purpose-specific grid layouts
  rather than one generic card treatment.
- Mobile uses a bounded horizontal route carousel above the map. Its grid track
  is explicitly `minmax(0, 1fr)` so the MapLibre canvas cannot expand and clip
  the interface.
- Spacing, radii, borders and colours come from shared CSS variables and repeated
  component patterns.

## Typography and motion

The large headline is the only expressive typographic moment. Operational text
has been raised to at least 11 px in the densest controls, while primary body
copy remains larger. Route metrics use weight and grouping rather than colour
alone.

Kinetic text was deliberately not introduced. Moving headings would compete
with the time-dependent map and can burden vulnerable or motion-sensitive
users. Motion is limited to functional transitions and a loading shimmer;
`prefers-reduced-motion` disables them.

## Transparency and surface treatment

Translucency and blur are reserved for map overlays where spatial context must
remain visible. Planner, decision and evidence surfaces stay substantially
opaque for contrast and predictable reading. The CSS includes explicit
`prefers-reduced-transparency`, `prefers-contrast` and forced-colour modes.

This is a more responsible application of the glass-surface pattern than
applying blur indiscriminately to every card.

## Accessibility improvements

- Skip link to a focusable journey planner.
- Corrected heat-context heading from `h3` to `h2`.
- Accessible loading/error announcement and restrained skeleton.
- 44 px minimum targets for dense planner, playback, map and quick-time controls.
- Route selection exposed through `aria-pressed` in map and card controls.
- Status changes use restrained live regions and playback suppresses chatter.
- Exposure states retain patterns/text and do not rely on colour alone.
- Reduced motion, transparency, high contrast and forced colours are supported.
- Page-footer selectors are scoped so they cannot style a nested component footer.

## Visual defect closed during browser audit

At 390 px, MapLibre's intrinsic canvas width forced the map grid's implicit
column to about 713 px. The outer shell hid overflow, making the route carousel
and map look clipped even though the document itself reported no horizontal
scroll. Adding an explicit `minmax(0, 1fr)` grid column and zero minimum widths
constrained the child surfaces to 370 px; the route carousel now has a 346 px
viewport and a deliberate 689 px scroll surface. The third route was selected
successfully after horizontal auto-scroll.

## State design

- **Loading:** immediate accessible text plus a restrained layout skeleton.
- **Empty:** saved journeys and partial context explain what is absent and what
  the user can do next.
- **Error:** UKHSA and route failures remain recoverable and non-blaming.
- **Success:** saves, exports and offline verification announce only after the
  operation is confirmed.
- **Uncertainty:** coverage, sensitivity reasons and source age remain next to
  the route decision.

Optimistic selection is used for reversible route-card choice. It is not used
for calculations, offline verification or downloads, where premature success
would damage trust.

## Evidence

- Desktop: `docs/audit/after-desktop.png`.
- Mobile 390 px: `docs/audit/after-mobile-390.png`.
- Source assertions: `tests/accessibility-surface.test.mjs`.
- Browser measurements: no document overflow and no visible button/input/select
  below 44 px after the final correction; native checkbox remains inside a
  larger labelled target.

## Deferred design work

- Test with VoiceOver, TalkBack and high magnification on physical devices.
- Observe representative carers and outdoor workers completing the route task.
- Validate the map explanation with people who do not use interactive maps.
- Consider a persistent scroll cue for the route carousel only if user testing
  shows that partial next-card visibility is insufficient.
