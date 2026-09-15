import { withTimeout } from '@kilocode/worker-utils';
import { DurableObject } from 'cloudflare:workers';
import {
  CONTROL_WRAPPER_LOG_PATH,
  CONTROL_WRAPPER_PATH,
} from '../sandbox-control/container-paths.js';
import type { Env } from '../types.js';

export type ContainerInstanceSize =
  | 'lite'
  | 'standard-1'
  | 'standard-2'
  | 'standard-3'
  | 'standard-4';

export type ContainersState = 'idle' | 'launching' | 'running' | 'stopping';

export type ContainersLaunchInput = {
  allocationRef: string;
  env: Record<string, string>;
  instance: ContainerInstanceSize;
};

export type ContainersObservation = {
  running: boolean;
  state: ContainersState;
  currentAllocationRef: string | null;
};

export class ContainersAllocationConflictError extends Error {
  readonly code = 'allocation_conflict';

  constructor(allocationRef: string) {
    super(`Container allocation conflict for ${allocationRef}`);
    this.name = 'ContainersAllocationConflictError';
  }
}

type ContainersRecord = {
  state: ContainersState;
  allocationRef: string | null;
  stopOpId: string | null;
  lastSnapshot: { id: string; sourceAllocation: string } | null;
};

const RECORD_KEY = 'containers:record:v1';
const CONTAINER_IMAGE = 'app';
const PROBE_TIMEOUT_MS = 5_000;
const WRAPPER_EXEC_TIMEOUT_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;
const DESTROY_TIMEOUT_MS = 30_000;
const MAX_LOG_BYTES = 1024 * 1024;

const IDLE_RECORD: ContainersRecord = {
  state: 'idle',
  allocationRef: null,
  stopOpId: null,
  lastSnapshot: null,
};

