"use client";

import {
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  CALIBRATION_SITE_TYPES,
  FIELD_CALIBRATION_DATA_PACK_VERSION,
  FIELD_CALIBRATION_MAX_IMPORT_BYTES,
  FIELD_CALIBRATION_MODEL_VERSION,
  FIELD_CALIBRATION_PROTOCOL_VERSION,
  FIELD_CALIBRATION_STORAGE_KEY,
  calibrationObservationsToCsv,
  calibrationSnapshotStatus,
  clearCalibrationObservations,
  createCalibrationObservation,
  deleteCalibrationObservation,
  freezeCalibrationPrediction,
  importCalibrationCsv,
  isCalibrationPilotAreaId,
  prepareCalibrationModelPredictionRequest,
  readCalibrationObservations,
  saveCalibrationObservation,
  type CalibrationLeafState,
  type CalibrationModelPredictionRequest,
  type CalibrationObservedState,
  type CalibrationPavementSide,
  type CalibrationPilotAreaId,
  type CalibrationPilotBoundary,
  type CalibrationPredictedState,
  type CalibrationSiteType,
  type CalibrationWeatherVisibility,
  type FrozenCalibrationPrediction,
} from "../lib/field-calibration";
import { formatLondonDateTime } from "../lib/london-time";
import styles from "./CalibrationObserver.module.css";
import { CalibrationObserverRouteWalks } from "./CalibrationObserverRouteWalks";

const CALIBRATION_CHANGE_EVENT = "shaderoute:field-calibration-change";
const STORAGE_UNAVAILABLE_SNAPSHOT = "__shaderoute_calibration_storage_unavailable__";

export interface CalibrationObserverProps {
  pilotAreas: readonly CalibrationPilotBoundary[];
  initialPilotAreaId?: CalibrationPilotAreaId;
  /**
   * The application supplies the production raster resolver. If absent, the
   * component exposes a clearly labelled manual protocol fallback.
   */
  resolvePrediction?: (
    request: Readonly<CalibrationModelPredictionRequest>,
  ) => Promise<CalibrationPredictedState>;
}

interface PredictionDraft {
  contextKey: string;
  pilotArea: CalibrationPilotAreaId | "";
  plannedPointId: string;
  siteType: CalibrationSiteType | "";
  latitude: string;
  longitude: string;
  pavementSide: CalibrationPavementSide | "";
  observedLondonDateTime: string;
  predictedState: CalibrationPredictedState | "";
  predictionRecordedFirst: boolean;
  locationAccuracyMetres?: number;
}

interface ObservationDraft {
  weatherVisibility: CalibrationWeatherVisibility | "";
  observedState: CalibrationObservedState | "";
  temporaryConditions: string;
  leafState: CalibrationLeafState | "";
  observerNotes: string;
}

function blankPredictionDraft(
  contextKey: string,
  initialPilotAreaId?: CalibrationPilotAreaId,
): PredictionDraft {
  return {
    contextKey,
    pilotArea: initialPilotAreaId ?? "",
    plannedPointId: "",
    siteType: "",
    latitude: "",
    longitude: "",
    pavementSide: "",
    observedLondonDateTime: "",
    predictedState: "",
    predictionRecordedFirst: false,
  };
}

function blankObservationDraft(): ObservationDraft {
  return {
    weatherVisibility: "",
    observedState: "",
    temporaryConditions: "",
    leafState: "",
    observerNotes: "",
  };
}

function storageSnapshot() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(FIELD_CALIBRATION_STORAGE_KEY) ?? "";
  } catch {
    return STORAGE_UNAVAILABLE_SNAPSHOT;
  }
}

function subscribeToCalibration(onChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === FIELD_CALIBRATION_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CALIBRATION_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CALIBRATION_CHANGE_EVENT, onChange);
  };
}

function announceCalibrationChange() {
  window.dispatchEvent(new Event(CALIBRATION_CHANGE_EVENT));
}

