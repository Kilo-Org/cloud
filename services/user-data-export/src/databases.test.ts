import { describe, expect, it, vi } from 'vitest';
import { createReplicaDatabase } from './databases';

describe('replica database lifecycle', () => {
  it('reuses one max-one pool and closes it once after all queries', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'first' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'second' }] });
    const end = vi.fn().mockResolvedValue(undefined);
    const createPool = vi.fn(() => ({ query, end }));
    const warehouse = createReplicaDatabase(
      { connectionString: 'postgres://hyperdrive.example/database' },
      'warehouse',
      createPool
    );

    await expect(warehouse.query('SELECT $1', ['first'])).resolves.toEqual([{ id: 'first' }]);
    await expect(warehouse.query('SELECT $1', ['second'])).resolves.toEqual([{ id: 'second' }]);
    await warehouse.close();

    expect(createPool).toHaveBeenCalledOnce();
    expect(createPool).toHaveBeenCalledWith({
      connectionString: 'postgres://hyperdrive.example/database',
      max: 1,
      statement_timeout: 30_000,
    });
    expect(query).toHaveBeenNthCalledWith(1, 'SELECT $1', ['first']);
    expect(query).toHaveBeenNthCalledWith(2, 'SELECT $1', ['second']);
    expect(query).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledOnce();
  });

  it('leaves cleanup with the owner when a query rejects', async () => {
    const failure = new Error('warehouse unavailable');
    const query = vi.fn().mockRejectedValue(failure);
    const end = vi.fn().mockResolvedValue(undefined);
    const warehouse = createReplicaDatabase(
      { connectionString: 'postgres://hyperdrive.example/database' },
      'warehouse',
      () => ({ query, end })
    );

    await expect(warehouse.query('SELECT 1', [])).rejects.toBe(failure);
    expect(end).not.toHaveBeenCalled();

    await warehouse.close();
    expect(end).toHaveBeenCalledOnce();
  });
});
