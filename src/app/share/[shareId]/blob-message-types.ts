import * as z from 'zod';

export const BasicMessageSchema = z.object({
  ts: z.number(),
  type: z.literal('say'),
  say: z.literal('text'),
  text: z.string(),
  partial: z.boolean().optional(),
});

export type BasicMessage = z.infer<typeof BasicMessageSchema>;

export const FollowupSuggestionSchema = z.object({
  answer: z.string(),
});

export const FollowupTextContentSchema = z.object({
  question: z.string(),
  suggest: z.array(FollowupSuggestionSchema),
});

export type FollowupTextContent = z.infer<typeof FollowupTextContentSchema>;

export const FollowupMessageSchema = z.object({
  ts: z.number(),
  type: z.literal('ask'),
  ask: z.literal('followup'),
  text: z.string(),
  partial: z.boolean().optional(),
  isAnswered: z.boolean().optional(),
});

export type FollowupMessage = z.infer<typeof FollowupMessageSchema>;

export const ReasoningMessageSchema = z.object({
  ts: z.number(),
  type: z.literal('say'),
  say: z.literal('reasoning'),
  text: z.string(),
  partial: z.boolean().optional(),
});

export type ReasoningMessage = z.infer<typeof ReasoningMessageSchema>;

export const UserFeedbackMessageSchema = z.object({
  ts: z.number(),
  type: z.literal('say'),
  say: z.literal('user_feedback'),
  text: z.string(),
  partial: z.boolean().optional(),
});

export type UserFeedbackMessage = z.infer<typeof UserFeedbackMessageSchema>;

export const CompletionResultMessageSchema = z.object({
  ts: z.number(),
  type: z.literal('say'),
  say: z.literal('completion_result'),
  text: z.string(),
  partial: z.boolean().optional(),
});

export type CompletionResultMessage = z.infer<typeof CompletionResultMessageSchema>;

export const AnyBlobMessageSchema = z.union([
  BasicMessageSchema,
  ReasoningMessageSchema,
  FollowupMessageSchema,
  UserFeedbackMessageSchema,
  CompletionResultMessageSchema,
]);

export type AnyBlobMessage = z.infer<typeof AnyBlobMessageSchema>;

export function parseFollowupTextContent(text: string): FollowupTextContent {
  const parsed = JSON.parse(text);
  return FollowupTextContentSchema.parse(parsed);
}
