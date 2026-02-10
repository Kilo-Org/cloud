import type { SessionMetricsParams } from './session-metrics-schema';

/**
 * Write a session metrics data point to Analytics Engine,
 * and dual-write a structured event to a Stream for R2/Snowflake export.
 *
 * AE Schema:
 *   index1  = platform (for per-platform querying)
 *   blob1   = terminationReason
 *   blob2   = platform
 *   blob3   = organizationId (or empty string)
 *   blob4   = kiloUserId
 *   blob5   = model (or empty string)
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
 *   double11 = ingestVersion
 */
export function writeSessionMetricsDataPoint(params: SessionMetricsParams, env: Env, waitUntil: (p: Promise<unknown>) => void): void {
	const totalTokensSum =
		params.totalTokens.input +
		params.totalTokens.output +
		params.totalTokens.reasoning +
		params.totalTokens.cacheRead +
		params.totalTokens.cacheWrite;

	env.O11Y_SESSION_METRICS.writeDataPoint({
		indexes: [params.platform],
		blobs: [params.terminationReason, params.platform, params.organizationId, params.kiloUserId, params.model],
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
			params.ingestVersion,
		],
	});

	waitUntil(
		env.SESSION_METRICS_STREAM.send([
			{
				platform: params.platform,
				termination_reason: params.terminationReason,
				organization_id: params.organizationId,
				kilo_user_id: params.kiloUserId,
				model: params.model,
				session_duration_ms: params.sessionDurationMs,
				time_to_first_response_ms: params.timeToFirstResponseMs ?? -1,
				total_turns: params.totalTurns,
				total_steps: params.totalSteps,
				total_errors: params.totalErrors,
				total_tokens: totalTokensSum,
				total_cost: params.totalCost,
				compaction_count: params.compactionCount,
				stuck_tool_call_count: params.stuckToolCallCount,
				auto_compaction_count: params.autoCompactionCount,
				ingest_version: params.ingestVersion,
			},
		]),
	);
}
