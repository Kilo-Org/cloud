# KiloChat Attachment Upload Retry

## Goal

Fix transient `Attachment upload is missing` failures when a client has uploaded an attachment and immediately creates a message before the KiloChat service can observe the R2 object through its own bucket binding.

## Chosen Approach

Keep the existing client contract and service constraints. Message creation will still reject messages whose referenced attachments are not uploaded, but the service will retry the R2 `head` validation before returning `409`.

The retry schedule is:

- initial validation immediately
- retry after 500 ms
- retry after 1000 ms

This applies to all callers because the check sits in `ConversationDO.createMessage`, which is used by both user and bot message routes.

## Implementation Steps

1. Add a regression test in `services/kilo-chat/src/__tests__/messages-routes.test.ts` that simulates the object becoming visible during validation and expects message creation to succeed after retrying.
2. Keep the existing missing-upload test and update it only as needed to assert the final failure after retries.
3. Add a small sleep helper and retry loop around `MEDIA_BUCKET.head` in `services/kilo-chat/src/do/conversation-do.ts`.
4. Preserve the existing size mismatch behavior once an object is visible; retries only handle a missing `head` result.
5. Run targeted KiloChat service tests, then format and commit the completed change.

## Self-Review

- Scope is service-side only; no web, bot, plugin, or controller API changes.
- The existing no-non-uploaded-attachments constraint stays intact because failure still returns `409` after the bounded retry budget.
- Retry behavior lives below the route layer, so user and bot flows remain consistent.
- No schema or migration is needed.
