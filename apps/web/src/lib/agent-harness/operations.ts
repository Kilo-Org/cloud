import 'server-only';
import { TRPCError } from '@trpc/server';
import { HarnessOperationSchema, bounded, harnessOperationFailure } from './operation-contract';
import { executeHarnessMaintenance, retirement } from './operation-maintenance';
import { executeHarnessDispatch } from './operation-dispatch';
import { executeHarnessProviders } from './operation-providers';

export { harnessOperationFailure } from './operation-contract';

export async function executeHarnessOperation(token: string, raw: unknown, signal: AbortSignal) {
  try {
    const parsed = HarnessOperationSchema.safeParse(raw);
    if (!parsed.success) return harnessOperationFailure(new TRPCError({ code: 'BAD_REQUEST' }));
    const input = bounded(parsed.data);
    switch (input.type) {
      case 'retirement':
        return { result: await retirement(input, token) };
      case 'read':
      case 'history':
      case 'projection':
        return await executeHarnessMaintenance(input, token);
      case 'execute':
      case 'reconcile':
        if (
          input.request.name === 'mcp.discover' ||
          input.request.name === 'mcp.call' ||
          input.request.name === 'web.search' ||
          input.request.name === 'web.retrieve'
        )
          return await executeHarnessProviders(input, token, signal);
        return await executeHarnessDispatch(input, token, signal);
    }
  } catch (error) {
    return harnessOperationFailure(error);
  }
}
