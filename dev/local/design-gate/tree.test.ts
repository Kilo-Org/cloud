import assert from 'node:assert/strict';
import test from 'node:test';

import { dump } from './rules/test-dump';
import {
  contentBox,
  layoutRect,
  normalize,
  parseDump,
  type LayoutTree,
  type ProbeNode,
} from './tree';

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

test('normalize places an iOS @expo/ui sheet above the bottom inset and leaves other subtrees', () => {
  // The part-detail sheet on iOS: the host reports 778 pt on an 874 pt window
  // with a 34 pt home indicator inset, and its title paints 62 pt lower than the
  // probe reports, like the Android dialog.
  const nodes = [
    { parent: 0, tag: 'ViewManagerAdapter_ExpoUI_HostView', rect: [0, 0, 402, 778] },
    { parent: 1, tag: 'ViewManagerAdapter_ExpoUI_RNHostView', rect: [0, 0, 402, 778] },
    { parent: 2, tag: 'Paragraph', rect: [14, 25.5, 315.5, 24.5], text: 'Sent file' },
    { parent: 0, tag: 'View', rect: [0, 70, 48, 48] },
    { parent: 4, tag: 'Paragraph', rect: [10, 80, 20, 24], text: 'Back' },
  ] as const;
  const ios = normalize(
    dump([...nodes], {
      platform: 'ios',
      window: { width: 402, height: 874 },
      safeArea: { top: 62, right: 0, bottom: 34, left: 0 },
    })
  );
  assert.deepEqual(
    ios.nodes.map(node => node.rect[1]),
    [0, 62, 62, 87.5, 70, 80]
  );
  assert.deepEqual(ios.nodes[3].presented, { space: 1, dy: 62 });
  assert.equal(ios.nodes[4].presented, undefined);
});

test('normalize drops an inactive iOS modal and one a later presentation covers', () => {
  const ios = { platform: 'ios', window: { width: 402, height: 874 } };
  const stack = (first: Partial<ProbeNode>, second?: Partial<ProbeNode>) =>
    normalize(
      dump(
        [
          { parent: 0, tag: 'RNSScreenStack', rect: [0, 0, 402, 874] },
          { parent: 1, tag: 'RNSScreen', rect: [0, 0, 402, 874], screenState: 2 },
          { parent: 2, tag: 'Paragraph', rect: [14, 100, 200, 24], text: 'Profile' },
          { parent: 1, tag: 'RNSModalScreen', rect: [0, 0, 402, 423], screenState: 2, ...first },
          { parent: 4, tag: 'Paragraph', rect: [14, 30, 200, 24], text: 'Language' },
          ...(second
            ? [
                {
                  parent: 1,
                  tag: 'RNSModalScreen',
                  rect: [0, 0, 402, 812],
                  screenState: 2,
                  ...second,
                },
                { parent: 6, tag: 'Paragraph', rect: [14, 30, 200, 24], text: 'Credits' },
              ]
            : []),
        ] as ProbeNode[],
        ios
      )
    );
  const texts = (layout: LayoutTree) =>
    layout.nodes.flatMap(node => (node.probe.text ? [node.probe.text] : []));
  // An active sheet leaves the screen it opened from painted behind it.
  assert.deepEqual(texts(stack({})), ['Profile', 'Language']);
  // A sheet react-native-screens keeps mounted but inactive is not on screen.
  assert.deepEqual(texts(stack({ screenState: 0 })), ['Profile']);
  // A sheet presented over another covers it.
  assert.deepEqual(texts(stack({}, {})), ['Profile', 'Credits']);
});

test('normalize places an iOS form sheet and page sheet at the window bottom', () => {
  // react-native-screens reports a presented sheet's frames from the sheet's
  // own top, and UIKit anchors the sheet to the window's bottom edge.
  const ios = { platform: 'ios', window: { width: 402, height: 874 } };
  const sheet = (height: number) =>
    normalize(
      dump(
        [
          { parent: 0, tag: 'RNSScreenStack', rect: [0, 0, 402, 874] },
          { parent: 1, tag: 'RNSScreen', rect: [0, 0, 402, 874], screenState: 2 },
          { parent: 2, tag: 'Paragraph', rect: [14, 100, 200, 24], text: 'Profile' },
          { parent: 1, tag: 'RNSModalScreen', rect: [0, 0, 402, height], screenState: 2 },
          {
            parent: 4,
            tag: 'View',
            rect: [14, 14, 52.67, 48],
            layoutRect: [14, 14, 52.67, 48],
            label: 'Cancel',
            pressable: true,
          },
          { parent: 5, tag: 'Paragraph', rect: [14, 27.5, 45.5, 21.5], text: 'Cancel' },
        ],
        ios
      )
    );
  const tops = (layout: LayoutTree) => layout.nodes.map(node => node.rect[1]);
  // A 423 pt form sheet starts at 874 - 423 = 451; the screen behind it stays.
  const form = sheet(423);
  assert.deepEqual(tops(form), [0, 0, 0, 100, 451, 465, 478.5]);
  assert.deepEqual(form.nodes[5].presented, { space: 4, dy: 451 });
  assert.deepEqual(layoutRect(form.nodes[5]), [14, 465, 52.67, 48]);
  assert.equal(form.nodes[3].presented, undefined);
  // A page sheet stops 62 pt below the top.
  assert.deepEqual(tops(sheet(812)), [0, 0, 0, 100, 62, 76, 89.5]);
  // A modal as tall as the window covers it and stays where it is.
  const full = sheet(874);
  assert.deepEqual(tops(full), [0, 0, 0, 100, 0, 14, 27.5]);
  assert.ok(full.nodes.every(node => node.presented === undefined));
});

test('normalize drops the iOS keyboard accessory placeholder', () => {
  // Its content paints only in the keyboard's accessory window.
  const layout = normalize(
    dump(
      [
        { parent: 0, tag: 'InputAccessoryView', rect: [14, 139.33, 402, 45.67] },
        { parent: 1, tag: 'View', rect: [350, 139.33, 52, 45.67], label: 'Done', pressable: true },
        { parent: 0, tag: 'Paragraph', rect: [14, 100, 200, 24], text: 'Instructions' },
      ],
      { platform: 'ios', window: { width: 402, height: 874 } }
    )
  );
  assert.deepEqual(
    layout.nodes.map(node => node.tag),
    ['View', 'Paragraph']
  );
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
