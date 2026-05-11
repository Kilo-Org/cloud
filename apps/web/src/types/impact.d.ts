import type { DetailedHTMLProps, HTMLAttributes, ReactNode } from 'react';

declare global {
  interface Window {
    ire?: (...args: unknown[]) => void;
    impactToken?: string;
  }

  function ire(...args: unknown[]): void;
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'impact-embed': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        widget?: string;
        children?: ReactNode;
      };
    }
  }
}

export {};