export class SandboxContainers extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async launchWrapper(input: ContainersLaunchInput): Promise<{ started: boolean }> {
    return this.runExclusive(async () => {
      const record = await this.readRecord();
      const ref = input.allocationRef;
      if (record.state === 'running' && record.allocationRef === ref) {
        return { started: false };
      }
      if (record.allocationRef !== null && record.allocationRef !== ref) {
        throw new ContainersAllocationConflictError(ref);
      }
      if (record.allocationRef === ref && record.state === 'stopping') {
        throw new ContainersAllocationConflictError(ref);
      }
      if (record.state === 'launching' && record.allocationRef === ref) {
        return this.resumeLaunch(record, ref, input.env);
      }
      const container = this.requiredContainer();
      // Ownership is retained before start: an ambiguous start that takes effect must not release the allocation.
      await this.writeRecord({ ...record, state: 'launching', allocationRef: ref, stopOpId: null });
      if (!container.running) {
        container.start(this.startOptions(input.instance, record.lastSnapshot?.id));
      }
      await this.execWrapper(container, input.env);
      await this.writeRecord({
        ...record,
        state: 'running',
        allocationRef: ref,
        stopOpId: null,
      });
      return { started: true };
    });
  }

  async observe(_allocationRef: string): Promise<ContainersObservation> {
    const record = await this.readRecord();
    return {
      running: this.ctx.container?.running === true,
      state: record.state,
      currentAllocationRef: record.allocationRef,
    };
  }

  async stop(allocationRef: string): Promise<'terminal' | 'retryable'> {
    return this.runExclusive(async () => {
      const ref = allocationRef;
      const record = await this.readRecord();
      if (record.allocationRef === null) return 'terminal';
      if (record.allocationRef !== ref && record.state !== 'stopping') return 'terminal';
      if (record.allocationRef !== ref) return 'retryable';
      if (record.state === 'stopping') {
        return this.finishStop(record, ref, record.stopOpId ?? crypto.randomUUID());
      }
      const stopOpId = crypto.randomUUID();
      const stopping: ContainersRecord = { ...record, state: 'stopping', stopOpId };
      await this.writeRecord(stopping);
      return this.finishStop(stopping, ref, stopOpId);
    });
  }

  async ensureLeaseAtLeast(allocationRef: string, ms: number): Promise<void> {
    const record = await this.readRecord();
    if (record.allocationRef !== allocationRef) return;
    await this.ctx.container?.setInactivityTimeout(ms);
  }

  async readLog(allocationRef: string, path: string, maxBytes: number): Promise<string> {
    const record = await this.readRecord();
    if (record.allocationRef !== allocationRef) return '';
    if (path !== CONTROL_WRAPPER_LOG_PATH) return '';
    const clamped = Number.isFinite(maxBytes)
      ? Math.min(Math.max(0, Math.floor(maxBytes)), MAX_LOG_BYTES)
      : 0;
    if (clamped === 0) return '';
    const container = this.ctx.container;
    if (!container || container.running !== true) return '';
    try {
      const proc = await container.exec(['tail', '-c', String(clamped), path]);
      const out = await proc.output();
      return new TextDecoder().decode(out.stdout);
    } catch {
      return '';
    }
  }

  private async resumeLaunch(
    record: ContainersRecord,
    ref: string,
    env: Record<string, string>
  ): Promise<{ started: boolean }> {
    const container = this.requiredContainer();
    const probe = await this.probeWrapper(container);
    if (probe === 'ambiguous') {
      throw new Error('Wrapper probe was ambiguous');
    }
    if (probe === 'absent') {
      await this.execWrapper(container, env);
    }
    await this.writeRecord({ ...record, state: 'running', allocationRef: ref, stopOpId: null });
    return { started: true };
  }

  private async probeWrapper(container: Container): Promise<'found' | 'absent' | 'ambiguous'> {
    try {
      const proc = await withTimeout(
        container.exec(['pgrep', '-f', CONTROL_WRAPPER_PATH]),
        PROBE_TIMEOUT_MS,
        'wrapper probe timed out'
      );
      const exitCode = await withTimeout(
        proc.exitCode,
        PROBE_TIMEOUT_MS,
        'wrapper probe timed out'
      );
      if (exitCode === 0) return 'found';
      if (exitCode === 1) return 'absent';
      return 'ambiguous';
    } catch {
      return 'ambiguous';
    }
  }

  private async execWrapper(container: Container, env: Record<string, string>): Promise<void> {
    await withTimeout(
      container.exec(['bun', 'run', CONTROL_WRAPPER_PATH], { env, cwd: '/' }),
      WRAPPER_EXEC_TIMEOUT_MS,
      'wrapper exec timed out'
    );
  }

  private requiredContainer(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error('Container is unavailable');
    return container;
  }

  private startOptions(
    instance: ContainerInstanceSize,
    snapshotId?: string
  ): ContainerStartupOptions {
    // The runtime startup union requires image XOR containerSnapshot.
    if (snapshotId !== undefined) {
      return { containerSnapshot: { id: snapshotId }, instance, enableInternet: true };
    }
    return { image: this.containerImage(), instance, enableInternet: true };
  }

  private containerImage(): string {
    const image = this.requiredContainer().images[CONTAINER_IMAGE];
    if (image === undefined) {
      throw new Error(`Container image "${CONTAINER_IMAGE}" is unavailable`);
    }
    return image;
  }

  private async finishStop(
    record: ContainersRecord,
    ref: string,
    stopOpId: string
  ): Promise<'terminal' | 'retryable'> {
    const container = this.ctx.container;
    if (!container) {
      await this.writeRecord({
        state: 'idle',
        allocationRef: null,
        stopOpId: null,
        lastSnapshot: record.lastSnapshot,
      });
      return 'terminal';
    }
    await this.snapshotBeforeDestroy(container, ref, stopOpId);
    try {
      await withTimeout(container.destroy(), DESTROY_TIMEOUT_MS, 'container destroy timed out');
    } catch {
      return 'retryable';
    }
    const current = await this.readRecord();
    await this.writeRecord({
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: current.lastSnapshot,
    });
    return 'terminal';
  }

  private async snapshotBeforeDestroy(
    container: Container,
    ref: string,
    stopOpId: string
  ): Promise<void> {
    const attempt = container.snapshotContainer({});
    try {
      const snapshot = await withTimeout(
        attempt,
        SNAPSHOT_TIMEOUT_MS,
        'container snapshot timed out'
      );
      await this.publishSnapshot(snapshot.id, ref, stopOpId);
    } catch {
      void attempt.then(
        snapshot => this.runExclusive(() => this.publishSnapshot(snapshot.id, ref, stopOpId)),
        () => undefined
      );
    }
  }

  private async publishSnapshot(id: string, ref: string, stopOpId: string): Promise<void> {
    const record = await this.readRecord();
    if (record.state !== 'stopping') return;
    if (record.allocationRef !== ref) return;
    if (record.stopOpId !== stopOpId) return;
    await this.writeRecord({ ...record, lastSnapshot: { id, sourceAllocation: ref } });
  }

  private async readRecord(): Promise<ContainersRecord> {
    return (await this.ctx.storage.get<ContainersRecord>(RECORD_KEY)) ?? IDLE_RECORD;
  }

  private async writeRecord(record: ContainersRecord): Promise<void> {
    await this.ctx.storage.put(RECORD_KEY, record);
  }
}
