import { z } from 'zod';

// GraphQL `Bot.login` omits the `[bot]` suffix that REST payloads, webhooks and
// trusted-bot policies use, so normalize authors to the REST login here.
export const gitHubGraphQlAuthorSchema = z
  .object({
    login: z.string(),
    __typename: z.string().optional(),
    databaseId: z
      .union([z.string().regex(/^\d+$/), z.number().int().positive()])
      .transform(String)
      .nullable()
      .optional(),
  })
  .transform(author => ({
    ...author,
    login:
      author.__typename === 'Bot' && !author.login.endsWith('[bot]')
        ? `${author.login}[bot]`
        : author.login,
  }));

export const prMaintenanceFeedbackCommentSchema = z.object({
  fullDatabaseId: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
  databaseId: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
  body: z.string().max(1_000_000),
  authorAssociation: z.string(),
  author: gitHubGraphQlAuthorSchema.nullable(),
  updatedAt: z.string(),
  url: z.string(),
  commit: z.object({ oid: z.string() }).nullable().optional(),
  state: z.string().optional(),
});
