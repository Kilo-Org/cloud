# Firefox Source Review

This source archive is rooted at the monorepo root so pnpm catalog versions resolve.

To rebuild the Firefox package:

```bash
pnpm install --ignore-scripts
pnpm --filter kilo-extension zip:firefox
```
