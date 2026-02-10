/**
 * Slack notification delivery for SLO alerts.
 */

import type { AlertSeverity } from './slo-config';

type NotifyEnv = {
	O11Y_SLACK_WEBHOOK_PAGE: SecretsStoreSecret;
	O11Y_SLACK_WEBHOOK_TICKET: SecretsStoreSecret;
};

export type AlertType = 'error_rate' | 'ttfb';

export type AlertPayload = {
	severity: AlertSeverity;
	alertType: AlertType;
	provider: string;
	model: string;
	clientName: string;
	burnRate: number;
	burnRateThreshold: number;
	windowMinutes: number;
	totalRequests: number;
	slo: number;
	// Error rate specific
	currentRate?: number;
	// TTFB specific
	currentTtfbFraction?: number;
	ttfbThresholdMs?: number;
};

function formatAlertType(alertType: AlertPayload['alertType']): string {
	switch (alertType) {
		case 'error_rate':
			return 'Error Rate';
		case 'ttfb':
			return 'TTFB Latency';
	}
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(2)}%`;
}

function buildMetricLine(alert: AlertPayload): string {
	if (alert.alertType === 'ttfb') {
		const fraction = formatPercent(alert.currentTtfbFraction ?? 0);
		const budget = formatPercent(1 - alert.slo);
		return `${fraction} of requests exceeded ${alert.ttfbThresholdMs ?? 0}ms TTFB (budget: ${budget})`;
	}
	return `Error rate: ${formatPercent(alert.currentRate ?? 0)} (SLO: ${formatPercent(alert.slo)})`;
}

function buildSlackMessage(alert: AlertPayload): object {
	const severityLabel = alert.severity === 'page' ? ':rotating_light: PAGE' : ':ticket: TICKET';
	const typeLabel = formatAlertType(alert.alertType);

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
					text: `${buildMetricLine(alert)}\nRequests in window: ${alert.totalRequests.toLocaleString()}\nClient: ${alert.clientName}`,
				},
			},
		],
	};
}

export async function sendAlertNotification(alert: AlertPayload, env: NotifyEnv): Promise<void> {
	const webhookSecret = alert.severity === 'page' ? env.O11Y_SLACK_WEBHOOK_PAGE : env.O11Y_SLACK_WEBHOOK_TICKET;

	const webhookUrl = await webhookSecret.get();
	if (!webhookUrl) {
		throw new Error(`No Slack webhook configured for severity: ${alert.severity}`);
	}

	const body = buildSlackMessage(alert);

	const response = await fetch(webhookUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(5_000),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Slack webhook failed (${response.status}): ${text}`);
	}
}
