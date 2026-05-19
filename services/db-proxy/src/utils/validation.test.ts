import { parseQueryRequest, parseBatchRequest, MAX_SQL_LENGTH, MAX_BATCH_SIZE } from './validation';

describe('validation utilities', () => {
  describe('parseQueryRequest', () => {
    it('parses a valid query request', () => {
      const body = {
        sql: 'SELECT * FROM users',
        params: [],
        method: 'all',
      };

      const result = parseQueryRequest(body);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sql).toBe('SELECT * FROM users');
        expect(result.data.params).toEqual([]);
        expect(result.data.method).toBe('all');
      }
    });

    it('parses a valid query request with params', () => {
      const body = {
        sql: 'SELECT * FROM users WHERE id = ?',
        params: [1],
        method: 'get',
      };

      const result = parseQueryRequest(body);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.params).toEqual([1]);
        expect(result.data.method).toBe('get');
      }
    });

    it('defaults params to empty array', () => {
      const body = {
        sql: 'SELECT 1',
        method: 'run',
      };

      const result = parseQueryRequest(body);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.params).toEqual([]);
      }
    });

    it('rejects missing sql', () => {
      const body = {
        params: [],
        method: 'all',
      };

      const result = parseQueryRequest(body);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });

    it('rejects missing method', () => {
      const body = {
        sql: 'SELECT 1',
        params: [],
      };

      const result = parseQueryRequest(body);

      expect(result.success).toBe(false);
    });

    it('rejects invalid method', () => {
      const body = {
        sql: 'SELECT 1',
        params: [],
        method: 'invalid',
      };

      const result = parseQueryRequest(body);

      expect(result.success).toBe(false);
    });

    it('rejects SQL exceeding max length', () => {
      const longSql = 'A'.repeat(MAX_SQL_LENGTH + 1);
      const body = {
        sql: longSql,
        params: [],
        method: 'all',
      };

      const result = parseQueryRequest(body);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('exceeds maximum length');
      }
    });

    it('accepts SQL at max length', () => {
      const maxSql = 'A'.repeat(MAX_SQL_LENGTH);
      const body = {
        sql: maxSql,
        params: [],
        method: 'all',
      };

      const result = parseQueryRequest(body);

      expect(result.success).toBe(true);
    });

    it('accepts all valid methods', () => {
      const methods = ['get', 'all', 'run', 'values'] as const;

      for (const method of methods) {
        const body = {
          sql: 'SELECT 1',
          params: [],
          method,
        };

        const result = parseQueryRequest(body);
        expect(result.success).toBe(true);
      }
    });
  });

  describe('parseBatchRequest', () => {
    it('parses a valid batch request', () => {
      const body = {
        queries: [
          { sql: 'SELECT 1', params: [], method: 'all' },
          { sql: 'SELECT 2', params: [], method: 'get' },
        ],
      };

      const result = parseBatchRequest(body);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.queries).toHaveLength(2);
      }
    });

    it('parses empty batch', () => {
      const body = { queries: [] };

      const result = parseBatchRequest(body);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.queries).toHaveLength(0);
      }
    });

    it('rejects missing queries', () => {
      const body = {};

      const result = parseBatchRequest(body);

      expect(result.success).toBe(false);
    });

    it('rejects batch exceeding max size', () => {
      const queries = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({
        sql: `SELECT ${i}`,
        params: [],
        method: 'all' as const,
      }));

      const body = { queries };

      const result = parseBatchRequest(body);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('exceeds maximum size');
      }
    });

    it('accepts batch at max size', () => {
      const queries = Array.from({ length: MAX_BATCH_SIZE }, (_, i) => ({
        sql: `SELECT ${i}`,
        params: [],
        method: 'all' as const,
      }));

      const body = { queries };

      const result = parseBatchRequest(body);

      expect(result.success).toBe(true);
    });

    it('rejects invalid query in batch', () => {
      const body = {
        queries: [
          { sql: 'SELECT 1', params: [], method: 'all' },
          { sql: 'SELECT 2', params: [], method: 'invalid' },
        ],
      };

      const result = parseBatchRequest(body);

      expect(result.success).toBe(false);
    });
  });
});
