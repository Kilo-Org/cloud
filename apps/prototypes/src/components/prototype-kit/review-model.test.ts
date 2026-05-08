import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrototypeReviewModel } from './index';

test('review model derives visible sections and table-of-contents items from one registry', () => {
  const review = createPrototypeReviewModel({
    currentView: 'admin',
    sections: [
      {
        id: 'overview',
        label: 'Overview',
        title: 'Overview section',
        url: '/overview',
        visibility: 'all',
      },
      {
        id: 'member-only',
        label: 'Member surface',
        title: 'Member section',
        url: '/member',
        visibility: 'member',
      },
      {
        id: 'admin-only',
        label: 'Admin surface',
        title: 'Admin section',
        url: '/admin',
        visibility: 'admin',
        visibilityLabel: 'Admin only',
      },
    ],
  });

  assert.deepEqual(
    review.sections.map(section => ({
      id: section.id,
      visible: section.visible,
      anchorHref: section.anchorHref,
      visibilityLabel: section.visibilityLabel,
    })),
    [
      { id: 'overview', visible: true, anchorHref: '#overview', visibilityLabel: undefined },
      { id: 'member-only', visible: false, anchorHref: '#member-only', visibilityLabel: undefined },
      { id: 'admin-only', visible: true, anchorHref: '#admin-only', visibilityLabel: 'Admin only' },
    ]
  );
  assert.deepEqual(
    review.visibleSections.map(section => section.id),
    ['overview', 'admin-only']
  );
  assert.deepEqual(review.tocItems, [
    { id: 'overview', label: 'Overview', href: '#overview' },
    { id: 'admin-only', label: 'Admin surface', href: '#admin-only' },
  ]);
});
