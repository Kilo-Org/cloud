import type { SessionMetricsParams } from './session-metrics-schema';

/**
 * Write a session metrics data point to Analytics Engine.
 *
 * Schema:
 *   index1  = platform (for per-platform querying)
 *   blob1   = terminationReason
 *   blob2   = platform
 *   blob3   = organizationId (or empty string)
 *   double1 = sessionDurationMs
 *   double2 = timeToFirstResponseMs (-1 if N/A)
 *   double3 = totalTurns
 *   double4 = totalSteps
 *   double5 = totalErrors
 *   double6 = total tokens (sum of all token fields)
 *   double7 = totalCost
 *   double8 = compactionCount
 *   double9 = stuckToolCallCount
 *   double10 = autoCompactionCount
 */
export function writeSessionMetricsDataPoint(params: SessionMetricsParams, env: Env): void {
	const totalTokensSum =
		params.totalTokens.input +
		params.totalTokens.output +
		params.totalTokens.reasoning +
		params.totalTokens.cacheRead +
		params.totalTokens.cacheWrite;

	env.O11Y_SESSION_METRICS.writeDataPoint({
		indexes: [params.platform],
		blobs: [params.terminationReason, params.platform, params.organizationId ?? ''],
		doubles: [
			params.sessionDurationMs,
			params.timeToFirstResponseMs ?? -1,
			params.totalTurns,
			params.totalSteps,
			params.totalErrors,
			totalTokensSum,
			params.totalCost,
			params.compactionCount,
			params.stuckToolCallCount,
			params.autoCompactionCount,
		],
	});
}
