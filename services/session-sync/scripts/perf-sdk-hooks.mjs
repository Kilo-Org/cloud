import assert from 'node:assert/strict';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function observeSDKSource(file, observe) {
  const target = pathToFileURL(file).href;
  globalThis.__sessionSyncPerfStage = observe;
  return registerHooks({
    load(url, context, nextLoad) {
      if (url !== target) return nextLoad(url, context);
      let source = readFileSync(file, 'utf8');
      const dequeue = source.includes('JSON.parse(item.data)') ? 'item.data' : 'data';
      const anchors = [
        [
          `const frame = envelopeSchema.parse(JSON.parse(${dequeue}));`,
          `globalThis.__sessionSyncPerfStage?.('dequeue', ${dequeue}); const frame = envelopeSchema.parse(JSON.parse(${dequeue}));`,
        ],
        [
          'visible(applyNativeEvent(state.messages, frame))',
          "visible((() => { globalThis.__sessionSyncPerfStage?.('projection_start', frame); const result = applyNativeEvent(state.messages, frame); globalThis.__sessionSyncPerfStage?.('projection_end', frame); return result; })())",
        ],
      ];
      for (const [anchor, replacement] of anchors) {
        assert.equal(
          source.split(anchor).length,
          2,
          'SDK instrumentation anchor changed; review the pinned source'
        );
        source = source.replace(anchor, replacement);
      }
      return {
        format: 'module',
        shortCircuit: true,
        source: stripTypeScriptTypes(source, { mode: 'transform' }),
      };
    },
  });
}
