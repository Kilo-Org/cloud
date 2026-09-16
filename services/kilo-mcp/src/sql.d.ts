/**
 * `.sql` imports are text at the Worker edge (esbuild's text loader) and raw
 * strings under Vitest (see the `raw-sql` plugin in vitest.config.ts).
 */
declare module '*.sql' {
  const content: string;
  export default content;
}
