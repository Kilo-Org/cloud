// styled-jsx type augmentation — Next.js bundles this in next/dist/styled-jsx/types/global.d.ts
// but pnpm's strict module isolation prevents the augmentation from merging with @types/react.
// This file must contain an import to be treated as a module augmentation (not an ambient declaration).
import 'react';

declare module 'react' {
  interface StyleHTMLAttributes<T> {
    jsx?: boolean;
    global?: boolean;
  }
}
