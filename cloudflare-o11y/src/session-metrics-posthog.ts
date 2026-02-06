import type { SessionMetricsParams } from './session-metrics-schema';

export async function captureSessionMetrics(params: SessionMetricsParams, env: Env): Promise<void> {
	try {
		const { ipAddress, ...properties } = params;

		const response = await fetch(`${env.POSTHOG_HOST}/capture/`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				api_key: env.POSTHOG_API_KEY,
				event: 'o11y_session_metrics',
				distinct_id: params.kiloUserId,
				// Forward the user's real IP so PostHog resolves GeoIP correctly
				...(ipAddress ? { ip: ipAddress } : {}),
				properties: {
					...properties,
					$process_person_profile: true,
				},
			}),
		});

		if (!response.ok) {
			console.error('PostHog session metrics capture failed', {
				status: response.status,
				body: await response.text().catch(() => '<unreadable>'),
			});
		}
	} catch (err) {
		console.error('PostHog session metrics capture failed', err);
	}
}
