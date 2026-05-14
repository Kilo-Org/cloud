import { z } from 'zod';

type TrpcUnauthorizedHandler = () => Promise<void> | void;

const DirectUnauthorizedErrorSchema = z.looseObject({
  data: z.looseObject({ httpStatus: z.literal(401) }),
});

const ShapedUnauthorizedErrorSchema = z.looseObject({
  shape: z.looseObject({
    data: z.looseObject({ httpStatus: z.literal(401) }),
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
