import assert from 'node:assert/strict';
import test from 'node:test';

import { contentBox, normalize, parseDump, type ProbeNode } from '../tree';
import { checkScreen } from './index';
import { dump, tree } from './test-dump';

test('contentBox matches Yoga logical-edge and RN alias precedence in LTR and RTL', () => {
  const box = (style: ProbeNode['style'], rtl: boolean) => {
    const layout = tree([{ parent: 0, tag: 'View', rect: [0, 0, 100, 80], style }]);
    return contentBox(layout.nodes[1], rtl);
  };
  const base = { borderWidth: 1, padding: 1, paddingTop: 3, paddingBottom: 5 };
  const physical = { ...base, paddingLeft: 23, paddingRight: 29, paddingHorizontal: 31 };
  const logical = { ...physical, paddingStart: 17, paddingEnd: 19 };
  const aliases = { ...logical, paddingInlineStart: 7, paddingInlineEnd: 11 };
  assert.deepEqual(box(aliases, false), [8, 4, 80, 70]);
  assert.deepEqual(box(aliases, true), [12, 4, 80, 70]);
  assert.deepEqual(box(logical, false), [18, 4, 62, 70]);
  assert.deepEqual(box(logical, true), [20, 4, 62, 70]);
  assert.deepEqual(box({ ...physical, paddingInline: 13 }, false), [24, 4, 46, 70]);
  assert.deepEqual(
    box({ ...base, paddingHorizontal: 31, paddingInline: 13 }, false),
    [14, 4, 72, 70]
  );
  assert.deepEqual(box({ ...base, paddingVertical: 21, paddingBlock: 17 }, false), [2, 4, 96, 70]);
  assert.deepEqual(
    box(
      {
        borderWidth: 1,
        paddingBlockStart: 7,
        paddingBlockEnd: 9,
        paddingBlock: 17,
        paddingVertical: 21,
      },
      false
    ),
    [1, 8, 98, 62]
  );
  assert.deepEqual(
    box({ borderWidth: 1, paddingBlock: 17, paddingVertical: 21 }, false),
    [1, 18, 98, 44]
  );
});

test('normalize preserves explicit scroll axes for generic accessibility containers', () => {
  for (const tag of [
    'androidx.recyclerview.widget.RecyclerView',
    'androidx.compose.ui.platform.ComposeView',
  ]) {
    const parsed = parseDump(
      dump(
        [
          { parent: 0, tag, rect: [0, 0, 400, 800], scrollAxes: { x: true, y: true } },
          { parent: 1, tag: 'Paragraph', rect: [0, 10, 600, 20], text: 'Scrolled content' },
        ],
        { safeAreaKnown: false }
      )
    );
    const layout = normalize(parsed);
    assert.deepEqual(layout.nodes[1].scroll, { x: true, y: true });
    assert.equal(layout.nodes[1].clips, true);
    assert.deepEqual(
      checkScreen(layout).filter(f => f.rule === 'cut-off' || f.rule === 'clipped'),
      []
    );
  }
  const layout = tree([
    { parent: 0, tag: 'ScrollView', rect: [0, 0, 400, 800], scrollAxes: { x: false, y: false } },
  ]);
  assert.deepEqual(layout.nodes[1].scroll, { x: false, y: false });
});

test('safe-area checking skips explicitly unknown inset measurements', () => {
  const children: ProbeNode[] = [
    { parent: 0, tag: 'Paragraph', rect: [0, 10, 100, 20], text: 'Title' },
  ];
  const safeArea = { top: 24, right: 0, bottom: 30, left: 0 };
  const unknown = normalize(parseDump(dump(children, { safeArea, safeAreaKnown: false })));
  assert.deepEqual(
    checkScreen(unknown).filter(f => f.rule === 'safe-area'),
    []
  );
  assert.equal(
    checkScreen(tree(children, { safeArea, safeAreaKnown: true })).filter(
      f => f.rule === 'safe-area'
    ).length,
    1
  );
  assert.equal(
    checkScreen(tree(children, { safeArea })).filter(f => f.rule === 'safe-area').length,
    1
  );
});
