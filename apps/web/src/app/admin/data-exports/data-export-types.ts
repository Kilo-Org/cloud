import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

type RouterOutputs = inferRouterOutputs<RootRouter>;

export type DataExportSummary = RouterOutputs['admin']['userDataExports']['summary'];
export type DataExportListRow = RouterOutputs['admin']['userDataExports']['list']['rows'][number];
export type DataExportDetail = RouterOutputs['admin']['userDataExports']['detail'];
export type DataExportOutboxItem = DataExportDetail['outbox']['items'][number];
export type DataExportHealth = DataExportListRow['health'];
