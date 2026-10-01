export function toMicrodollars(amount: number): number {
  return Math.round(amount * 1000000);
}
