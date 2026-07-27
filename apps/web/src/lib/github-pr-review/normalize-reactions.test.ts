/**
 * @jest-environment node
 *
 * Pins the reaction DTO invariant for `normalizeReactions` / `normalizeComment`
 * (P0-C-14). The router selects GitHub's `reactionGroups` field, which
 * returns a flat `ReactionGroup[]` (one entry per `ReactionContent`) with
 * `reactors.totalCount`. The output DTO consumed by
 * `apps/web/src/lib/github-pr-review/mappers.ts` and the mobile reactions
 * row keeps the shape `Array<{ content: string; count: number;
 * viewerHasReacted: boolean }>`, preserving source order and filtering
 * zero-count groups (shipped behavior; the mobile reactions row renders a
 * fixed set of 8 pills and hides zero counts, so dropped zero-count groups
 * are invisible to the consumer).
 */
import {
  normalizeComment_FOR_TEST,
  normalizeReactions_FOR_TEST,
} from "@/routers/github-pr-review-router";

describe("normalizeReactions (reactionGroups shape)", () => {
  it("maps a group with reactors.totalCount to { content, count, viewerHasReacted }", () => {
    const out = normalizeReactions_FOR_TEST([
      {
        content: "+1",
        viewerHasReacted: true,
        reactors: { totalCount: 3 },
      },
    ]);
    expect(out).toEqual([{ content: "+1", count: 3, viewerHasReacted: true }]);
  });

  it("treats absent/null reactors as count: 0 — filtered out, never throws", () => {
    expect(
      normalizeReactions_FOR_TEST([
        { content: "THUMBS_UP", viewerHasReacted: false, reactors: null },
      ]),
    ).toEqual([]);

    // `reactors` omitted entirely — same behavior.
    expect(
      normalizeReactions_FOR_TEST([
        { content: "HEART", viewerHasReacted: false },
      ]),
    ).toEqual([]);
  });

  it("preserves source order of surviving entries and drops zero-count groups", () => {
    const out = normalizeReactions_FOR_TEST([
      { content: "+1", viewerHasReacted: true, reactors: { totalCount: 2 } },
      {
        content: "LAUGH",
        viewerHasReacted: false,
        reactors: { totalCount: 0 },
      },
      {
        content: "HEART",
        viewerHasReacted: false,
        reactors: { totalCount: 7 },
      },
    ]);
    expect(out).toEqual([
      { content: "+1", count: 2, viewerHasReacted: true },
      // Zero-count groups are dropped — the shipped contract; the mobile
      // reactions row renders a fixed 8-pill set and hides zero counts, so
      // dropping them does not change the rendered output.
      { content: "HEART", count: 7, viewerHasReacted: false },
    ]);
    expect(out.map((r) => r.content)).toEqual(["+1", "HEART"]);
  });

  it("coerces a truthy non-boolean viewerHasReacted to true (legacy GitHub quirk)", () => {
    // The legacy normalizeReactions wrapper called `Boolean(...)`; preserve
    // that contract even when GitHub occasionally returns truthy non-booleans.
    const out = normalizeReactions_FOR_TEST([
      {
        content: "ROCKET",
        viewerHasReacted: 1 as unknown as boolean,
        reactors: { totalCount: 1 },
      },
    ]);
    expect(out[0]?.viewerHasReacted).toBe(true);
  });

  it("returns an empty array for an empty input (no spurious entries)", () => {
    expect(normalizeReactions_FOR_TEST([])).toEqual([]);
  });
});

describe("normalizeComment (reactionGroups shape)", () => {
  it("reads node.reactionGroups and forwards the same DTO shape", () => {
    const out = normalizeComment_FOR_TEST({
      databaseId: 42,
      id: "node_42",
      body: "hello",
      createdAt: "2024-01-01T00:00:00Z",
      author: { login: "octocat", avatarUrl: "https://x/y.png" },
      reactionGroups: [
        { content: "+1", viewerHasReacted: false, reactors: { totalCount: 1 } },
        {
          content: "EYES",
          viewerHasReacted: true,
          reactors: { totalCount: 4 },
        },
      ],
    });
    expect(out.databaseId).toBe(42);
    expect(out.reactions).toEqual([
      { content: "+1", count: 1, viewerHasReacted: false },
      { content: "EYES", count: 4, viewerHasReacted: true },
    ]);
  });

  it("defaults reactionGroups to [] when the field is absent or null", () => {
    const out = normalizeComment_FOR_TEST({
      databaseId: 1,
      id: "node_1",
      body: "",
      createdAt: "2024-01-01T00:00:00Z",
      author: null,
      // `reactionGroups` omitted on purpose.
    } as unknown as Parameters<typeof normalizeComment_FOR_TEST>[0]);
    expect(out.reactions).toEqual([]);
    expect(out.author).toBeNull();
  });
});
