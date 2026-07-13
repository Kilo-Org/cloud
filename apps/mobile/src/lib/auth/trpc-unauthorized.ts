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
let isHandlingUnauthorized = false;

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

export function handleTrpcQueryError(error: unknown): void {
  if (!isUnauthorizedTrpcError(error) || !unauthorizedHandler || isHandlingUnauthorized) {
    return;
  }

  const handler = unauthorizedHandler;
  void runUnauthorizedHandler(handler);
}

async function runUnauthorizedHandler(handler: TrpcUnauthorizedHandler): Promise<void> {
  isHandlingUnauthorized = true;
  try {
    await handler();
  } catch {
    // A failed sign-out should not make every later 401 permanently ignored.
  } finally {
    isHandlingUnauthorized = false;
  }
}
