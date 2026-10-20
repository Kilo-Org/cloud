export function scheduleCacheMaintenance(run: () => void): void {
  requestIdleCallback(run);
}
