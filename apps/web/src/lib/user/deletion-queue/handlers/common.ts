import { and, eq } from 'drizzle-orm';
import {
  user_deletion_steps,
  type UserDeletionRequest,
  type UserDeletionStep,
} from '@kilocode/db/schema';
import { UserDeletionStepStatus, type UserDeletionTaskProgress } from '@kilocode/db/schema-types';
import { db } from '@/lib/drizzle';
import {
  USER_DELETION_PROVIDER_TIMEOUT_MS,
  USER_DELETION_STOP_STARTING_RESERVE_MS,
} from '@/lib/user/deletion-queue/deletion-constants';
import {
  classifyFetchFailure,
  classifyHttpStatus,
  parseRetryAfterMs,
} from '@/lib/user/deletion-queue/deletion-http';
import { hmacResourceRef } from '@/lib/user/deletion-queue/deletion-hmac';
import type {
  DeletionHandlerContext,
  DeletionHandlerOutcome,
} from '@/lib/user/deletion-queue/deletion-types';

export type DeletionHandler = (params: {
  request: UserDeletionRequest;
  step: UserDeletionStep;
  context: DeletionHandlerContext;
}) => Promise<DeletionHandlerOutcome>;

export function shouldStopStarting(context: DeletionHandlerContext): boolean {
  return context.signal.aborted || context.remainingMs() < USER_DELETION_STOP_STARTING_RESERVE_MS;
}

export function continueIfLowTime(
  context: DeletionHandlerContext,
  progress?: UserDeletionTaskProgress
): DeletionHandlerOutcome | null {
  if (!shouldStopStarting(context)) return null;
  return { kind: 'continue', progress };
}

export function providerTimeoutMs(context: DeletionHandlerContext): number {
  return Math.max(1, Math.min(USER_DELETION_PROVIDER_TIMEOUT_MS, context.remainingMs()));
}

export function providerAbortSignal(
  context: DeletionHandlerContext,
  extra?: AbortSignal
): AbortSignal {
  const signals: AbortSignal[] = [context.signal, AbortSignal.timeout(providerTimeoutMs(context))];
  if (extra) signals.push(extra);
  return AbortSignal.any(signals);
}

export function configurationMissing(): DeletionHandlerOutcome {
  return { kind: 'needs_attention', errorCode: 'configuration_missing' };
}

export function resourceHmac(id: string): string {
  return hmacResourceRef(id);
}

export function requireTargetEmail(request: UserDeletionRequest): string | DeletionHandlerOutcome {
  const email = request.target_email?.trim() ?? '';
  if (!email) {
    return { kind: 'needs_attention', errorCode: 'target_email_missing' };
  }
  return email;
}

export function classifyResponse(response: Response): DeletionHandlerOutcome {
  if (response.status === 429) {
    return {
      kind: 'rate_limited',
      retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')) ?? 60_000,
    };
  }
  return classifyHttpStatus(response.status);
}

export async function deletionFetch(
  context: DeletionHandlerContext,
  url: string,
  init: RequestInit
): Promise<{ response: Response } | { outcome: DeletionHandlerOutcome }> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: providerAbortSignal(context, init.signal ?? undefined),
    });
    return { response };
  } catch (error) {
    return { outcome: classifyFetchFailure(error) };
  }
}

export async function readJsonUnknown(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function assertCurrentClaim(
  context: DeletionHandlerContext
): Promise<DeletionHandlerOutcome | null> {
  const [step] = await db
    .select({ id: user_deletion_steps.id })
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, context.requestId),
        eq(user_deletion_steps.step_key, context.stepKey),
        eq(user_deletion_steps.claim_token, context.claimToken),
        eq(user_deletion_steps.status, UserDeletionStepStatus.Running)
      )
    )
    .limit(1);
  if (step) return null;
  return { kind: 'retry', errorCode: 'claim_lost', httpStatusClass: 'error' };
}

export function incrementProcessed(
  progress: UserDeletionTaskProgress | undefined,
  by = 1
): UserDeletionTaskProgress {
  return {
    ...progress,
    processed_count: (progress?.processed_count ?? 0) + by,
  };
}
