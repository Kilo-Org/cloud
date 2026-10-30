import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBounds, uiautomatorTag, uiautomatorToProbeDump } from './uiautomator';

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.kilocode.kiloapp" content-desc="" clickable="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Sessions &amp; tasks" resource-id="com.kilocode.kiloapp:id/title" class="android.widget.TextView" content-desc="" clickable="false" bounds="[42,84][600,147]" />
    <node index="1" text="" resource-id="new-session" class="android.view.ViewGroup" content-desc="New session" clickable="true" bounds="[960,84][1080,210]">
      <node index="0" text="" resource-id="" class="android.widget.ImageView" content-desc="" clickable="false" bounds="[990,114][1050,180]" />
    </node>
    <node index="2" text="Ask" resource-id="" class="android.widget.EditText" content-desc="" clickable="true" long-clickable="true" bounds="[0,2200][1080,2400]" />
  </node>
</hierarchy>`;

test('parseBounds and uiautomatorTag', () => {
  assert.deepEqual(parseBounds('[42,84][600,147]'), [42, 84, 600, 147]);
  assert.equal(parseBounds('garbage'), undefined);
  assert.equal(uiautomatorTag('android.widget.TextView'), 'Paragraph');
  assert.equal(uiautomatorTag('android.widget.EditText'), 'AndroidTextInput');
  assert.equal(uiautomatorTag('android.widget.HorizontalScrollView'), 'HorizontalScrollView');
  assert.equal(uiautomatorTag(''), 'View');
});

test('uiautomator XML converts to a ProbeDump in dp with DFS parents', () => {
  const dump = uiautomatorToProbeDump({
    xml: XML,
    densityDpi: 480,
    fontScale: 1,
    colorScheme: 'dark',
    language: 'ar-EG',
    osVersion: '15',
  });
  assert.equal(dump.env.source, 'uiautomator');
  assert.equal(dump.env.pixelRatio, 3);
  assert.deepEqual(dump.env.window, { width: 360, height: 800 });
  assert.equal(dump.env.isRTL, true);
  assert.equal(dump.env.colorScheme, 'dark');
  assert.deepEqual(
    dump.nodes.map(node => [node.parent, node.tag]),
    [
      [-1, 'View'],
      [0, 'FrameLayout'],
      [1, 'Paragraph'],
      [1, 'ViewGroup'],
      [3, 'Image'],
      [1, 'AndroidTextInput'],
    ]
  );
  assert.deepEqual(dump.nodes[0]?.rect, [0, 0, 360, 800]);
  assert.deepEqual(dump.nodes[2], {
    parent: 1,
    tag: 'Paragraph',
    rect: [14, 28, 186, 21],
    text: 'Sessions & tasks',
    testID: 'title',
  });
  assert.deepEqual(dump.nodes[3], {
    parent: 1,
    tag: 'ViewGroup',
    rect: [320, 28, 40, 42],
    label: 'New session',
    testID: 'new-session',
    pressable: true,
  });
  assert.equal(dump.nodes[5]?.pressable, true);
});
