/**
 * Converts timeseries data to the format expected by chart components.
 *
 * @param timeseriesData - Array of timestamp/value pairs
 * @returns Tuple of [timestamps in seconds, values]
 */
export function convertTimeseriesData(
  timeseriesData: Array<{ ts: string; value: number }>
): [number[], number[]] {
  const timestamps = timeseriesData.map(point => new Date(point.ts).getTime() / 1000);
  const values = timeseriesData.map(point => point.value);
  return [timestamps, values];
}
