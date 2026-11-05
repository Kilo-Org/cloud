export function retryable(...methods: ((...args: never[]) => unknown)[]): void {
  if (methods.some(method => typeof method !== 'function')) {
    throw new TypeError('Expected Durable Object methods');
  }
}
