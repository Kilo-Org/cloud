import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createScreenBudget, createScreenCheckpoint, runScreenWorkerPool } from './screen-runtime';

describe('screen worker runtime', () => {
  it('bounds active workers and pulls jobs in the supplied round-robin order', async () => {
    const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
    const thirdStarted = Promise.withResolvers<void>();
    const started: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const running = runScreenWorkerPool([0, 1, 2, 3], 2, async job => {
      started.push(job);
      active++;
      maximumActive = Math.max(maximumActive, active);
      if (job === 2) thirdStarted.resolve();
      await gates[job].promise;
      active--;
    });
    expect(started).toEqual([0, 1]);
    gates[0].resolve();
    await thirdStarted.promise;
    expect(started).toEqual([0, 1, 2]);
    for (const gate of gates) gate.resolve();
    await running;
    expect(started).toEqual([0, 1, 2, 3]);
    expect(maximumActive).toBe(2);
  });

  it('reserves budget atomically and waits for actual settlement before admitting more spend', async () => {
    const budget = createScreenBudget(1);
    const first = await budget.reserve(0.6);
    if (!first) throw new Error('Expected the first reservation');
    let secondAdmitted = false;
    const waiting = budget.reserve(0.6).then(reservation => {
      secondAdmitted = true;
      return reservation;
    });
    await Promise.resolve();
    expect(secondAdmitted).toBe(false);
    expect(budget.reservedUsd).toBeCloseTo(0.6);
    first.settle(0.2);
    const second = await waiting;
    if (!second) throw new Error('Expected released budget to admit the second request');
    expect(budget.spentUsd + budget.reservedUsd).toBeCloseTo(0.8);
    second.settle(0.3);
    expect(budget.spentUsd).toBeCloseTo(0.5);
    expect(budget.reservedUsd).toBe(0);
    expect(await budget.reserve(0.6)).toBeNull();
    expect(() => second.settle(0)).toThrow('already settled');
  });

  it('retains resumed spend and prevents waiting reservations from sending after stop', async () => {
    const budget = createScreenBudget(1, 0.4);
    expect(await budget.reserve(0.7)).toBeNull();
    const active = await budget.reserve(0.4);
    if (!active) throw new Error('Expected remaining budget to admit the request');
    const waiting = budget.reserve(0.4);
    budget.stop();
    expect(await waiting).toBeNull();
    active.settle(0.1);
    expect(budget.spentUsd).toBeCloseTo(0.5);
    expect(await budget.reserve(0.1)).toBeNull();
  });

  it('settles simultaneous requests without exceeding the shared reserved budget', async () => {
    const budget = createScreenBudget(1);
    let maximumCommitted = 0;
    let completed = 0;
    await runScreenWorkerPool(Array.from({ length: 12 }, (_, index) => index), 4, async () => {
      const reservation = await budget.reserve(0.25);
      if (!reservation) return;
      maximumCommitted = Math.max(maximumCommitted, budget.spentUsd + budget.reservedUsd);
      await Promise.resolve();
      reservation.settle(0.1);
      completed++;
    });
    expect(completed).toBeGreaterThan(4);
    expect(maximumCommitted).toBeLessThanOrEqual(1);
    expect(budget.spentUsd).toBeLessThanOrEqual(1);
    expect(budget.reservedUsd).toBe(0);
  });

  it('serializes overlapping atomic checkpoints and retains the latest snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'candidate-screen-'));
    try {
      const path = join(directory, 'screen.json');
      let completed = 1;
      const checkpoint = createScreenCheckpoint(path, () => ({ completed }));
      const first = checkpoint();
      completed = 2;
      const second = checkpoint();
      completed = 3;
      const third = checkpoint();
      await Promise.all([first, second, third]);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ completed: 3 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
