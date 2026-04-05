export function chunkArray<T>(array: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new Error('size must be a positive whole number');

  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}
