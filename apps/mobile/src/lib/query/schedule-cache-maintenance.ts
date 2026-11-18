export function scheduleCacheMaintenance(run: () => void): void {
  let completed = false;
  const flush = () => {
    if (completed) {
      return;
    }
    completed = true;
    cancelIdleCallback(idle);
    clearTimeout(fallback);
    run();
  };
  const fallback = setTimeout(flush, 500);
  const idle = requestIdleCallback(flush, { timeout: 500 });
}
