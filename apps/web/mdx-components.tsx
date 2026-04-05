import React from 'react';
import type { MDXComponents } from 'mdx/types';

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    // Add custom components or override default ones here
    h1: ({ children }) => <h1 className="mb-4 text-3xl font-bold">{children}</h1>,
    h2: ({ children }) => <h2 className="mt-6 mb-3 text-xl font-bold">{children}</h2>,
    h3: ({ children }) => <h3 className="mt-4 mb-2 text-lg font-semibold">{children}</h3>,
    p: ({ children }) => <p className="mb-4">{children}</p>,
    ul: ({ children }) => <ul className="mb-4 list-disc space-y-2 pl-8">{children}</ul>,
    li: ({ children }) => <li>{children}</li>,
    ...components,
  };
}
