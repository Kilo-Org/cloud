// Alias shapes the anti-slop classifiers must resolve through a bounded number of substitution
// hops. Both rules report the control contracts at the bottom of the file.

type Box<T> = { readonly value: T };
type Key<T> = { readonly key: T };
type Keys<T> = 'first' | 'second' | T;

// Dictionary value type reached through one alias layer.
type Lookup<Box> = { readonly [key: string]: Box };
export type Rebound = Lookup<Box<string>>;

// Alias body reached through one alias layer.
type Forward<Key> = Key;
type Forwarded = Forward<Key<string>>;

// Mapped key reached through one alias layer.
type Table<Keys extends string> = { readonly [K in Keys]: string };
type Tabled = Table<Keys<'third'>>;

export const forwarded: Forwarded = { key: 'a' };
export const tabled: Tabled = { first: 'a', second: 'b', third: 'c' };

// Controls: both rules still report the contracts they exist to report.
export type Loose = { readonly [key: string]: unknown };
export const widened: Record<string, number> = { first: 1 };
