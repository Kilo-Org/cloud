export class ContainersLaunchInterruptedError extends Error {
  readonly code = 'launch_interrupted';

  constructor() {
    super('Container startup interrupted by stop');
    this.name = 'ContainersLaunchInterruptedError';
  }
}

/** RPC preserves serializable fields, but does not preserve custom prototypes. */
export function isContainersLaunchInterrupted(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'ContainersLaunchInterruptedError' &&
    'code' in error &&
    error.code === 'launch_interrupted'
  );
}
