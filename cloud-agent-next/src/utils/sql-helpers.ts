/**
 * SQL query building helpers for Durable Object SQLite queries.
 * Used with getTableFromZodSchema for type-safe, less boilerplate queries.
 */

/**
 * Push an IN clause condition and parameters.
 * Does nothing if values is undefined or empty.
 *
 * @example
 * pushInClause(conditions, args, `${events.execution_id}`, ['exec1', 'exec2']);
 * // conditions: ['events.execution_id IN (?, ?)']
 * // args: ['exec1', 'exec2']
 */
export function pushInClause<T>(
  conditions: string[],
  args: unknown[],
  column: string,
  values: T[] | undefined
): boolean {
  if (!values?.length) return false;

  const placeholders = values.map(() => '?').join(', ');
  conditions.push(`${column} IN (${placeholders})`);
  args.push(...values);
  return true;
}

/**
 * Push a comparison condition.
 * Does nothing if value is undefined.
 *
 * @example
 * pushCondition(conditions, args, `${events.id}`, '>', 100);
 * // conditions: ['events.id > ?']
 * // args: [100]
 */
export function pushCondition(
  conditions: string[],
  args: unknown[],
  column: string,
  op: '=' | '!=' | '>' | '<' | '>=' | '<=',
  value: unknown
): boolean {
  if (value === undefined) return false;

  conditions.push(`${column} ${op} ?`);
  args.push(value);
  return true;
}

/**
 * Build WHERE clause from conditions array.
 * Returns empty string if no conditions.
 *
 * @example
 * buildWhereClause(['id > ?', 'status = ?'])
 * // ' WHERE id > ? AND status = ?'
 */
export function buildWhereClause(conditions: string[]): string {
  return conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
}
