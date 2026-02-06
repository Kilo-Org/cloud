import type { SessionMetricsParams } from './session-metrics-schema';

export function captureSessionMetrics(params: SessionMetricsParams, env: Env): Promise<Response> {
	return fetch(`${env.POSTHOG_HOST}/capture/`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			api_key: env.POSTHOG_API_KEY,
			event: 'o11y_session_metrics',
			distinct_id: params.kiloUserId,
			properties: params,
		}),
	});
}
