import { z } from 'zod';

type TrpcUnauthorizedHandler = () => Promise<void> | void;

// Sign out only on the server's context-level auth failure (invalid/missing
// token), flagged via data.authRequired — NOT on every 401. A procedure-level
// UNAUTHORIZED (e.g. org-access denial) is also HTTP 401 but must be handled
// in-screen as a permission error, not by logging the whole app out.
const DirectUnauthorizedErrorSchema = z.looseObject({
  data: z.looseObject({ authRequired: z.literal(true) }),
});

const ShapedUnauthorizedErrorSchema = z.looseObject({
  shape: z.looseObject({
    data: z.looseObject({ authRequired: z.literal(true) }),
  }),
});

let unauthorizedHandler: TrpcUnauthorizedHandler | null = null;
let unauthorizedPromise: Promise<void> | null = null;

export function isUnauthorizedTrpcError(error: unknown): boolean {
  const direct = DirectUnauthorizedErrorSchema.safeParse(error);
  if (direct.success) {
    return true;
  }

  return ShapedUnauthorizedErrorSchema.safeParse(error).success;
}

export function setTrpcUnauthorizedHandler(handler: TrpcUnauthorizedHandler): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) {
      unauthorizedHandler = null;
    }
  };
}

export async function handleTrpcQueryError(error: unknown): Promise<void> {
  if (!isUnauthorizedTrpcError(error) || !unauthorizedHandler) {
    return;
  }

  // Single-flight: if a handler is already in progress, await its outcome
  // instead of dropping the error or starting a second rotation.
  if (unauthorizedPromise) {
    await unauthorizedPromise;
    return;
  }

  const handler = unauthorizedHandler;
  unauthorizedPromise = runUnauthorizedHandler(handler);
  await unauthorizedPromise;
}

async function runUnauthorizedHandler(handler: TrpcUnauthorizedHandler): Promise<void> {
  try {
    await handler();
  } catch {
    // A failed sign-out should not make every later 401 permanently ignored.
  } finally {
    unauthorizedPromise = null;
  }
}
