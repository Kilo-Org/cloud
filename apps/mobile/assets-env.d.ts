declare module '*.png' {
  const value: number;
  export default value;
}

declare module '*.jpg' {
  const value: number;
  export default value;
}

declare module '*.webp' {
  const value: number;
  export default value;
}

declare module '*.txt' {
  const value: number;
  export default value;
}

// Inlined as a string by babel-plugin-inline-import (babel.config.js), not a
// bundled asset: the changelog screen renders the same CHANGELOG.md the Release
// workflow appends to.
declare module '*.md' {
  const content: string;
  export default content;
}
