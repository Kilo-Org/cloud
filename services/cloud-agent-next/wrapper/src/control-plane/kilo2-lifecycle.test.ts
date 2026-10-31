import { expect, it } from 'bun:test';
import { createKilo2Lifecycle } from './kilo2-lifecycle.js';

it('holds a follow-up until cancellation HTTP and the native close event both finish', async () => {
  const lifecycle = createKilo2Lifecycle();
  const response = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let submitted = false;
  let requests = 0;
  const interrupt = lifecycle.interrupt(
    'ses_local',
    AbortSignal.timeout(2000),
    async waitForClose => {
      requests++;
      started.resolve();
      await response.promise;
      await waitForClose();
      return true;
    }
  );
  const duplicate = lifecycle.interrupt('ses_local', AbortSignal.timeout(2000), async () => {
    throw new Error('Cancellation was duplicated');
  });
  const next = lifecycle.waitForInterrupt('ses_local').then(() => {
    submitted = true;
  });
  await started.promise;
  response.resolve();
  await Bun.sleep(0);
  expect(submitted).toBe(false);
  lifecycle.closed('ses_other');
  await Bun.sleep(0);
  expect(submitted).toBe(false);
  lifecycle.closed('ses_local');
  expect(await interrupt).toBe(true);
  expect(await duplicate).toBe(true);
  await next;
  expect(submitted).toBe(true);
  expect(requests).toBe(1);
});

it('retains an acknowledgement received before cancellation HTTP returns', async () => {
  const lifecycle = createKilo2Lifecycle();
  const response = Promise.withResolvers<void>();
  const interrupted = lifecycle.interrupt(
    'ses_local',
    AbortSignal.timeout(2000),
    async waitForClose => {
      await response.promise;
      await waitForClose();
      return true;
    }
  );
  lifecycle.closed('ses_local');
  response.resolve();
  expect(await interrupted).toBe(true);
});
