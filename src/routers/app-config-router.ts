import { publicProcedure, createTRPCRouter } from '@/lib/trpc/init';

export const appConfigRouter = createTRPCRouter({
  getMinVersion: publicProcedure.query(() => ({
    minBuild: Number(process.env.APP_MIN_BUILD ?? '1'),
    otaForceUpdate: process.env.APP_OTA_FORCE_UPDATE === 'true',
  })),
});
