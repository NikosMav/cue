// Abort the underlying request when a stream stops making progress, and ignore
// late output from providers that cannot immediately stop their generator.
// An optional cancelSignal lets the caller stop the stream early (for example
// when a newer question replaces this answer); the returned promise then
// rejects with an error whose `cancelled` property is true.
async function streamWithWatchdog(stream, params, timeoutMs = 25000, cancelSignal = null) {
  const controller = new AbortController();
  let timer;
  let settled = false;
  let rearm;
  let onCancel = null;
  const stalled = new Promise((_resolve, reject) => {
    rearm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        settled = true;
        reject(new Error('The model stopped responding (timed out). Please try again.'));
        controller.abort();
      }, timeoutMs);
    };
    rearm();
  });
  const cancelled = new Promise((_resolve, reject) => {
    if (!cancelSignal) return;
    onCancel = () => {
      settled = true;
      const error = new Error('The request was cancelled.');
      error.cancelled = true;
      reject(error);
      controller.abort();
    };
    if (cancelSignal.aborted) onCancel();
    else cancelSignal.addEventListener('abort', onCancel, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => stream({
        ...params,
        signal: controller.signal,
        onToken: text => {
          if (settled) return;
          rearm();
          params.onToken(text);
        }
      })),
      stalled,
      cancelled
    ]);
  } finally {
    settled = true;
    clearTimeout(timer);
    if (onCancel) cancelSignal.removeEventListener('abort', onCancel);
    controller.abort();
  }
}

module.exports = { streamWithWatchdog };
