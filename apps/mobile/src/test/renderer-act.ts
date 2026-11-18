/* eslint-disable promise/prefer-await-to-callbacks -- React act must receive the caller's synchronous or asynchronous callback unchanged. */
import { act as reactAct } from 'react';

const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

// Like Testing Library, scope React's act environment to the actual flush,
// including asynchronous work, and restore the caller's environment afterward.
export function act<T>(callback: () => T | Promise<T>): PromiseLike<T> {
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const pending = { asynchronous: false };
  try {
    const result = reactAct((): T | Promise<T> => {
      const value = callback();
      pending.asynchronous = value instanceof Promise;
      return value;
    });
    if (pending.asynchronous) {
      return (async () => {
        try {
          return await result;
        } finally {
          environment.IS_REACT_ACT_ENVIRONMENT = previous;
        }
      })();
    }
    environment.IS_REACT_ACT_ENVIRONMENT = previous;
    return result;
  } catch (error) {
    environment.IS_REACT_ACT_ENVIRONMENT = previous;
    throw error;
  }
}
