import type { z } from 'zod';
import type { ApiMetricsParamsSchema } from './api-metrics-routes';

type ApiMetricsParams = z.infer<typeof ApiMetricsParamsSchema>;

/**
 * Write an API metrics data point to Analytics Engine for alerting queries.
 *
 * Schema:
 *   blob1   = provider
 *   blob2   = resolvedModel
 *   blob3   = clientName
 *   blob4   = "1" if error (statusCode >= 400), "0" otherwise
 *   blob5   = inferenceProvider (best-effort)
 *   double1 = ttfbMs
 *   double2 = completeRequestMs
 *   double3 = statusCode
 */
export function writeApiMetricsDataPoint(params: ApiMetricsParams, clientName: string, env: Env): void {
	env.O11Y_API_METRICS.writeDataPoint({
		blobs: [params.provider, params.resolvedModel, clientName, params.statusCode >= 400 ? '1' : '0', params.inferenceProvider],
		doubles: [params.ttfbMs, params.completeRequestMs, params.statusCode],
	});
}
