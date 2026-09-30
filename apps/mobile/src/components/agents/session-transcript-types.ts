import {
  type Part,
  type PreparationAttempt,
  type StoredMessage,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';

/**
 * A burst-opening time marker. It rides on the first item a message row emits so
 * a prepend can never add, remove, or re-key a row that is already on screen: the
 * marker moves to the older message while every message keeps its `info.id` key.
 */
export type SessionTranscriptTimeMarker = { created: number; dayChanged: boolean };

export type SessionTranscriptItem =
  | {
      type: 'message';
      message: StoredMessage;
      /**
       * The exact subset of `message.parts` to render, set only when a condensed
       * run split the message around its visible parts. Omitted for an unchanged
       * message, whose full part list is rendered.
       */
      parts?: Part[];
      timeMarker?: SessionTranscriptTimeMarker;
    }
  | { type: 'preparation'; attempt: PreparationAttempt }
  | {
      type: 'tool-run';
      id: string;
      /** The run's first part's message id, for resume-anchor matching. */
      messageId: string;
      parts: ToolPart[];
      timeMarker?: SessionTranscriptTimeMarker;
    };

/**
 * The item key each rendered part had in one transcript build, keyed by part id.
 * A condensed row's key is derived from the parts it holds, so a later build
 * cannot recompute the key a row was born with from its parts alone. Carrying
 * this map from the previous build lets `condenseTranscriptToolRuns` keep a row's
 * existing key when a prepend or a streaming part changes the run's first part.
 */
export type TranscriptItemKeysByPart = ReadonlyMap<string, string>;
