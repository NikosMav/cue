// Abort the underlying request when a stream stops making progress, and ignore
// late output from providers that cannot immediately stop their generator.
async function streamWithWatchdog(stream, params, timeoutMs = 25000) {
  const controller = new AbortController();
  let timer;
  let settled = false;
  let rearm;
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
      stalled
    ]);
  } finally {
    settled = true;
    clearTimeout(timer);
    controller.abort();
  }
}

module.exports = { streamWithWatchdog };
