import assert from 'node:assert/strict';
import test from 'node:test';

import { dump } from './rules/test-dump';
import { contentBox, normalize, parseDump } from './tree';

test('parseDump accepts JSON strings and rejects malformed dumps', () => {
  const valid = dump([{ parent: 0, tag: 'Paragraph', rect: [0, 0, 10, 10], text: 'x' }]);
  assert.deepEqual(parseDump(JSON.stringify(valid)), valid);
  assert.throws(() => parseDump({ ...valid, version: 2 }));
  assert.throws(() =>
    parseDump({ ...valid, nodes: [...valid.nodes, { parent: 5, tag: 'View', rect: [0, 0, 1, 1] }] })
  );
  assert.throws(() =>
    parseDump({ ...valid, nodes: [{ parent: 0, tag: 'View', rect: [0, 0, 1, 1] }] })
  );
});

test('normalize drops invisible subtrees', () => {
  const layout = normalize(
    dump([
      { parent: 0, tag: 'View', rect: [0, 0, 10, 10], style: { display: 'none' } },
      { parent: 1, tag: 'Paragraph', rect: [0, 0, 10, 10], text: 'hidden' },
      { parent: 0, tag: 'View', rect: [0, 0, 10, 10], style: { opacity: 0 } },
      { parent: 0, tag: 'RNSScreen', rect: [0, 0, 400, 800], screenState: 0 },
      { parent: 4, tag: 'Paragraph', rect: [0, 0, 10, 10], text: 'inactive' },
      { parent: 0, tag: 'View', rect: [500, 0, 10, 10] },
      { parent: 6, tag: 'Paragraph', rect: [0, 0, 10, 10], text: 'offscreen parent' },
      { parent: 0, tag: 'RNSScreen', rect: [0, 0, 400, 800], screenState: 2 },
      { parent: 8, tag: 'Paragraph', rect: [0, 0, 10, 10], text: 'shown' },
    ])
  );
  assert.deepEqual(
    layout.nodes.map(node => node.index),
    [0, 8, 9]
  );
});

test('normalize lifts children of zero-area wrappers and drops clipped-away nodes', () => {
  const layout = normalize(
    dump([
      { parent: 0, tag: 'View', rect: [0, 0, 0, 0] },
      { parent: 1, tag: 'Paragraph', rect: [0, 0, 10, 10], text: 'lifted' },
      { parent: 0, tag: 'View', rect: [0, 100, 50, 50], style: { overflow: 'hidden' } },
      { parent: 3, tag: 'View', rect: [0, 200, 50, 50] },
    ])
  );
  assert.deepEqual(
    layout.nodes.map(node => [node.index, node.parent?.index]),
    [
      [0, undefined],
      [2, 0],
      [3, 0],
    ]
  );
  assert.equal(layout.nodes[2].clips, true);
});

test('normalize classifies scroll axes, absolute nodes, text, and controls', () => {
  const layout = normalize(
    dump([
      { parent: 0, tag: 'RCTScrollView', rect: [0, 0, 400, 400] },
      { parent: 1, tag: 'View', rect: [0, 0, 400, 900] },
      { parent: 0, tag: 'RCTScrollView', rect: [0, 400, 400, 100] },
      { parent: 3, tag: 'View', rect: [0, 400, 900, 100], style: { flexDirection: 'row' } },
      {
        parent: 0,
        tag: 'View',
        rect: [0, 0, 10, 10],
        role: 'button',
        style: { position: 'absolute' },
      },
      { parent: 5, tag: 'AndroidTextInput', rect: [0, 0, 10, 10], text: 'value' },
    ])
  );
  const byIndex = new Map(layout.nodes.map(node => [node.index, node]));
  assert.deepEqual(byIndex.get(1)?.scroll, { x: false, y: true });
  assert.deepEqual(byIndex.get(3)?.scroll, { x: true, y: false });
  assert.equal(byIndex.get(5)?.absolute, true);
  assert.equal(byIndex.get(5)?.isControl, true);
  assert.equal(byIndex.get(5)?.hasText, true);
  assert.equal(byIndex.get(6)?.isTextInput, true);
  assert.equal(byIndex.get(0)?.hasText, true);
});

test('normalize builds owner-aware paths and disambiguated identity keys', () => {
  const owners = ['View', 'StoredSessionRow', 'SessionList'];
  const layout = normalize(
    dump([
      { parent: 0, tag: 'View', rect: [0, 0, 400, 50], owners },
      {
        parent: 1,
        tag: 'Paragraph',
        rect: [0, 0, 100, 20],
        owners: ['Text', ...owners.slice(1)],
        text: 'Row',
      },
      {
        parent: 1,
        tag: 'Paragraph',
        rect: [0, 20, 100, 20],
        owners: ['Text', ...owners.slice(1)],
        text: 'Row',
      },
      { parent: 0, tag: 'Image', rect: [0, 60, 40, 40], testID: 'send', label: 'Send' },
    ])
  );
  assert.equal(layout.nodes[3].path, 'StoredSessionRow > View > Paragraph[1]');
  assert.equal(layout.nodes[3].ref.path, layout.nodes[3].path);
  assert.equal(layout.nodes[2].key, 'text:Paragraph|StoredSessionRow|Row');
  assert.equal(layout.nodes[3].key, 'text:Paragraph|StoredSessionRow|Row#1');
  assert.equal(layout.nodes[4].key, 'testID:send');
  assert.equal(layout.nodes[4].path, 'Image');
  assert.equal(layout.nodes[4].structuralPath, 'View/Image');
});

