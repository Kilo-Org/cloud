# managed index manual testing

## ⚠️ IMPORTANT: Setup Required

**Before Qdrant will work, you MUST run the setup script first.**

The `setup` script will:

- **DELETE the entire production Qdrant index** (this action cannot be undone!)
- Recreate the collection
- Index a small test dataset to verify everything works

**WARNING**: This script will nuke the production index from orbit. You will be prompted to confirm before proceeding.

```bash
pnpm script:run managed-indexing setup
```

## test command (index + search)

The `test` command combines indexing and searching into a single workflow:

1. First, indexes all TypeScript files in `./src` folder
2. Then, performs searches (either custom or default)

- first, make sure you're running locally with `pnpm dev`
- **second, run the setup script** (see above)
- third, run `pnpm script:run managed-indexing test <org-id> [project-id] [search-query]`

### Examples

Run with default searches (5 predefined queries):

```bash
pnpm script:run managed-indexing test <org-id>
pnpm script:run managed-indexing test <org-id> my-project
```

Run with a custom search query:

```bash
pnpm script:run managed-indexing test <org-id> test-project "authentication middleware"
pnpm script:run managed-indexing test <org-id> my-project "database migration script"
```

### Arguments

- `<org-id>` (required) - Organization UUID
- `[project-id]` (optional) - Project identifier (defaults to `test-project`)
- `[search-query]` (optional) - Custom search query. If provided, runs only this search after indexing. If not provided, runs 5 default searches.
