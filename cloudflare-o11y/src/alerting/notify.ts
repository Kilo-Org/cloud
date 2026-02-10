/**
 * Slack notification delivery for SLO alerts.
 */

import type { AlertSeverity } from './slo-config';

type NotifyEnv = {
	O11Y_SLACK_WEBHOOK_PAGE: SecretsStoreSecret;
	O11Y_SLACK_WEBHOOK_TICKET: SecretsStoreSecret;
};

export type AlertPayload = {
	severity: AlertSeverity;
	alertType: 'error_rate';
	provider: string;
	model: string;
	clientName: string;
	burnRate: number;
	burnRateThreshold: number;
	windowMinutes: number;
	// For error rate alerts
	currentRate?: number;
	// Common
	totalRequests: number;
	slo: number;
};

function formatAlertType(alertType: AlertPayload['alertType']): string {
	switch (alertType) {
		case 'error_rate':
			return 'Error Rate';
	}
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(2)}%`;
}

function buildSlackMessage(alert: AlertPayload): object {
	const severityLabel = alert.severity === 'page' ? ':rotating_light: PAGE' : ':ticket: TICKET';
	const typeLabel = formatAlertType(alert.alertType);

	const metricLine = `Error rate: ${formatPercent(alert.currentRate ?? 0)} (SLO: ${formatPercent(alert.slo)})`;

	return {
		blocks: [
			{
				type: 'header',
				text: {
					type: 'plain_text',
					text: `${severityLabel} — LLM ${typeLabel} SLO Breach`,
				},
			},
			{
				type: 'section',
				fields: [
					{ type: 'mrkdwn', text: `*Provider:*\n${alert.provider}` },
					{ type: 'mrkdwn', text: `*Model:*\n${alert.model}` },
					{
						type: 'mrkdwn',
						text: `*Burn rate:*\n${alert.burnRate.toFixed(1)}x (threshold: ${alert.burnRateThreshold}x)`,
					},
					{ type: 'mrkdwn', text: `*Window:*\n${alert.windowMinutes} min` },
				],
			},
			{
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: `${metricLine}\nRequests in window: ${alert.totalRequests.toLocaleString()}\nClient: ${alert.clientName}`,
				},
			},
		],
	};
}

export async function sendAlertNotification(alert: AlertPayload, env: NotifyEnv): Promise<void> {
	const webhookSecret = alert.severity === 'page' ? env.O11Y_SLACK_WEBHOOK_PAGE : env.O11Y_SLACK_WEBHOOK_TICKET;

	const webhookUrl = await webhookSecret.get();
	if (!webhookUrl) {
		console.error(`No Slack webhook configured for severity: ${alert.severity}`);
		return;
	}

	const body = buildSlackMessage(alert);

	try {
		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(5_000),
		});

		if (!response.ok) {
			const text = await response.text();
			console.error(`Slack webhook failed (${response.status}): ${text}`);
		}
	} catch (err) {
		console.error(`Slack webhook request failed: ${err instanceof Error ? err.message : err}`);
	}
}
