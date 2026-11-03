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

// Dictionary value reached through a nested alias that binds the same parameter name.
type Inner<X> = X;
type LookupInner<X> = { readonly [key: string]: X };
export type Nested = LookupInner<Inner<unknown>>;

// Dictionary value reached through two alias layers that bind the same parameter name.
type Root<X> = X;
type Echo<X> = X;
type DictOf<X> = { readonly [key: string]: X };
export type Chained = Root<Echo<DictOf<unknown>>>;

// Widening target reached through an alias layer that binds the same parameter name.
type Mapped<X extends string> = { readonly [K in X]: string };
type Revive<X> = X;
type Plain = Revive<Mapped<string>>;

export const forwarded: Forwarded = { key: 'a' };
export const tabled: Tabled = { first: 'a', second: 'b', third: 'c' };
export const plain: Plain = { first: 'a' };

// Controls: both rules still report the contracts they exist to report.
export type Loose = { readonly [key: string]: unknown };
export const widened: Record<string, number> = { first: 1 };
