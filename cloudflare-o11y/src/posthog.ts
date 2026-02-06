import type { z } from 'zod';
import type { ApiMetricsParamsSchema } from './index';

type ApiMetricsParams = z.infer<typeof ApiMetricsParamsSchema>;

export function captureApiMetrics(params: ApiMetricsParams, clientName: string, env: Env): Promise<Response> {
	const { clientSecret: _, ipAddress, ...properties } = params;

	return fetch(`${env.POSTHOG_HOST}/capture/`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			api_key: env.POSTHOG_API_KEY,
			event: 'o11y_api_metrics',
			distinct_id: params.kiloUserId,
			// Forward the user's real IP so PostHog resolves GeoIP from it
			// rather than the worker's IP.
			...(ipAddress ? { ip: ipAddress } : {}),
			properties: {
				...properties,
				clientName,
				$process_person_profile: !params.isAnonymous,
			},
		}),
	});
}
