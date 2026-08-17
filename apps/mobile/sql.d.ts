// `drizzle/migrations.js` imports the generated `.sql` migrations, which
// babel-plugin-inline-import turns into string literals at bundle time.
declare module '*.sql' {
  const content: string;
  export default content;
}
