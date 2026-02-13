import type { z } from 'zod';
import type { ApiMetricsParamsSchema } from './api-metrics-routes';

type ApiMetricsParams = z.infer<typeof ApiMetricsParamsSchema>;

/**
 * Write an API metrics data point to Analytics Engine for alerting queries,
 * and dual-write a structured event to a Stream for R2/Snowflake export.
 *
 * AE Schema:
 *   index1  = resolvedModel (sampling key — ensures equitable sampling per model)
 *   blob1   = provider
 *   blob2   = resolvedModel
 *   blob3   = clientName
 *   blob4   = "1" if error (statusCode >= 400), "0" otherwise
 *   blob5   = inferenceProvider (best-effort)
 *   blob6   = "1" if userByok, "0" otherwise
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
		indexes: [params.resolvedModel],
		blobs: [params.provider, params.resolvedModel, clientName, isError ? '1' : '0', params.inferenceProvider, params.userByok ? '1' : '0'],
		doubles: [params.ttfbMs, params.completeRequestMs, params.statusCode],
	});

	waitUntil(
		// Changing this schema? Stream schemas are immutable — run:
		//   ./pipelines/recreate-stream.sh o11y_api_metrics_stream pipelines/api-metrics-schema.json \
		//     o11y_api_metrics_pipeline o11y_api_metrics_sink API_METRICS_STREAM
		env.API_METRICS_STREAM.send([
			{
				provider: params.provider,
				resolved_model: params.resolvedModel,
				client_name: clientName,
				is_error: isError,
				inference_provider: params.inferenceProvider,
				user_byok: params.userByok,
				ttfb_ms: params.ttfbMs,
				complete_request_ms: params.completeRequestMs,
				status_code: params.statusCode,
			},
		]),
	);
}
