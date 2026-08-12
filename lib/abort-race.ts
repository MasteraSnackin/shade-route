function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Settle when either the work settles or the signal aborts. This is stronger
 * than merely passing `signal` to an external implementation, which may ignore
 * cancellation while awaiting response headers or consuming a response body.
 */
export async function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);

  let rejectForAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", rejectForAbort, { once: true });
  });

  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (rejectForAbort) signal.removeEventListener("abort", rejectForAbort);
  }
}
