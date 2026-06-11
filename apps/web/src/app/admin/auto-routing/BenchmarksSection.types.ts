import * as z from 'zod';
import { RoutingTableSchema } from '@kilocode/auto-routing-contracts';

export const BenchmarkRoutingTableResponseSchema = z.object({
  table: RoutingTableSchema.nullable(),
  publishedAt: z.string().nullable(),
});
export type BenchmarkRoutingTableResponse = z.infer<typeof BenchmarkRoutingTableResponseSchema>;