function downloadCsv(contents: string) {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "shaderoute-fixed-point-observations.csv";
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function predictedStateLabel(state: CalibrationPredictedState) {
  switch (state) {
    case "sun": return "direct sun";
    case "shade": return "shade";
    case "uncertain": return "uncertain";
    case "unknown": return "no model coverage";
    case "night": return "night";
  }
}

export function CalibrationObserver({
  pilotAreas,
  initialPilotAreaId,
  resolvePrediction,
}: CalibrationObserverProps) {
  const headingId = useId();
  const privacyId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelClearRef = useRef<HTMLButtonElement>(null);
  const predictionRequestSequenceRef = useRef(0);
  const rawSnapshot = useSyncExternalStore(subscribeToCalibration, storageSnapshot, () => "");
  const storageUnavailable = rawSnapshot === STORAGE_UNAVAILABLE_SNAPSHOT;
  const storageUnreadable = !storageUnavailable && calibrationSnapshotStatus(rawSnapshot) === "unreadable";
  const records = rawSnapshot && !storageUnavailable && !storageUnreadable
    ? readCalibrationObservations()
    : [];
  const availablePilotAreas = pilotAreas.filter((candidate) =>
    isCalibrationPilotAreaId(candidate.id),
  );
  const defaultPilotAreaId = initialPilotAreaId ?? availablePilotAreas[0]?.id;
  const contextKey = defaultPilotAreaId ?? "no-pilot";
  const [predictionState, setPredictionState] = useState<PredictionDraft>(() =>
    blankPredictionDraft(contextKey, defaultPilotAreaId),
  );
  const draft = predictionState.contextKey === contextKey
    ? predictionState
    : blankPredictionDraft(contextKey, defaultPilotAreaId);
  const [frozen, setFrozen] = useState<FrozenCalibrationPrediction | null>(null);
  const [observation, setObservation] = useState<ObservationDraft>(blankObservationDraft);
  const [status, setStatus] = useState("");
  const [locationStatus, setLocationStatus] = useState("");
  const [locationPending, setLocationPending] = useState(false);
  const [predictionPending, setPredictionPending] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const storageBlocked = storageUnavailable || storageUnreadable;

  const updatePrediction = (update: Partial<Omit<PredictionDraft, "contextKey">>) => {
    setPredictionState({ ...draft, ...update, contextKey });
  };

  const handleManualCoordinate = (field: "latitude" | "longitude", value: string) => {
    updatePrediction({ [field]: value, locationAccuracyMetres: undefined });
    setLocationStatus(value ? "Manual coordinate entered. No device location is retained." : "");
  };

  const requestOneShotLocation = () => {
    if (!("geolocation" in navigator)) {
      setLocationStatus("This browser does not provide location. Enter the point manually.");
      return;
    }
    setLocationPending(true);
    setLocationStatus("Waiting for one location reading. Continuous tracking is not used.");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocationPending(false);
        setPredictionState((current) => ({
          ...(current.contextKey === contextKey
            ? current
            : blankPredictionDraft(contextKey, defaultPilotAreaId)),
          contextKey,
          latitude: position.coords.latitude.toFixed(7),
          longitude: position.coords.longitude.toFixed(7),
          locationAccuracyMetres: position.coords.accuracy,
        }));
        setLocationStatus(`One location reading received; browser-reported accuracy radius ${Math.round(position.coords.accuracy)} m.`);
      },
      () => {
        setLocationPending(false);
        setLocationStatus("Location was not available or permission was declined. Enter the point manually.");
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
    );
  };

  const handleFreeze = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.predictionRecordedFirst) {
      setStatus(resolvePrediction
        ? "Confirm that you have not checked the physical sun or shade before calculating the model prediction."
        : "Confirm that the model prediction was recorded before checking physical sun or shade.");
      return;
    }
    if (
      !draft.latitude.trim() ||
      !draft.longitude.trim() ||
      !draft.plannedPointId.trim() ||
      !draft.siteType ||
      !draft.pavementSide ||
      (!resolvePrediction && !draft.predictedState)
    ) {
      setStatus(resolvePrediction
        ? "Complete the selected pilot, pre-registered point ID and site type, exact observation point, London time and pavement side."
        : "Complete the pre-registered point ID and site type, observation point, pavement side and manual model prediction before freezing it.");
      return;
    }

    const requestSequence = predictionRequestSequenceRef.current + 1;
    predictionRequestSequenceRef.current = requestSequence;
    try {
      const request = prepareCalibrationModelPredictionRequest({
        pilotArea: draft.pilotArea,
        latitude: Number(draft.latitude),
        longitude: Number(draft.longitude),
        observedLondonDateTime: draft.observedLondonDateTime,
      }, availablePilotAreas);
      setPredictionPending(true);
      setStatus(resolvePrediction
        ? "Calculating the clear-sky raster prediction for this exact point and London time. Observed-state controls remain hidden."
        : "Freezing the manually recorded model prediction.");
      const predictedState = resolvePrediction
        ? await resolvePrediction(request)
        : draft.predictedState;
      if (requestSequence !== predictionRequestSequenceRef.current) return;
      if (!predictedState) {
        throw new Error("Record the manual model prediction before freezing it.");
      }
      const nextFrozen = freezeCalibrationPrediction({
        ...request,
        plannedPointId: draft.plannedPointId,
        siteType: draft.siteType,
        pavementSide: draft.pavementSide,
        predictedState,
        ...(draft.locationAccuracyMetres === undefined
          ? {}
          : { locationAccuracyMetres: draft.locationAccuracyMetres }),
      });
      setFrozen(nextFrozen);
      setObservation(blankObservationDraft());
      setStatus("Prediction frozen. Now record the physical observation without changing the prediction.");
    } catch (error) {
      if (requestSequence !== predictionRequestSequenceRef.current) return;
      const message = error instanceof Error ? error.message : "The prediction could not be frozen.";
      setStatus(resolvePrediction
        ? `${message} Observed-state controls remain hidden.`
        : message);
    } finally {
      if (requestSequence === predictionRequestSequenceRef.current) {
        setPredictionPending(false);
      }
    }
  };

  const handleSaveObservation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!frozen || !observation.weatherVisibility || !observation.observedState || !observation.leafState) {
      setStatus("Freeze a prediction, then complete every required observation field.");
      return;
    }
    try {
      const record = createCalibrationObservation(frozen, {
        weatherVisibility: observation.weatherVisibility,
        observedState: observation.observedState,
        temporaryConditions: observation.temporaryConditions,
        leafState: observation.leafState,
        observerNotes: observation.observerNotes,
      });
      saveCalibrationObservation(record);
      announceCalibrationChange();
      setFrozen(null);
      setPredictionState(blankPredictionDraft(contextKey, defaultPilotAreaId));
      setObservation(blankObservationDraft());
      setLocationStatus("");
      setStatus("Fixed-point observation saved only in this browser. It was not sent to a server.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The observation could not be saved.");
    }
  };

  const discardFrozen = () => {
    setFrozen(null);
    setObservation(blankObservationDraft());
    setStatus("Frozen prediction discarded. No observation was saved.");
  };

  const handleDelete = (observationId: string) => {
    try {
      deleteCalibrationObservation(observationId);
      announceCalibrationChange();
      setStatus("The on-device calibration observation was deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The observation could not be deleted.");
    }
  };

  const handleExport = () => {
    try {
      downloadCsv(calibrationObservationsToCsv(records));
      setStatus(`CSV download started for ${records.length} fixed-point observation${records.length === 1 ? "" : "s"}.`);
    } catch {
      setStatus("The calibration CSV could not be prepared by this browser.");
    }
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > FIELD_CALIBRATION_MAX_IMPORT_BYTES) {
      setStatus("The CSV exceeds the 1 MB local import limit. Nothing was imported.");
      return;
    }
    try {
      const result = importCalibrationCsv(await file.text());
      announceCalibrationChange();
      setStatus(`${result.importedCount} fixed-point observation${result.importedCount === 1 ? "" : "s"} imported into this browser.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The CSV could not be imported.");
    }
  };

  const handleClear = () => {
    try {
      clearCalibrationObservations();
      announceCalibrationChange();
      setConfirmClear(false);
      setStatus("All on-device calibration observations were deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Calibration observations could not be cleared.");
    }
  };

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <div className={styles.heading}>
        <span>Physical field calibration</span>
        <h3 id={headingId}>Record a model-first fixed-point observation</h3>
        <p>
          This is separate from operational feedback. Use it only while standing at a planned
          validation point and following the field protocol. Physical-state controls stay hidden
          until the point-and-time prediction is frozen.
        </p>
      </div>

      <p className={styles.notice}>
        ShadeRoute remains an uncalibrated clear-sky model. These observations measure disagreement;
        they do not prove that a route is safe, accessible or shaded.
      </p>
      <dl className={styles.releaseBinding} aria-label="Automatically recorded calibration release">
        <div>
          <dt>Protocol</dt>
          <dd>{FIELD_CALIBRATION_PROTOCOL_VERSION}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{FIELD_CALIBRATION_MODEL_VERSION}</dd>
        </div>
        <div>
          <dt>Data pack</dt>
          <dd>{FIELD_CALIBRATION_DATA_PACK_VERSION}</dd>
        </div>
      </dl>
      <p className={styles.privacy} id={privacyId}>
        Nothing is saved automatically. The fixed pilot raster is evaluated in this browser; the
        exact coordinate, Europe/London time and observation fields are not included in an API
        request. Saving writes the model and observed states, conditions and notes to this browser
        only. A one-shot location reading is used only after you press the button; continuous tracking
        is not used. Exports contain sensitive exact locations, so review them before sharing.
      </p>

      {storageUnavailable ? (
        <p role="status">Browser storage is unavailable, so observations cannot be read or saved.</p>
      ) : storageUnreadable ? (
        <p role="status">Existing calibration data is unreadable. Clear it below before saving or importing.</p>
      ) : null}

      {!frozen ? (
        <form className={styles.form} onSubmit={handleFreeze} aria-describedby={privacyId}>
          <span className={styles.stepLabel}>Step 1 — record and freeze the prediction</span>
          <div className={styles.grid}>
            <label className={styles.field}>
              Pilot area
              <select
                required
                value={draft.pilotArea}
                disabled={predictionPending}
                onChange={(event) => updatePrediction({
                  pilotArea: event.target.value as CalibrationPilotAreaId | "",
                })}
              >
                <option value="">Choose a pilot area</option>
                {availablePilotAreas.map((candidate) => (
                  <option value={candidate.id} key={candidate.id}>{candidate.name}</option>
                ))}
              </select>
              <small>Only points inside the selected pilot boundary can be recorded.</small>
            </label>
            <label className={styles.field}>
              Planned point ID
              <input
                type="text"
                required
                maxLength={120}
                pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,119}"
                disabled={predictionPending}
                value={draft.plannedPointId}
                onChange={(event) => updatePrediction({ plannedPointId: event.target.value })}
                placeholder="waterloo-building-edge-01"
              />
              <small>Reuse the same planned ID for this point in every time band.</small>
            </label>
            <label className={styles.field}>
              Planned site type
              <select
                required
                disabled={predictionPending}
                value={draft.siteType}
                onChange={(event) => updatePrediction({
                  siteType: event.target.value as CalibrationSiteType | "",
                })}
              >
                <option value="">Choose the planned type</option>
                {CALIBRATION_SITE_TYPES.map((siteType) => (
                  <option value={siteType} key={siteType}>
                    {siteType.replaceAll("-", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              Actual observation time in Europe/London
              <input
                type="datetime-local"
                required
                disabled={predictionPending}
                value={draft.observedLondonDateTime}
                onChange={(event) => updatePrediction({ observedLondonDateTime: event.target.value })}
              />
              <small>Enter this explicitly at the point; it is never replaced by the save time.</small>
            </label>
            <label className={styles.field}>
              Actual latitude
              <input
                type="number"
                required
                min={-90}
                max={90}
                step="any"
                inputMode="decimal"
                disabled={predictionPending}
                value={draft.latitude}
                onChange={(event) => handleManualCoordinate("latitude", event.target.value)}
              />
            </label>
            <label className={styles.field}>
              Actual longitude
              <input
                type="number"
                required
                min={-180}
                max={180}
                step="any"
                inputMode="decimal"
                disabled={predictionPending}
                value={draft.longitude}
                onChange={(event) => handleManualCoordinate("longitude", event.target.value)}
              />
            </label>
            <div className={`${styles.fieldGroup} ${styles.wide}`}>
              <div className={styles.locationActions}>
                <button
                  className="text-button"
                  type="button"
                  disabled={locationPending || predictionPending}
                  onClick={requestOneShotLocation}
                >
                  {locationPending ? "Getting one reading…" : "Use one location reading"}
                </button>
                <small>No permission is requested until this button is pressed.</small>
              </div>
              <span className={styles.locationStatus} role="status" aria-live="polite">
                {locationStatus}
              </span>
            </div>
            <label className={styles.field}>
              Side of pavement
              <select
                required
                disabled={predictionPending}
                value={draft.pavementSide}
                onChange={(event) => updatePrediction({
                  pavementSide: event.target.value as CalibrationPavementSide,
                })}
              >
                <option value="">Choose a side</option>
                <option value="left">Left in direction of travel</option>
                <option value="right">Right in direction of travel</option>
                <option value="centre">Centre or shared space</option>
              </select>
            </label>
            {resolvePrediction ? (
              <div className={`${styles.modelBinding} ${styles.field}`}>
                <strong>Production raster prediction</strong>
                <small>
                  ShadeRoute will calculate the bundled clear-sky raster model for the exact selected
                  pilot, coordinate and Europe/London time. It will not reveal physical-state controls
                  unless that result is frozen successfully.
                </small>
              </div>
            ) : (
              <label className={styles.field}>
                Manual model prediction at this point and time
                <select
                  required
                  value={draft.predictedState}
                  disabled={predictionPending}
                  onChange={(event) => updatePrediction({
                    predictedState: event.target.value as CalibrationPredictedState,
                  })}
                >
                  <option value="">Choose the displayed state</option>
                  <option value="sun">Direct sun</option>
                  <option value="shade">Shade</option>
                  <option value="uncertain">Uncertain</option>
                  <option value="unknown">No model coverage</option>
                  <option value="night">Night</option>
                </select>
                <small>
                  Manual protocol fallback: no raster resolver is connected. Copy the ShadeRoute state
                  for this exact point and time before checking physical sun or shade.
                </small>
              </label>
            )}
          </div>

          <label className={styles.choice} htmlFor={`${headingId}-prediction-first`}>
            <input
              id={`${headingId}-prediction-first`}
              type="checkbox"
              aria-label={resolvePrediction
                ? "Physical sun or shade not checked before model prediction"
                : "Model prediction recorded before checking physical sun or shade"}
              required
              disabled={predictionPending}
              checked={draft.predictionRecordedFirst}
              onChange={(event) => updatePrediction({ predictionRecordedFirst: event.target.checked })}
            />
            <span>
              <strong>
                {resolvePrediction
                  ? "I have not checked physical sun or shade at this point"
                  : "I recorded the model prediction before checking physical sun or shade"}
              </strong>
              <small>
                {resolvePrediction
                  ? "The exact point-and-time prediction will now be calculated and frozen before observed-state controls appear."
                  : "Observed-state controls are revealed only after the manual prediction is frozen."}
              </small>
            </span>
          </label>

          <button
            className="primary-button"
            type="submit"
            disabled={
              storageBlocked ||
              locationPending ||
              predictionPending ||
              availablePilotAreas.length === 0
            }
          >
            {predictionPending
              ? "Calculating and freezing…"
              : resolvePrediction
                ? "Calculate, freeze and continue"
                : "Freeze manual prediction and continue"}
          </button>
        </form>
      ) : (
        <div className={styles.observation}>
          <span className={styles.stepLabel}>Step 2 — record what is physically present</span>
          <div className={styles.locked}>
            <strong>Prediction frozen before observation</strong>
            <dl>
              <dt>Point</dt>
              <dd>{frozen.latitude}, {frozen.longitude}</dd>
              <dt>Planned point</dt>
              <dd>{frozen.plannedPointId} · {frozen.siteType.replaceAll("-", " ")}</dd>
              <dt>London time</dt>
              <dd>{formatLondonDateTime(frozen.observedLondonDateTime)}</dd>
              <dt>Prediction</dt>
              <dd>{predictedStateLabel(frozen.predictedState)}</dd>
              <dt>Pavement</dt>
              <dd>{frozen.pavementSide}</dd>
              <dt>Coordinate source</dt>
              <dd>{frozen.coordinateSource === "one-shot-gps" ? "One-shot browser GPS" : "Manual entry"}</dd>
              {frozen.locationAccuracyMetres !== undefined && (
                <>
                  <dt>GPS accuracy</dt>
                  <dd>Browser-reported radius {frozen.locationAccuracyMetres} m</dd>
                </>
              )}
              <dt>Release binding</dt>
              <dd>
                {frozen.modelVersion} · {frozen.dataPackVersion}<br />
                <span className={styles.fingerprint}>{frozen.dataPackFingerprint}</span>
              </dd>
            </dl>
          </div>

          <form className={styles.form} onSubmit={handleSaveObservation}>
            <div className={styles.grid}>
              <label className={styles.field}>
                Physical state at the point
                <select
                  required
                  value={observation.observedState}
                  onChange={(event) => setObservation({
                    ...observation,
                    observedState: event.target.value as CalibrationObservedState,
                  })}
                >
                  <option value="">Choose sun or shade</option>
                  <option value="sun">Direct sun</option>
                  <option value="shade">Shade</option>
                </select>
              </label>
              <label className={styles.field}>
                Visible-sun conditions
                <select
                  required
                  value={observation.weatherVisibility}
                  onChange={(event) => setObservation({
                    ...observation,
                    weatherVisibility: event.target.value as CalibrationWeatherVisibility,
                  })}
                >
                  <option value="">Choose conditions</option>
                  <option value="clear-direct-sun">Clear direct sunlight visible</option>
                  <option value="intermittent-sun">Intermittent sunlight</option>
                  <option value="overcast">Overcast</option>
                </select>
              </label>
              <label className={styles.field}>
                Leaf state
                <select
                  required
                  value={observation.leafState}
                  onChange={(event) => setObservation({
                    ...observation,
                    leafState: event.target.value as CalibrationLeafState,
                  })}
                >
                  <option value="">Choose leaf state</option>
                  <option value="leaf-on">Leaf on</option>
                  <option value="partial">Partial leaf</option>
                  <option value="leaf-off">Leaf off</option>
                  <option value="not-applicable">No relevant vegetation</option>
                </select>
              </label>
              <label className={styles.field}>
                Temporary conditions
                <input
                  type="text"
                  maxLength={500}
                  value={observation.temporaryConditions}
                  onChange={(event) => setObservation({
                    ...observation,
                    temporaryConditions: event.target.value,
                  })}
                  placeholder="Works hoarding, parked vehicle or temporary canopy"
                />
              </label>
              <label className={`${styles.field} ${styles.wide}`}>
                Observer notes
                <textarea
                  rows={3}
                  maxLength={1_000}
                  value={observation.observerNotes}
                  onChange={(event) => setObservation({
                    ...observation,
                    observerNotes: event.target.value,
                  })}
                  placeholder="Record anything needed to interpret this point"
                />
                <small>
                  One-shot GPS accuracy is recorded in its own structured field, not added to notes.
                </small>
              </label>
            </div>

            {observation.weatherVisibility && observation.weatherVisibility !== "clear-direct-sun" && (
              <p className={styles.warning}>
                Keep this disagreement visible, but do not count it as a clear-direct-sun classification check.
              </p>
            )}

            <div className={styles.actions}>
              <button className="primary-button" type="submit" disabled={storageBlocked}>
                Save fixed-point observation locally
              </button>
              <button className="text-button" type="button" onClick={discardFrozen}>
                Discard and start again
              </button>
            </div>
          </form>
        </div>
      )}

      {records.length > 0 && (
        <details className={styles.records}>
          <summary>On-device fixed-point observations ({records.length})</summary>
          <ol>
            {records.map((record) => (
              <li className={styles.record} key={record.observation_id}>
                <div className={styles.recordLine}>
                  <div>
                    <strong>{record.predicted_state} predicted · {record.observed_state} observed</strong>
                    <small>{record.pilot_area} · {formatLondonDateTime(record.observed_london_datetime)}</small>
                  </div>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => handleDelete(record.observation_id)}
                    aria-label={`Delete fixed-point observation ${record.observation_id}`}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}

      <p className={styles.privacy}>
        CSV export uses the repository&apos;s versioned fixed-point validation schema. It contains exact
        coordinates and notes, but no account, device identifier, route history, medical data or
        automatic save time. Coordinate source and browser-reported GPS accuracy are separate fields.
        The model, protocol, data-pack version and content fingerprint are bound automatically. Import
        accepts only that schema and never uploads the file.
      </p>
      <div className={styles.actions}>
        <button className="text-button" type="button" disabled={records.length === 0} onClick={handleExport}>
          Export calibration CSV
        </button>
        <button
          className="text-button"
          type="button"
          disabled={storageBlocked}
          onClick={() => fileInputRef.current?.click()}
        >
          Import calibration CSV
        </button>
        <input
          ref={fileInputRef}
          className={styles.hiddenInput}
          type="file"
          accept=".csv,text/csv"
          onChange={handleImport}
          tabIndex={-1}
        />
        {(records.length > 0 || storageUnreadable) && (
          confirmClear ? (
            <>
              <span>{storageUnreadable ? "Remove the unreadable local data?" : "Delete every fixed-point observation?"}</span>
              <button className="text-button" type="button" onClick={handleClear}>Confirm clear</button>
              <button
                ref={cancelClearRef}
                className="text-button"
                type="button"
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setConfirmClear(true);
                window.setTimeout(() => cancelClearRef.current?.focus(), 0);
              }}
            >
              {storageUnreadable ? "Clear unreadable data" : "Clear observations"}
            </button>
          )
        )}
      </div>

      <p className={styles.status} role="status" aria-live="polite">{status}</p>
      <small className={styles.limitation}>
        Preserve every disagreement. Do not describe the resulting percentage as model accuracy until
        the documented pilot coverage, timing and route-walk checks have been completed.
      </small>
      <CalibrationObserverRouteWalks />
    </section>
  );
}
