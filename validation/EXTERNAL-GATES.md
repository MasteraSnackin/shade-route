# Physical-device and user-evidence gates

These gates cannot be completed by unit tests, browser emulation or synthetic
records. They are release blockers for any field-readiness claim. Every gate is
currently pending because `device-and-user-evidence.csv` is header-only.

Use a release build served over public HTTPS. Record its full Git commit and do
not reuse evidence after the model, data pack, service worker or relevant user
interface changes. Keep names, contact details, medical information, precise
locations and other participant identifiers outside this repository.

## Required gates

| Gate ID | Physical evidence required | Pass condition |
| --- | --- | --- |
| `ios-offline-reload` | Current stable iOS Safari on a supported physical iPhone, launched from the Home Screen. Prepare each bundled corridor, enable aeroplane mode, terminate the app and reopen it. | Both verified bundled corridors reopen; route alternatives, the local map, shade playback and field route reference remain usable. Custom routing and live heat stay explicitly unavailable. |
| `android-offline-reload` | Current stable Android Chrome on a supported physical Android phone, installed as a web app. Repeat the iOS task. | Same functional result as the iOS gate, with no false online or readiness state. |
| `storage-eviction` | On both platforms, verify a pack, then clear or evict the site cache while leaving or recreating a stale local readiness record. | ShadeRoute withdraws the verified state after its integrity check and requires preparation again. It never labels missing bytes as ready. |
| `service-worker-update` | On both platforms, verify the previous pack, install a release with a new worker or pack version, apply the waiting update and reopen. | The prior record becomes stale, the update is announced and the new pack must be prepared and integrity-checked before it is called ready. |
| `field-runtime` | On both phones, use shade playback and the field route reference continuously for 20 minutes from at least 80% battery, with screen brightness and power mode recorded in notes. | No crash, forced reload, severe thermal warning or unresponsive control; battery falls by no more than 10 percentage points. Record the battery delta as `measurement_value` with `percentage-points`. |
| `voiceover-critical-path` | A trained tester uses iOS VoiceOver without sight to prepare a pack, plan a bundled route, compare alternatives, operate time playback, open the field route reference and export an empty validation template. | Every task can be completed without touch exploration being the only way to discover a control; focus order, names, state and status announcements are understandable; no critical or serious issue remains open. |
| `talkback-critical-path` | Repeat the same task on physical Android with TalkBack. | Same accessibility condition as the VoiceOver gate. |
| `magnification-reflow` | On both platforms, repeat route comparison and field-reference tasks at 200% text size and platform magnification. | No required control or status is clipped, obscured or reachable only by a precision gesture. |
| `heat-vulnerable-walkthrough` | One consented heat-vulnerable traveller or carer completes the planning and interpretation tasks using a representative scenario. | Task outcome, unsafe or confusing interpretation, chosen trade-off and at least one resulting product decision are recorded without medical or identifying data. |
| `frontline-worker-walkthrough` | One consented frontline or outdoor worker completes the repeated-journey and field-reference tasks. | The same evidence fields as the heat-vulnerable walkthrough are recorded, including at least one resulting product decision. |

## Evidence rows

Add one row per device, participant group and gate. Use schema
`uk.shaderoute.external-validation-evidence` and schema version `1`. `outcome`
must be `pass`, `fail` or `blocked`; never omit a failed run. Use `none` where
assistive technology or participant group does not apply. `evidence_reference`
must point to a reviewed, access-controlled artefact or a repository file that
contains no identifying information.

A gate passes only when every required platform/task row passes. A blank sheet,
screenshots from an emulator, automated accessibility checks or an unlinked
claim in documentation do not satisfy a gate.
