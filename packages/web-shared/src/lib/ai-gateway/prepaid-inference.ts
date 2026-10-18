import 'server-only';

import { after, NextResponse } from 'next/server';
import {
  releaseInferenceCredits,
  reserveInferenceCredits,
} from '@kilocode/db/inference-reservations';
import {
  INFERENCE_RESERVATION_STATE_HEADER,
  InferenceReservationResultSchema,
  type InferenceReservationCommand,
  type InferenceReservationIdentity,
  type InferenceReservationResult,
} from '@kilocode/usage-contracts';
import {
  INTERNAL_API_SECRET,
  isPrepaidInferenceReservationsEnabled,
} from '@kilocode/web-shared/lib/config.server';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { db, isUSRegion } from '@kilocode/web-shared/lib/drizzle';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { quoteInferenceReservation } from './reservation-quote';

const ADMISSION_BUDGET_MS = 3_000;
const RESERVATION_PATH = '/api/internal/inference/reservations';

export type PrepaidInferenceInput = InferenceReservationIdentity & {
  apiKind: string;
  model: string;
  providerId: string;
  body: unknown;
  zeroCost: boolean;
  signal?: AbortSignal;
};

export type PrepaidInferenceAdmission =
  | { kind: 'admitted'; reservationId?: string }
  | { kind: 'rejected'; response: NextResponse };

export async function executeLocalInferenceReservation(
  command: InferenceReservationCommand
): Promise<InferenceReservationResult> {
  if (command.action === 'reserve') {
    if (!isPrepaidInferenceReservationsEnabled()) {
      throw new Error('Prepaid inference admission is disabled');
    }
    return reserveInferenceCredits(db, command);
  }
  if (command.action !== 'release') throw new Error('Invalid ledger command');
  await db.transaction(tx => releaseInferenceCredits(tx, command));
  return { kind: 'released' };
}

async function executeReservationCommand(
  command: InferenceReservationCommand,
  deadline: number
): Promise<InferenceReservationResult> {
  if (!isUSRegion()) return executeLocalInferenceReservation(command);
  if (!INTERNAL_API_SECRET || !APP_URL) {
    throw new Error('Primary inference admission is unavailable');
  }
  const response = await fetch(new URL(RESERVATION_PATH, APP_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-api-key': INTERNAL_API_SECRET },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Primary inference admission failed');
  const result = InferenceReservationResultSchema.parse(await response.json());
  if (
    result.kind === 'reserved' &&
    (result.requestId !== command.requestId ||
      command.action !== 'reserve' ||
      result.amountMicrodollars !== command.amountMicrodollars)
  ) {
    throw new Error('Primary inference admission identity differs');
  }
  return result;
}

export async function cancelPrepaidInference(
  identity: InferenceReservationIdentity
): Promise<void> {
  const deadline = Date.now() + ADMISSION_BUDGET_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await executeReservationCommand({ action: 'release', ...identity }, deadline);
      return;
    } catch {
      if (attempt === 1 || Date.now() >= deadline) {
        console.error('Prepaid inference cancellation requires reconciliation');
        return;
      }
    }
  }
}

export async function admitPrepaidInference(
  input: PrepaidInferenceInput
): Promise<PrepaidInferenceAdmission> {
  if (!isPrepaidInferenceReservationsEnabled() || input.zeroCost) return { kind: 'admitted' };
  if (input.signal?.aborted) {
    return {
      kind: 'rejected',
      response: new NextResponse(null, {
        status: 499,
        headers: { [INFERENCE_RESERVATION_STATE_HEADER]: 'none' },
      }),
    };
  }

  const deadline = Date.now() + ADMISSION_BUDGET_MS;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Prepaid inference admission timed out')),
      ADMISSION_BUDGET_MS
    );
  });
  const identity: InferenceReservationIdentity = {
    requestId: input.requestId,
    userId: input.userId,
    organizationId: input.organizationId,
  };
  const operations: Promise<InferenceReservationResult>[] = [];
  let admitted = false;
  let definitelyNoHold = false;

  try {
    const quote = await Promise.race([quoteInferenceReservation(input), expired]);
    if (quote.kind === 'unsupported') {
      return {
        kind: 'rejected',
        response: NextResponse.json(
          {
            error: 'Request cost cannot be bounded',
            error_type: ProxyErrorType.temporarily_unavailable,
            message:
              'This request cannot be authorized safely. Please use another model or contact support.',
          },
          { status: 503, headers: { [INFERENCE_RESERVATION_STATE_HEADER]: 'none' } }
        ),
      };
    }
    if (input.signal?.aborted) {
      return {
        kind: 'rejected',
        response: new NextResponse(null, {
          status: 499,
          headers: { [INFERENCE_RESERVATION_STATE_HEADER]: 'none' },
        }),
      };
    }
    if (quote.amountMicrodollars === 0) return { kind: 'admitted' };
    if (!Number.isSafeInteger(quote.amountMicrodollars) || quote.amountMicrodollars < 0) {
      throw new Error('Invalid prepaid inference ceiling');
    }

    // A timed-out primary call can still commit. Cancellation must outlive the response and
    // leave a terminal tombstone so a late reservation cannot restore spendable credit.
    after(async () => {
      await Promise.allSettled(operations);
      if (!admitted && !definitelyNoHold) await cancelPrepaidInference(identity);
    });
    for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt++) {
      try {
        const operation = executeReservationCommand(
          { action: 'reserve', ...identity, amountMicrodollars: quote.amountMicrodollars },
          deadline
        );
        operations.push(operation);
        const result = await Promise.race([operation, expired]);
        if (result.kind === 'insufficient') {
          if (operations.length !== 1) break;
          definitelyNoHold = true;
          return {
            kind: 'rejected',
            response: NextResponse.json(
              {
                error: 'Insufficient available credits',
                error_type: ProxyErrorType.insufficient_credits,
                message:
                  'Available credits do not cover this request. Some credits may be reserved by active requests.',
              },
              { status: 402, headers: { [INFERENCE_RESERVATION_STATE_HEADER]: 'none' } }
            ),
          };
        }
        if (result.kind !== 'reserved')
          throw new Error('Invalid prepaid inference admission result');
        if (input.signal?.aborted) {
          return { kind: 'rejected', response: new NextResponse(null, { status: 499 }) };
        }
        admitted = true;
        return { kind: 'admitted', reservationId: result.requestId };
      } catch {
        if (attempt === 1 || Date.now() >= deadline) break;
      }
    }
  } catch {
    console.warn('Prepaid inference admission unavailable');
  } finally {
    clearTimeout(timer);
  }

  return {
    kind: 'rejected',
    response: NextResponse.json(
      {
        error: 'Credit authorization unavailable',
        error_type: ProxyErrorType.temporarily_unavailable,
        message: 'Credit authorization is temporarily unavailable. Please retry.',
      },
      {
        status: 503,
        headers: {
          'retry-after': '1',
          [INFERENCE_RESERVATION_STATE_HEADER]: operations.length ? 'unknown' : 'none',
        },
      }
    ),
  };
}
