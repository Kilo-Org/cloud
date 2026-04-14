import { describe, it, expect } from 'vitest';

import {
  trimPayload,
  MAX_TOOL_OUTPUT_LENGTH,
  MAX_RAW_INPUT_LENGTH,
  MAX_STDOUT_LENGTH,
} from './trim-payload.js';

function createKilocodeEvent(event: string, properties: unknown) {
  return { type: event, properties, event };
}

describe('trimPayload', () => {
  describe('message.part.updated — text/reasoning parts', () => {
    it('passes text parts through unchanged', () => {
      const data = createKilocodeEvent('message.part.updated', {
        part: { type: 'text', content: 'hello world' },
      });
      expect(trimPayload('kilocode', data)).toEqual(data);
    });
  });

  describe('message.part.updated — tool completed', () => {
    it('truncates large output', () => {
      const largeOutput = 'x'.repeat(20_000);
      const data = createKilocodeEvent('message.part.updated', {
        part: {
          type: 'tool',
          state: { status: 'completed', output: largeOutput },
        },
      });

      const result = trimPayload('kilocode', data) as {
        properties: { part: { state: { output: string } } };
      };

      expect(result.properties.part.state.output.length).toBe(
        MAX_TOOL_OUTPUT_LENGTH + '\n\n[…truncated]'.length
      );
      expect(result.properties.part.state.output).toEqual(
        largeOutput.slice(0, MAX_TOOL_OUTPUT_LENGTH) + '\n\n[…truncated]'
      );
    });

    it('leaves small output unchanged', () => {
      const smallOutput = 'x'.repeat(100);
      const data = createKilocodeEvent('message.part.updated', {
        part: {
          type: 'tool',
          state: { status: 'completed', output: smallOutput },
        },
      });

      const result = trimPayload('kilocode', data) as {
        properties: { part: { state: { output: string } } };
      };

      expect(result.properties.part.state.output).toBe(smallOutput);
    });

    it('strips content from attachment file parts', () => {
      const data = createKilocodeEvent('message.part.updated', {
        part: {
          type: 'tool',
          state: {
            status: 'completed',
            output: 'ok',
            attachments: [
              {
                type: 'file',
                url: 'data:image/png;base64,iVBORw0KGgo=',
                name: 'screenshot.png',
                source: {
                  text: { value: 'large content', start: 0, end: 100 },
                  type: 'file',
                  path: '/foo',
                },
              },
            ],
          },
        },
      });

      const result = trimPayload('kilocode', data) as {
        properties: {
          part: {
            state: {
              attachments: Array<{
                url: string;
                name: string;
                source: {
                  text: { value: string; start: number; end: number };
                  type: string;
                  path: string;
                };
              }>;
            };
          };
        };
      };

      const attachment = result.properties.part.state.attachments[0];
      expect(attachment.url).toBe('');
      expect(attachment.source.text.value).toBe('');
      expect(attachment.name).toBe('screenshot.png');
      expect(attachment.source.type).toBe('file');
      expect(attachment.source.path).toBe('/foo');
      expect(attachment.source.text.start).toBe(0);
      expect(attachment.source.text.end).toBe(100);
    });

    it('strips top-level tool completed attachments and truncates output', () => {
      const largeOutput = 'x'.repeat(20_000);
      const data = {
        event: 'message.part.updated',
        part: {
          type: 'tool',
          state: {
            status: 'completed',
            output: largeOutput,
            attachments: [
              {
                type: 'file',
                url: 'data:image/png;base64,top-level-tool',
                name: 'screenshot.png',
                source: {
                  text: { value: 'large content', start: 0, end: 100 },
                  type: 'file',
                  path: '/foo',
                },
              },
            ],
          },
        },
      };

      const result = trimPayload('kilocode', data) as {
        part: {
          state: {
            output: string;
            attachments: Array<{
              url: string;
              name: string;
              source: {
                text: { value: string; start: number; end: number };
                type: string;
                path: string;
              };
            }>;
          };
        };
      };

      const attachment = result.part.state.attachments[0];
      expect(result.part.state.output).toEqual(
        largeOutput.slice(0, MAX_TOOL_OUTPUT_LENGTH) + '\n\n[…truncated]'
      );
      expect(attachment.url).toBe('');
      expect(attachment.source.text.value).toBe('');
      expect(attachment.name).toBe('screenshot.png');
      expect(attachment.source.type).toBe('file');
      expect(attachment.source.path).toBe('/foo');
      expect(attachment.source.text.start).toBe(0);
      expect(attachment.source.text.end).toBe(100);
    });
  });

  describe('message.part.updated — tool pending', () => {
    it('truncates large raw input', () => {
      const largeRaw = 'y'.repeat(20_000);
      const data = createKilocodeEvent('message.part.updated', {
        part: {
          type: 'tool',
          state: { status: 'pending', raw: largeRaw },
        },
      });

      const result = trimPayload('kilocode', data) as {
        properties: { part: { state: { raw: string } } };
      };

      expect(result.properties.part.state.raw.length).toBe(
        MAX_RAW_INPUT_LENGTH + '\n\n[…truncated]'.length
      );
      expect(result.properties.part.state.raw).toEqual(
        largeRaw.slice(0, MAX_RAW_INPUT_LENGTH) + '\n\n[…truncated]'
      );
    });

    it('leaves small raw input unchanged', () => {
      const smallRaw = 'y'.repeat(100);
      const data = createKilocodeEvent('message.part.updated', {
        part: {
          type: 'tool',
          state: { status: 'pending', raw: smallRaw },
        },
      });

      const result = trimPayload('kilocode', data) as {
        properties: { part: { state: { raw: string } } };
      };

      expect(result.properties.part.state.raw).toBe(smallRaw);
    });
  });

  describe('message.part.updated — step-start / step-finish / snapshot', () => {
    it('strips snapshot from step-start', () => {
      const data = createKilocodeEvent('message.part.updated', {
        part: { type: 'step-start', snapshot: 'large data', title: 'Step 1' },
      });

      const result = trimPayload('kilocode', data) as {
        properties: { part: { snapshot: unknown; title: string } };
      };

      expect(result.properties.part.snapshot).toBeUndefined();
      expect(result.properties.part.title).toBe('Step 1');
    });

    it('strips snapshot from step-finish', () => {
      const data = createKilocodeEvent('message.part.updated', {
        part: { type: 'step-finish', snapshot: 'large data', duration: 123 },
      });

      const result = trimPayload('kilocode', data) as {
        properties: { part: { snapshot: unknown; duration: number } };
      };

      expect(result.properties.part.snapshot).toBeUndefined();
      expect(result.properties.part.duration).toBe(123);
    });

    it('strips snapshot from snapshot part', () => {
      const data = createKilocodeEvent('message.part.updated', {
        part: { type: 'snapshot', snapshot: 'data' },
      });

      const result = trimPayload('kilocode', data) as {
        properties: { part: { snapshot: unknown } };
      };

      expect(result.properties.part.snapshot).toBeUndefined();
    });
  });

  describe('message.part.updated — file part', () => {
    it('strips url and source.text.value', () => {
      const data = createKilocodeEvent('message.part.updated', {
        part: {
          type: 'file',
          url: 'data:image/png;base64,abc123',
          name: 'image.png',
          source: {
            text: { value: 'file content here', start: 0, end: 50 },
            type: 'file',
            path: '/foo',
          },
        },
      });

      const result = trimPayload('kilocode', data) as {
        properties: {
          part: {
            url: string;
            name: string;
            source: {
              text: { value: string; start: number; end: number };
              type: string;
              path: string;
            };
          };
        };
      };

      expect(result.properties.part.url).toBe('');
      expect(result.properties.part.source.text.value).toBe('');
      expect(result.properties.part.name).toBe('image.png');
      expect(result.properties.part.source.type).toBe('file');
      expect(result.properties.part.source.path).toBe('/foo');
    });

    it('strips only url when source is absent', () => {
      const data = createKilocodeEvent('message.part.updated', {
        part: {
          type: 'file',
          url: 'data:image/png;base64,abc123',
          name: 'image.png',
        },
      });

      const result = trimPayload('kilocode', data) as {
        properties: { part: { url: string; name: string } };
      };

      expect(result.properties.part.url).toBe('');
      expect(result.properties.part.name).toBe('image.png');
    });

    it('strips top-level url and source.text.value', () => {
      const data = {
        event: 'message.part.updated',
        part: {
          type: 'file',
          url: 'data:image/png;base64,top-level',
          name: 'image.png',
          source: {
            text: { value: 'top level file content', start: 0, end: 50 },
            type: 'file',
            path: '/foo',
          },
        },
      };

      const result = trimPayload('kilocode', data) as {
        part: {
          url: string;
          name: string;
          source: {
            text: { value: string; start: number; end: number };
            type: string;
            path: string;
          };
        };
      };

      expect(result.part.url).toBe('');
      expect(result.part.source.text.value).toBe('');
      expect(result.part.name).toBe('image.png');
      expect(result.part.source.type).toBe('file');
      expect(result.part.source.path).toBe('/foo');
      expect(result.part.source.text.start).toBe(0);
      expect(result.part.source.text.end).toBe(50);
    });

    it('strips both top-level and properties file parts', () => {
      const data = {
        event: 'message.part.updated',
        part: {
          type: 'file',
          url: 'data:image/png;base64,top-level',
          source: { text: { value: 'top level file content' } },
        },
        properties: {
          part: {
            type: 'file',
            url: 'data:image/png;base64,properties',
            source: { text: { value: 'properties file content' } },
          },
        },
      };

      const result = trimPayload('kilocode', data) as {
        part: { url: string; source: { text: { value: string } } };
        properties: { part: { url: string; source: { text: { value: string } } } };
      };

      expect(result.part.url).toBe('');
      expect(result.part.source.text.value).toBe('');
      expect(result.properties.part.url).toBe('');
      expect(result.properties.part.source.text.value).toBe('');
    });
  });

  describe('session.updated', () => {
    it('strips diffs but preserves other summary fields', () => {
      const data = createKilocodeEvent('session.updated', {
        info: {
          summary: {
            additions: 10,
            deletions: 5,
            files: 3,
            diffs: [{ file: 'a.ts', patch: '...' }],
          },
          other: 'preserved',
        },
      });

      const result = trimPayload('kilocode', data) as {
        properties: {
          info: {
            summary: { additions: number; deletions: number; files: number; diffs: unknown };
            other: string;
          };
        };
      };

      expect(result.properties.info.summary.diffs).toBeUndefined();
      expect(result.properties.info.summary.additions).toBe(10);
      expect(result.properties.info.summary.deletions).toBe(5);
      expect(result.properties.info.summary.files).toBe(3);
      expect(result.properties.info.other).toBe('preserved');
    });

    it('passes through when summary is absent', () => {
      const data = createKilocodeEvent('session.updated', {
        info: { other: 'data' },
      });

      expect(trimPayload('kilocode', data)).toEqual(data);
    });
  });

  describe('output event', () => {
    it('truncates large content', () => {
      const largeContent = 'x'.repeat(20_000);
      const data = { content: largeContent };

      const result = trimPayload('output', data) as { content: string };

      expect(result.content.length).toBe(MAX_STDOUT_LENGTH + '\n\n[…truncated]'.length);
      expect(result.content).toEqual(largeContent.slice(0, MAX_STDOUT_LENGTH) + '\n\n[…truncated]');
    });

    it('leaves small content unchanged', () => {
      const smallContent = 'x'.repeat(100);
      const data = { content: smallContent };

      const result = trimPayload('output', data) as { content: string };

      expect(result.content).toBe(smallContent);
    });
  });

  describe('passthrough event types', () => {
    it('returns heartbeat data unchanged', () => {
      const data = { ts: Date.now() };
      expect(trimPayload('heartbeat', data)).toEqual(data);
    });

    it('returns complete data unchanged', () => {
      const data = { exitCode: 0, currentBranch: 'main' };
      expect(trimPayload('complete', data)).toEqual(data);
    });

    it('returns error data unchanged', () => {
      const data = { error: 'something broke', fatal: true };
      expect(trimPayload('error', data)).toEqual(data);
    });
  });

  describe('immutability', () => {
    it('does not mutate the original data', () => {
      const largeOutput = 'x'.repeat(20_000);
      const data = createKilocodeEvent('message.part.updated', {
        part: {
          type: 'tool',
          state: { status: 'completed', output: largeOutput },
        },
      });

      const snapshot = JSON.parse(JSON.stringify(data)) as unknown;

      trimPayload('kilocode', data);

      expect(data).toEqual(snapshot);
    });
  });

  describe('non-object data', () => {
    it('returns a plain string unchanged', () => {
      expect(trimPayload('kilocode', 'just a string')).toBe('just a string');
    });
  });
});
