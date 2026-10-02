import { TRPCError } from '@trpc/server';

// Monadic Result type

export type SuccessResult<TOk = {}> = { success: true } & TOk;
export type CustomFailureResult<TErr> = { success: false } & TErr;
export type FailureResult<TErr = void> = { success: false; error: TErr };

/**
 *  equivalent to CustomResult<TOk, {error:TErr}>
 */
export type Result<TOk, TErr> = SuccessResult<TOk> | FailureResult<TErr>;

export type CustomResult<TOk, TErr> = SuccessResult<TOk> | CustomFailureResult<TErr>;
export type OptionalError<TErr> = Result<{}, TErr>;
export type OptionalValue<TOk> = Result<TOk, void>;

export function failureResult(): FailureResult<{}>;
export function failureResult<TErr>(error: TErr): FailureResult<TErr>;
export function failureResult<TErr = void>(error?: TErr): FailureResult<TErr | undefined> {
  return { error, success: false } as FailureResult<TErr | undefined>;
}
export function verifyOrError(ok: boolean): OptionalError<void>;
export function verifyOrError<TErr>(ok: boolean, error: TErr): OptionalError<TErr>;
export function verifyOrError<TErr = void>(
  ok: boolean,
  error?: TErr
): OptionalError<TErr | undefined> {
  return ok ? { success: true } : ({ error, success: false } as OptionalError<TErr | undefined>);
}

export function trpcFailure(
  ...opts: ConstructorParameters<typeof TRPCError>
): FailureResult<TRPCError> {
  return failureResult(new TRPCError(...opts));
}

export function successResult(): SuccessResult<{}>;
export function successResult<TOk>(okValue: TOk): SuccessResult<TOk>;
export function successResult<TOk>(okValue?: TOk): SuccessResult<TOk | {}> {
  return { ...okValue, success: true };
}

export function assertNoTrpcError<TOk>(result: Result<TOk, TRPCError>): SuccessResult<TOk> {
  if (result.success) return result;
  else throw result.error;
}
export function assertNoError<TOk, TErr>(result: CustomResult<TOk, TErr>): SuccessResult<TOk> {
  if (result.success) return result;
  throw result instanceof Error
    ? result
    : 'error' in result && result.error instanceof Error
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
    return `${error}`;
  } catch {
    /* ignore */
  }
  return typeof error;
}

export function whenOkTry<TOk, TOk2, TErr>(
  result: Result<TOk, TErr>,
  map: (val: TOk) => Result<TOk2, TErr>
): Result<TOk2, TErr> {
  if (!result.success) return result;
  return map(result);
}
export function whenOk<TOk, TOk2, TErr>(
  result: Result<TOk, TErr>,
  map: (val: TOk) => TOk2
): Result<TOk2, TErr> {
  if (!result.success) return result;
  return successResult(map(result));
}
