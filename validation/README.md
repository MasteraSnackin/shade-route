# ShadeRoute field-validation protocol

ShadeRoute is an engineering-tested, uncalibrated clear-sky shade model. Do not
describe the sensitivity band as a statistical confidence interval or the
route suggestion as a safety recommendation until this protocol has produced
enough evidence.

## Minimum pilot check

1. Observe at least six fixed points on each pilot corridor: open street,
   building edge, tree canopy, street canyon, station approach and hospital
   entrance.
2. Repeat the observations during morning, solar noon and late afternoon on a
   day with clearly visible direct sunlight.
3. Record the exact time in Europe/London, GPS position, observed state, side of
   pavement, planned point ID and site type, temporary obstructions and
   leaf conditions. Reuse each point ID in all three specified time bands.
4. Generate ShadeRoute's prediction for the same coordinate and time before
   looking at the observation result.
5. Report, without removing disagreements:
   - sun/shade classification accuracy;
   - unknown-section rate;
   - direct-sun-minute error for each complete route walk; and
   - whether the ordering of route alternatives agreed with observation.

## Operational feedback

Run a short, consented walkthrough with at least one person from each primary
group: a heat-vulnerable traveller or carer, and a frontline or outdoor worker.
Record the task they attempted, any unsafe or confusing interpretation, which
trade-off they selected and one change made because of the session. Do not
collect medical details or publish identifying material.

The in-app “Operational field feedback” form is deliberately separate from
this calibration protocol. It records the time the report was saved and may,
with explicit consent, include the model section's start coordinate. It does
not capture a device GPS observation point or an explicitly entered
observation time. Its exports can inform operational and usability work, but
must not be counted as fixed-point calibration observations.

Use `observations.csv` only for observations made under the minimum pilot check
above. Record the actual device GPS position and actual observation time at the
point of observation. Do not substitute the in-app report's model-section point
or save time. Empty cells mean “not yet measured”, not a positive result. No
physical observations have been added to the repository yet.

## In-app fixed-point observer

The separate “Physical field calibration” workflow writes the version 2 schema
in `observations.csv` to local browser storage. It requires an explicitly
entered London time, planned point ID, planned site type and actual point
coordinates, freezes the predicted state, and only then reveals the
observed-state controls. Location permission is optional: pressing the location
button makes one `getCurrentPosition` request, never continuous tracking. Manual
coordinates remain available.

Every record is bound automatically to the observation-schema version,
model-first protocol version, model version, selected pilot data-pack version
and SHA-256 asset-manifest fingerprint. Do not type or copy these identifiers
from another build. `coordinate_source` distinguishes manual entry from a
one-shot browser reading; `gps_accuracy_metres` contains the browser-reported
radius for the latter and is empty for manual entry. GPS accuracy is no longer
embedded in free-text notes. The CSV remains on the device until the observer
explicitly downloads and shares it. Imports are restricted to the same schema
and storage is capped at 500 observations. Operational feedback exports must
not be imported or counted as calibration evidence.

## Pre-specified fixed-point threshold template

`fixed-point-thresholds.json` records the intended analysis gates while the
observation CSV is still header-only. It is a template, not evidence of a
formal study registration or a registry of exact point coordinates. Preserve
its commit history and obtain protocol-owner approval before treating a frozen
copy as a registration. Its release identity must match the records exactly. A
record is eligible only when it uses that release, was made with clearly visible
direct sun, falls inside one of the specified London time bands and, for one-shot GPS,
has a browser-reported accuracy radius no greater than 20 metres. Manual points
remain eligible because their coordinate source is explicit; teams must retain
the separate point-placement record used to establish them.

The coverage gate requires each of the six specified site types in each pilot
to be represented by a planned point that has eligible observations in every
time band. One-off rows for a site type do not meet this diversity requirement.
It also requires at least six unique planned points in each pilot, the same six
point IDs repeated across morning, solar-noon and late-afternoon with no repeat more than 25 metres
from another coordinate recorded under that point ID, at least six eligible
observations per pilot and time band, and at least 36 eligible observations in
total. Only after that coverage gate is complete are the pre-specified performance gates
evaluated: at least 80% overall sun/shade agreement, at least 75% agreement in
each pilot and no more than 10% unclassified (`uncertain`, `unknown` or `night`)
predictions.

`lib/fixed-point-analysis.ts` parses the threshold plan and analyses either the
strict observation objects or the CSV without throwing. It reports excluded
records, coverage failures, agreement and unclassified rates deterministically.
A header-only file returns `no-observations`; incomplete coverage returns
`insufficient-evidence`; neither returns a pass/fail performance judgement.
Even `fixed-point-thresholds-met` sets `canClaimModelAccuracy` to false because
the route-walk, accessibility, usability and operational checks remain separate
requirements. Do not reinterpret this fixed-point engineering gate as proof of
personal safety, route-level accuracy or field readiness.

## Complete route-walk comparisons

Use `route-walks.csv` for the separate complete-walk check. The committed file
is intentionally header-only: it is a schema template, not evidence that a walk
has taken place. Do not add example or synthetic rows to it.

Create one row per fully walked route. A `comparison_id` must contain exactly
two or three distinct `route_id` values, and every row in that comparison must
use the same pilot area, Europe/London comparison date and time, model version
and clear-direct-sun weather classification. Freeze the model outputs and route
order before any route is walked. Use the route IDs and model version shown by
the tested build; do not substitute route labels such as “best” or “fastest”.

For both predicted and observed minutes, direct sun, shade and unknown must add
exactly to the corresponding duration. A complete physical walk may still have
unknown observation minutes if a section could not be classified. In that case,
set `observed_order` to `unknown` for every alternative in the comparison. Do
not guess an order or silently allocate unknown minutes to sun or shade. When
all observed minutes are classified, use each rank from 1 through the number of
alternatives exactly once. Ranks are the ascending order of direct-sun minutes;
ties may be put in either adjacent order but must still use distinct ranks.

The local parser and analyser are exported from
`lib/route-walk-validation.ts`. They accept only schema version 1, at most 600
rows, walks of at most 240 minutes and two or three alternatives per comparison.
Malformed totals, duplicate routes, incomplete ranks, contradictory ranks,
mixed comparison metadata and non-existent London civil times are rejected
rather than repaired.

The analysis reports:

- absolute predicted-versus-observed direct-sun-minute error for each walk with
  no observed unknown minutes, and mean absolute error across those walks;
- duration-weighted predicted and observed coverage and unknown rates;
- full route-order agreement for each comparison with complete observed
  coverage; and
- regret in observed direct-sun minutes: the observed minutes on the predicted
  first route minus the lowest observed minutes in that comparison.

Results remain grouped by comparison ID, pilot area and London comparison time.
The schema deliberately excludes participant identifiers, exact observation
points and route geometry. Keep any consent or session administration outside
this CSV. A header-only file or a result containing unknowns is not evidence of
accuracy, and neither should be presented as a successful field-calibration
result.

## Physical-device, accessibility and user gates

[`EXTERNAL-GATES.md`](EXTERNAL-GATES.md) defines the physical iOS and Android
offline, storage-eviction, update, battery, VoiceOver, TalkBack, magnification
and representative-user gates. Their evidence register is
`device-and-user-evidence.csv`. It is intentionally header-only: none of those
external checks has been completed in this repository.

Automated tests and desktop device emulation may find defects, but they cannot
pass these gates. Do not describe the prototype as field-ready, accessible or
offline-proven until the required physical-device and consented user rows have
been reviewed and every gate has passed on the tested release commit.
