import { TRPCError } from '@trpc/server';

// Monadic Result type

// A result that carries no fields of its own.
type NoFields = Record<never, never>;

/**
 * The payload a success result may carry.
 *
 * `successResult` merges its payload with an object spread, which copies own
 * enumerable properties only. Anything else loses the value its type promises:
 * a primitive is dropped, an array arrives as index properties, and a function
 * as an empty object. Objects such as `Date`, `Map` and `Promise` keep their
 * state in internal slots, so they arrive as an empty object too.
 */
type SuccessFields = object;

/**
 * Rejects every payload the object spread would reshape or drop.
 *
 * The `Record` check is the effective one: it requires the fields the spread
 * would copy. Arrays and callables are named first because they satisfy
 * `Record` and would otherwise pass.
 */
type SpreadablePayload<TOk> = TOk extends readonly unknown[]
  ? never
  : TOk extends (...args: never[]) => unknown
    ? never
    : TOk extends Record<string, unknown>
      ? TOk
      : never;

export type SuccessResult<TOk extends SuccessFields = NoFields> = { success: true } & TOk;
export type CustomFailureResult<TErr> = { success: false } & TErr;
export type FailureResult<TErr = void> = { success: false; error: TErr };

/**
 *  equivalent to CustomResult<TOk, {error:TErr}>
 */
export type Result<TOk extends SuccessFields, TErr> = SuccessResult<TOk> | FailureResult<TErr>;

export type CustomResult<TOk extends SuccessFields, TErr> =
  | SuccessResult<TOk>
  | CustomFailureResult<TErr>;
export type OptionalError<TErr> = Result<NoFields, TErr>;
export type OptionalValue<TOk extends SuccessFields> = Result<TOk, void>;

export function failureResult(): FailureResult<undefined>;
export function failureResult<TErr>(error: TErr): FailureResult<TErr>;
export function failureResult<TErr = void>(error?: TErr): FailureResult<TErr | undefined> {
  return { error, success: false };
}
export function verifyOrError(ok: boolean): OptionalError<void>;
export function verifyOrError<TErr>(ok: boolean, error: TErr): OptionalError<TErr>;
export function verifyOrError<TErr = void>(
  ok: boolean,
  error?: TErr
): OptionalError<TErr | undefined> {
  return ok ? { success: true } : { error, success: false };
}

export function trpcFailure(
  ...opts: ConstructorParameters<typeof TRPCError>
): FailureResult<TRPCError> {
  return failureResult(new TRPCError(...opts));
}

function mergeSuccessPayload<TOk extends SuccessFields>(
  okValue: TOk | undefined
): SuccessResult<TOk | NoFields> {
  return { ...okValue, success: true };
}

export function successResult(): SuccessResult<NoFields>;
export function successResult<TOk extends SuccessFields>(
  okValue: TOk & SpreadablePayload<TOk>
): SuccessResult<TOk>;
export function successResult<TOk extends SuccessFields>(
  okValue?: TOk
): SuccessResult<TOk | NoFields> {
  return mergeSuccessPayload(okValue);
}

export function assertNoTrpcError<TOk extends SuccessFields>(
  result: Result<TOk, TRPCError>
): SuccessResult<TOk> {
  if (result.success) return result;
  else throw result.error;
}
export function assertNoError<TOk extends SuccessFields, TErr>(
  result: CustomResult<TOk, TErr>
): SuccessResult<TOk> {
  if (result.success) return result;
  throw 'error' in result && result.error instanceof Error
    ? result.error
    : new Error('Not OK:' + serializeError(result));
}

function serializeError(error: unknown) {
  try {
    return JSON.stringify(error);
  } catch {
    /* ignore */
  }
  try {
    return String(error);
  } catch {
    /* ignore */
  }
  return typeof error;
}

export function whenOkTry<TOk extends SuccessFields, TOk2 extends SuccessFields, TErr>(
  result: Result<TOk, TErr>,
  map: (val: TOk) => Result<TOk2, TErr>
): Result<TOk2, TErr> {
  if (!result.success) return result;
  return map(result);
}
export function whenOk<TOk extends SuccessFields, TOk2 extends SuccessFields, TErr>(
  result: Result<TOk, TErr>,
  map: (val: TOk) => TOk2 & SpreadablePayload<TOk2>
): Result<TOk2, TErr> {
  if (!result.success) return result;
  return mergeSuccessPayload(map(result));
}
