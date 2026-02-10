import type { z } from 'zod';
import type { ApiMetricsParamsSchema } from './api-metrics-routes';

type ApiMetricsParams = z.infer<typeof ApiMetricsParamsSchema>;

/**
 * Write an API metrics data point to Analytics Engine for alerting queries,
 * and dual-write a structured event to Pipelines for R2/Snowflake export.
 *
 * AE Schema:
 *   blob1   = provider
 *   blob2   = resolvedModel
 *   blob3   = clientName
 *   blob4   = "1" if error (statusCode >= 400), "0" otherwise
 *   blob5   = inferenceProvider (best-effort)
 *   double1 = ttfbMs
 *   double2 = completeRequestMs
 *   double3 = statusCode
 */
export function writeApiMetricsDataPoint(
	params: ApiMetricsParams,
	clientName: string,
	env: Env,
	waitUntil: (p: Promise<unknown>) => void,
): void {
	const isError = params.statusCode >= 400;

	env.O11Y_API_METRICS.writeDataPoint({
		blobs: [params.provider, params.resolvedModel, clientName, isError ? '1' : '0', params.inferenceProvider],
		doubles: [params.ttfbMs, params.completeRequestMs, params.statusCode],
	});

	waitUntil(
		env.PIPELINE_API_METRICS.send([
			{
				provider: params.provider,
				resolved_model: params.resolvedModel,
				client_name: clientName,
				is_error: isError,
				inference_provider: params.inferenceProvider,
				ttfb_ms: params.ttfbMs,
				complete_request_ms: params.completeRequestMs,
				status_code: params.statusCode,
			},
		]).catch((err: unknown) => console.error('Pipeline send failed (api-metrics):', err)),
	);
}
