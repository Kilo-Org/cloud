import type { inferRouterOutputs } from '@trpc/server';

import type { RootRouter } from '@/routers/root-router';

type RouterOutputs = inferRouterOutputs<RootRouter>;

export type KiloPassSubscription = NonNullable<
  RouterOutputs['kiloPass']['getState']['subscription']
>;
