const MAX_CAUSE_DEPTH = 4;

type ErrorCauseDescription = {
  name?: string;
  code?: string;
  severity?: string;
  routine?: string;
  message?: string;
};

export type WorkerDbErrorDescription = {
  error: string;
  stack?: string;
  causes?: ErrorCauseDescription[];
};

function stringField(value: object, key: string): string | undefined {
  const field: unknown = Reflect.get(value, key);
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/**
 * PostgreSQL puts the rejected input into the messages of data exceptions (class 22, such as
 * `invalid input syntax for type uuid: "..."`) and the text of `RAISE` (class P0). Those messages
 * are left out. Other PostgreSQL messages name objects, not values. A cause without a SQLSTATE
 * comes from pg, pg-pool or the socket, such as a connection timeout or a Hyperdrive pool error.
 */
function mayLogCauseMessage(code: string | undefined): boolean {
  return code === undefined || !(code.startsWith('22') || code.startsWith('P0'));
}

function describeCause(cause: object): ErrorCauseDescription {
  const description: ErrorCauseDescription = {};
  const name = stringField(cause, 'name');
  if (name !== undefined) description.name = name;
  const code = stringField(cause, 'code');
  if (code !== undefined) description.code = code;
  const severity = stringField(cause, 'severity');
  if (severity !== undefined) description.severity = severity;
  const routine = stringField(cause, 'routine');
  if (routine !== undefined) description.routine = routine;
  const message =
    cause instanceof Error ? messageWithoutParams(cause) : stringField(cause, 'message');
  if (message !== undefined && mayLogCauseMessage(code)) description.message = message;
  return description;
}

/**
 * drizzle wraps a failed statement in `Failed query: <sql>\nparams: <values>`. The values can hold
 * tokens and personal data, so the message keeps only the statement.
 */
function messageWithoutParams(error: Error): string {
  const query: unknown = Reflect.get(error, 'query');
  if (typeof query === 'string' && error.message.startsWith('Failed query: ')) {
    return `Failed query: ${query}`;
  }
  return error.message;
}

/**
 * Log fields for an error that can come from a Worker DB call. drizzle's message names only the
 * statement, and the reason sits in `cause`: the SQLSTATE (`57014` statement timeout, `55P03`
 * lock timeout, `25P03` idle-in-transaction timeout) or a pool or connection failure. The fields
 * never hold query parameters or `detail`, which can quote row values.
 */
export function describeWorkerDbError(error: unknown): WorkerDbErrorDescription {
  if (!(error instanceof Error)) return { error: String(error) };
  const description: WorkerDbErrorDescription = { error: messageWithoutParams(error) };
  if (error.stack !== undefined) {
    description.stack = error.stack.replace(error.message, description.error);
  }
  const causes: ErrorCauseDescription[] = [];
  let cause: unknown = error.cause;
  while (typeof cause === 'object' && cause !== null && causes.length < MAX_CAUSE_DEPTH) {
    causes.push(describeCause(cause));
    cause = Reflect.get(cause, 'cause');
  }
  if (causes.length > 0) description.causes = causes;
  return description;
}
