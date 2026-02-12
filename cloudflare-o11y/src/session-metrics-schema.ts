import { z } from 'zod';

export const TerminationReasons = ['completed', 'error', 'interrupted', 'abandoned', 'unknown'] as const;

export const SessionMetricsParamsSchema = z.object({
	kiloUserId: z.string().min(1),
	organizationId: z.string().optional().default(''),
	sessionId: z.string().min(1),
	platform: z.string().min(1),

	sessionDurationMs: z.number().int().nonnegative(),
	timeToFirstResponseMs: z.number().int().nonnegative().optional(),

	totalTurns: z.number().int().nonnegative(),
	totalSteps: z.number().int().nonnegative(),

	toolCallsByType: z.record(z.string(), z.number().int().nonnegative()),
	toolErrorsByType: z.record(z.string(), z.number().int().nonnegative()),

	totalErrors: z.number().int().nonnegative(),
	errorsByType: z.record(z.string(), z.number().int().nonnegative()),
	stuckToolCallCount: z.number().int().nonnegative(),

	totalTokens: z.object({
		input: z.number().int().nonnegative(),
		output: z.number().int().nonnegative(),
		reasoning: z.number().int().nonnegative(),
		cacheRead: z.number().int().nonnegative(),
		cacheWrite: z.number().int().nonnegative(),
	}),
	totalCost: z.number().nonnegative(),

	compactionCount: z.number().int().nonnegative(),
	autoCompactionCount: z.number().int().nonnegative(),

	terminationReason: z.enum(TerminationReasons),

	model: z.string().optional().default(''),

	ingestVersion: z.number().int().nonnegative().default(0),
});

export type SessionMetricsParams = z.infer<typeof SessionMetricsParamsSchema>;
