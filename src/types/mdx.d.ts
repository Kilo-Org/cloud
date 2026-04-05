declare module '*.mdx' {
  import type { ReactNode } from 'react';

  const MDXComponent: (props: Record<string, unknown>) => ReactNode;
  export default MDXComponent;
}
