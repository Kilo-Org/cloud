import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPrNounKey } from '@/components/pr-review/pr-review-provider-noun';
import { providerPrMergeTitles } from '@/components/pr-review/merge/pr-merge-titles';
import { i18n } from '@/i18n';
import { type ProviderPrPlatform } from '@kilocode/app-shared/provider-review';

/**
 * French selects `one` for both 0 and 1, so a counted message whose `_one`
 * branch repeated the plural sentence read as plural for a single truncated
 * line, a single posted or stale comment and a one-line expand row. The
 * file-progress strings carried a fixed masculine plural participle with no
 * count form at all, so a one-file list read "1 sur 1 consultés".
 *
 * Nine sentences interpolate the provider noun, which this catalog renders as
 * the feminine "PR" or the masculine "merge request". No determiner or
 * participle agrees with both, so each sentence names the noun in a trailing
 * label and the text before it stays complete without the noun.
 */

// The catalog is loaded per language by the app's backend, so the language has
// to change once rather than passing `lng` to each call.
beforeAll(async () => {
  await i18n.changeLanguage('fr');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

/** The rendered sentence for a provider platform's noun. */
function withTerm(key: string, platform: ProviderPrPlatform): string {
  return i18n.t(key, { term: i18n.t(providerPrNounKey(platform)) });
}

describe('French counted PR-review copy', () => {
  it('describes one truncated line in the singular and several in the plural', () => {
    expect(i18n.t('prReview.discussion.moreLinesAbove', { count: 1, displayCount: '1' })).toBe(
      '… 1 ligne supplémentaire au-dessus'
    );
    expect(i18n.t('prReview.discussion.moreLinesAbove', { count: 3, displayCount: '3' })).toBe(
      '… des lignes supplémentaires se trouvent au-dessus : 3'
    );
  });

  it('describes a one-line gap in the singular and a wider gap in the plural', () => {
    expect(i18n.t('prReview.hunkRows.expandAllLines', { count: 1, displayCount: '1' })).toBe(
      'Afficher la ligne (1)'
    );
    expect(i18n.t('prReview.hunkRows.expandAllLines', { count: 4, displayCount: '4' })).toBe(
      'Afficher toutes les lignes (4)'
    );
  });

  it('counts posted comments in agreement with every count it can be given', () => {
    // The clause renders whenever a review left stale comments behind, and a
    // review where every pending comment is stale posts none of them.
    expect(i18n.t('prReview.submit.partialPostedFresh', { count: 0, displayFreshCount: '0' })).toBe(
      'Publié : 0 commentaire. '
    );
    expect(i18n.t('prReview.submit.partialPostedFresh', { count: 1, displayFreshCount: '1' })).toBe(
      'Publié : 1 commentaire. '
    );
    expect(i18n.t('prReview.submit.partialPostedFresh', { count: 2, displayFreshCount: '2' })).toBe(
      'Commentaires publiés : 2. '
    );
  });

  it('describes one held-back comment in the singular and several in the plural', () => {
    // The stale clause is null at a count of zero, so only 1 and more reach it.
    expect(i18n.t('prReview.submit.partialPostedStale', { count: 1, displayStaleCount: '1' })).toBe(
      'Commentaire conservé en attente car il concerne un commit plus ancien : 1.'
    );
    expect(i18n.t('prReview.submit.partialPostedStale', { count: 2, displayStaleCount: '2' })).toBe(
      'Commentaires conservés en attente car ils concernent un commit plus ancien : 2.'
    );
  });

  it('agrees the viewed participle with a one-file and a several-file list', () => {
    const options = (total: number) => ({
      count: total,
      viewed: String(total),
      total: String(total),
    });
    expect(i18n.t('prReview.fileNavigator.viewedCount', options(1))).toBe('1 sur 1 consulté');
    expect(i18n.t('prReview.fileNavigator.viewedCount', options(2))).toBe('2 sur 2 consultés');
    expect(i18n.t('prReview.fileNavigator.viewedOfListed', options(1))).toBe(
      '1 sur 1 consulté parmi les fichiers affichés'
    );
    expect(i18n.t('prReview.fileNavigator.viewedOfListed', options(2))).toBe(
      '2 sur 2 consultés parmi les fichiers affichés'
    );
  });
});

describe('French provider-noun sentences', () => {
  const PLATFORMS: readonly ProviderPrPlatform[] = ['github', 'gitlab'];

  it('names the provider after a complete sentence, whatever its gender', () => {
    const expected = {
      'prReview.discussion.replyForbiddenTerm':
        "Vous n'avez pas l'autorisation de répondre ici ({}).",
      'prReview.merge.providerBlocked.permission': 'Fusion non autorisée ({}).',
      'prReview.merge.providerBlocked.draft':
        'Marquez comme prêt(e) pour la revue avant de fusionner ({}).',
      'prReview.merge.mergeTermTitle': 'Fusionner : {}',
      'prReview.merge.confirmTitleTerm': 'Fusionner : {} ?',
      'prReview.merge.enableAutoMergeConfirmMessageTerm':
        'Une fois le pipeline réussi, la fusion sera automatique ({}).',
      'prReview.merge.enableAutoMergeDescriptionTerm':
        'GitLab fusionnera automatiquement dès que le pipeline réussit ({}).',
      'prReview.operation.mergeResultNotCompleted':
        "La fusion n'a pas abouti ({}). Vérifiez son état et réessayez.",
    } as const;
    for (const [key, sentence] of Object.entries(expected)) {
      for (const platform of PLATFORMS) {
        const term = i18n.t(providerPrNounKey(platform));
        expect(withTerm(key, platform), `${key} ${platform}`).toBe(sentence.replace('{}', term));
      }
    }
  });

  it('keeps both provider nouns of the review-submission refusal inside a label', () => {
    for (const platform of PLATFORMS) {
      const term = i18n.t(providerPrNounKey(platform));
      expect(withTerm('prReview.mutationError.reviewNotSubmittedTerm', platform)).toBe(
        `Impossible d'envoyer cette revue en l'état (${term}). Le contenu a peut-être changé, ou vous ne pouvez pas examiner votre propre travail (${term}).`
      );
    }
  });
});

/**
 * Three controls take their visible label from one key and their accessible
 * name from another, and in English each pair shares one verb and one noun, so
 * the spoken name holds the word on screen. A pair that loses that shape makes
 * the spoken name differ from what is shown.
 *
 * The block also covers labels a reader compares side by side: two file
 * statuses, the open chip against the combined chips, the review-service
 * failure against the neighbouring generic failures, and the merge button
 * against the heading of the sheet it opens.
 */
describe('French PR-review labels and the names announced for them', () => {
  it('starts each accessible name with the visible label it belongs to', () => {
    const pairs = [
      ['prReview.floatingActions.clear', 'prReview.floatingActions.clearSelection'],
      ['prReview.hunkRows.goToOverview', 'prReview.hunkRows.goToOverviewTab'],
      ['prReview.review', 'prReview.reviewPullRequest'],
    ] as const;
    for (const [visible, name] of pairs) {
      expect(i18n.t(name).startsWith(i18n.t(visible)), `${name} names ${visible}`).toBe(true);
    }
  });

  it('gives a changed file its own label beside the modified one', () => {
    expect(i18n.t('prReview.fileStatus.changed')).not.toBe(i18n.t('prReview.fileStatus.modified'));
  });

  it('reads the open chip like the combined chips on the same screen', () => {
    const open = i18n.t('prReview.overview.stateOpen');
    expect(i18n.t('prReview.overview.stateOpenApproved').startsWith(open)).toBe(true);
    expect(i18n.t('prReview.overview.stateOpenReviewRequired').startsWith(open)).toBe(true);
  });

  it('names the review service in the unavailable copy', () => {
    expect(i18n.t('prReview.reviewServiceUnavailable')).toContain('revue');
    expect(i18n.t('prReview.reviewServiceUnavailableDescription')).toContain('service de revue');
  });

  it('keeps the end-of-file warning marker on a fragment', () => {
    const label = i18n.t('prReview.sideBySide.noNewlineAtEndOfFile');
    expect(label.startsWith('⚠️ ')).toBe(true);
    expect(label.endsWith('.')).toBe(false);
  });

  it('asks the file field to filter by path, as its own accessible name does', () => {
    expect(i18n.t('prReview.fileNavigator.filterPlaceholder').startsWith('Filtrer')).toBe(true);
  });

  it('words the merge action as a verb and the sheet heading as a noun', () => {
    const action = i18n.t('prReview.merge.merge');
    const pullRequestAction = i18n.t('prReview.merge.mergePullRequest');
    // The section button and the merge sheet's submit label read `merge`, so
    // the heading above them cannot be the same bare verb.
    expect(pullRequestAction.startsWith(`${action} `)).toBe(true);
    expect(i18n.t('prReview.merge.mergeTitle')).not.toBe(action);
    // The merge screen and the section button both consume the helper, so the
    // split has to hold there. Only the merge-request arm words its action as a
    // bare verb and takes the heading from the merge noun. GitHub names the
    // pull request inside its action, and Bitbucket fills both fields from the
    // term template, so on those two the heading may read as the action.
    const fixed = i18n.getFixedT('fr');
    const gitlab = providerPrMergeTitles(fixed, 'gitlab');
    expect(gitlab.action).toBe(action);
    expect(gitlab.title).toBe(i18n.t('prReview.merge.mergeTitle'));

    const github = providerPrMergeTitles(fixed, 'github');
    expect(github.action).toBe(pullRequestAction);
    expect(github.title).toBe(pullRequestAction);

    const bitbucket = providerPrMergeTitles(fixed, 'bitbucket');
    expect(bitbucket.action).toBe(
      i18n.t('prReview.merge.mergeTermTitle', { term: i18n.t('common.pullRequest') })
    );
    expect(bitbucket.title).toBe(bitbucket.action);
  });
});