test('normalize ignores native stack header config subtrees', () => {
  const layout = normalize(
    dump([
      { parent: 0, tag: 'RNSScreenStackHeaderConfig', rect: [0, 0, 400, 56] },
      { parent: 1, tag: 'Paragraph', rect: [0, 0, 100, 20], text: 'Title' },
      { parent: 0, tag: 'View', rect: [0, 0, 400, 0] },
    ])
  );
  assert.deepEqual(
    layout.nodes.map(node => node.index),
    [0]
  );
});

test('contentBox honors logical inline and block padding, swapping start and end in RTL', () => {
  const style = { paddingInline: 10, paddingInlineStart: 4, paddingBlock: 3, paddingBlockEnd: 5 };
  const [ltrNode] = normalize(
    dump([{ parent: 0, tag: 'View', rect: [0, 0, 100, 40], style }])
  ).nodes.slice(1);
  assert.deepEqual(contentBox(ltrNode, false), [4, 3, 86, 32]);
  assert.deepEqual(contentBox(ltrNode, true), [10, 3, 86, 32]);
});

test('parseDump accepts tapTarget with or without the dropped icon key', () => {
  const valid = dump([]);
  assert.deepEqual(parseDump(valid).env.tapTarget, { min: 28, touch: 44 });
  const withIcon = { ...valid, env: { ...valid.env, tapTarget: { min: 28, touch: 44, icon: 48 } } };
  assert.deepEqual(parseDump(withIcon).env.tapTarget, { min: 28, touch: 44 });
});

test('normalize places a presented sheet in window space', () => {
  // `@expo/ui` presents its Android sheet in a dialog of its own: the RN host
  // and its children report frames inside that dialog, and the platform anchors
  // it above the navigation inset.
  const sheet = (contentHeight: number) =>
    normalize(
      dump(
        [
          {
            parent: 0,
            tag: 'ViewManagerAdapter_ExpoUI_HostView',
            rect: [0, 0, 400, contentHeight],
          },
          {
            parent: 1,
            tag: 'ViewManagerAdapter_ExpoUI_RNHostView',
            rect: [0, 0, 400, contentHeight],
          },
          { parent: 2, tag: 'SheetScrollContextReset', rect: [0, 0, 400, contentHeight] },
          { parent: 3, tag: 'Paragraph', rect: [10, 20, 200, 24], text: 'Discard draft?' },
        ],
        { safeArea: { top: 24, right: 0, bottom: 24, left: 0 } }
      )
    );

  const short = sheet(200);
  // The platform anchors the dialog's bottom above the 24dp navigation inset,
  // so a 200dp sheet starts at 800 - 24 - 200 = 576.
  assert.deepEqual(
    short.nodes.map(node => node.rect[1]),
    [0, 576, 576, 576, 596]
  );
  assert.deepEqual(short.nodes[4].presented, { space: 1, dy: 576 });
  // Its title is below the status bar, not 20dp into it.
  assert.ok(short.nodes[4].rect[1] > 24);

  // A full detent already spans that area: the sheet is not moved, and its
  // content still reaches the top edge for the caller to pad.
  const full = sheet(776);
  assert.deepEqual(
    full.nodes.map(node => node.rect[1]),
    [0, 0, 0, 0, 20]
  );
});

test('normalize leaves iOS sheets and non-sheet subtrees where they report', () => {
  const nodes = [
    { parent: 0, tag: 'ViewManagerAdapter_ExpoUI_HostView', rect: [0, 0, 400, 200] },
    { parent: 1, tag: 'ViewManagerAdapter_ExpoUI_RNHostView', rect: [0, 0, 400, 200] },
    { parent: 2, tag: 'Paragraph', rect: [10, 20, 200, 24], text: 'Title' },
    { parent: 0, tag: 'View', rect: [0, 300, 400, 100] },
    { parent: 4, tag: 'Paragraph', rect: [10, 320, 200, 24], text: 'Body' },
  ] as const;
  const ios = normalize(dump([...nodes], { platform: 'ios' }));
  assert.deepEqual(
    ios.nodes.map(node => node.rect[1]),
    [0, 0, 0, 20, 300, 320]
  );
  assert.ok(ios.nodes.every(node => node.presented === undefined));
});

test('normalize drops the development error overlay', () => {
  // The overlay reports a development warning that a release build never shows,
  // and it floats above the measured screen, so its controls read as overlapping
  // the screen's own. A finding about it is a finding about the instrument.
  const layout = normalize(
    dump([
      { parent: 0, tag: 'View', rect: [0, 0, 400, 33], owners: ['LogBoxButton'] },
      { parent: 1, tag: 'View', rect: [0, 0, 400, 33], owners: ['View', 'LogBoxButton'] },
      { parent: 0, tag: 'View', rect: [0, 40, 100, 40], owners: ['SendButton'] },
    ])
  );
  // The root and the screen's own control survive; the overlay's subtree does not.
  assert.deepEqual(
    layout.nodes.map(node => node.rect[1]),
    [0, 40]
  );
});
