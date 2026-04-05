declare global {
  interface Window {
    ire?: (...args: unknown[]) => void;
  }

  function ire(...args: unknown[]): void;
}

export {};
