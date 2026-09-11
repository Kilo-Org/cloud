import { describe, expect, it } from 'vitest';
import { interruptControlSession } from './control-plane-session.js';

const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const RUNTIME_A = '11111111-1111-4111-8111-111111111111';
const RUNTIME_B = '22222222-2222-4222-8222-222222222222';

describe('interruptControlSession', () => {
  it('reuses one captured Stop request after the first Durable Object reply is lost', async () => {
    let stateCalls = 0;
    const deliveries: unknown[] = [];
    let current = {
      version: 1 as const,
      scope: { sandboxId: 'sandbox-a', wrapperInstanceId: RUNTIME_A },
      targets: [{ messageId: 'a', wrapperInstanceId: RUNTIME_A, executionDeadlineAt: 3_601_000 }],
    };
    const getStub = () => ({
      getControlState: async () => {
        stateCalls++;
        return current;
      },
      interruptExecution: async (request: unknown) => {
        deliveries.push(structuredClone(request));
        current = {
          version: 1,
          scope: { sandboxId: 'sandbox-b', wrapperInstanceId: RUNTIME_B },
          targets: [
            { messageId: 'b', wrapperInstanceId: RUNTIME_B, executionDeadlineAt: 3_602_000 },
          ],
        };
        return { ...(request as object), state: 'confirmed' };
      },
    });

    const receipt = await interruptControlSession(
      { env: {} as never, ownerId: 'user-a', sessionId: 'workspace-a' },
      {
        getStub,
        now: 1_000,
        operationId: OPERATION_ID,
        retry: async (operation, operationName) => {
          if (operationName === 'getControlState') return operation(getStub());
          await operation(getStub());
          return operation(getStub());
        },
      }
    );

    expect(stateCalls).toBe(1);
    expect(deliveries).toEqual([
      {
        version: 1,
        operationId: OPERATION_ID,
        scope: { sandboxId: 'sandbox-a', wrapperInstanceId: RUNTIME_A },
        targets: [{ messageId: 'a', wrapperInstanceId: RUNTIME_A, executionDeadlineAt: 3_601_000 }],
        cleanupDeadlineAt: 11_000,
      },
      {
        version: 1,
        operationId: OPERATION_ID,
        scope: { sandboxId: 'sandbox-a', wrapperInstanceId: RUNTIME_A },
        targets: [{ messageId: 'a', wrapperInstanceId: RUNTIME_A, executionDeadlineAt: 3_601_000 }],
        cleanupDeadlineAt: 11_000,
      },
    ]);
    expect(receipt).toMatchObject({ operationId: OPERATION_ID, state: 'confirmed' });
  });
});
