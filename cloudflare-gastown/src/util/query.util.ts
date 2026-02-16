/**
 * CountOccurrences type counts the number of times a SubString appears in a String_.
 * Uses a recursive approach with a counter represented as an array of unknown.
 */
type CountOccurrences<
  String_ extends string,
  SubString extends string,
  Count extends unknown[] = [],
> = String_ extends `${string}${SubString}${infer Tail}`
  ? CountOccurrences<Tail, SubString, [unknown, ...Count]>
  : Count['length'];

type Tuple<T, N extends number, Acc extends T[] = []> = Acc['length'] extends N
  ? Acc
  : Tuple<T, N, [...Acc, T]>;

export type SqliteParams<Query extends string> = Tuple<unknown, CountOccurrences<Query, '?'>>;

/**
 * Type-safe SQLite query helper. The params tuple length is statically
 * checked against the number of `?` placeholders in the query string.
 */
export function query<Query extends string>(
  sql: SqlStorage,
  query: Query,
  params: SqliteParams<Query>
) {
  return sql.exec(query, ...(params as unknown[]));
}
