import type { RootRouter } from '@/routers/root-router';
import { createTRPCContext } from '@trpc/tanstack-react-query';

export const {
  TRPCProvider,
  useTRPC,
  // this provies raw access to tRPC outside of any tanstack query integration
  useTRPCClient: useRawTRPCClient,
} = createTRPCContext<RootRouter>();
