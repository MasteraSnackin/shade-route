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
   pavement, temporary obstructions and leaf conditions.
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
