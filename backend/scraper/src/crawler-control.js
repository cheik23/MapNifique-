export function bindLeaseAbortSignal(crawler, signal) {
  if (!signal) return async () => {};

  let stopPromise = null;
  const stop = () => {
    if (stopPromise) return;

    stopPromise = (async () => {
      // `run()` marks the crawler running before it asynchronously creates its pool.
      while (crawler.running && !crawler.autoscaledPool) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      const pool = crawler.autoscaledPool;
      if (!crawler.running || !pool) return;

      // Stop accepting work, let current handlers observe the signal and finish,
      // then release the run loop. Crawlee documents that abort alone does not
      // cancel active handler chains.
      await pool.pause();
      await pool.abort();
    })();

    void stopPromise.catch(() => {});
  };

  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();

  return async () => {
    signal.removeEventListener('abort', stop);
    await stopPromise;
  };
}
