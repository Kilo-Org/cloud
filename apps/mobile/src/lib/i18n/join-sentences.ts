import { i18n } from '@/i18n';

/**
 * Join sentences into the reader's copy. A sentence keeps exactly one
 * terminator: the catalog's sentence joiner supplies the separator between two
 * sentences, a sentence that already ends with that same stop drops it so the
 * join never writes it twice, and the last sentence keeps the closing stop it
 * brought.
 */
export function joinSentences(parts: readonly string[]): string {
  const joiner = i18n.t('common.sentenceJoiner');
  // A catalog's `common.sentenceJoiner` is the separator it writes between two
  // sentences: one sentence terminator plus optional spaces in nearly every
  // catalog (`. `, `। `, `۔ `, `。`), so its first non-space character is the
  // exact stop the join writes between sentences. Thai writes no sentence
  // terminator, so its joiner is a plain space and that character is empty.
  const terminator = joiner.trimStart().charAt(0);
  // Thai is the one catalog whose copy carries no sentence terminators, so its
  // joiner has no stop to strip; joining with the catalog's own separator is
  // exactly the text it writes between two sentences.
  if (terminator === '') {
    return parts.join(joiner);
  }
  const sentences = parts.map(part => part.trimEnd()).filter(part => part.length > 0);

  return sentences
    .map((sentence, index) => {
      let text = sentence;
      let closed = false;
      while (text.endsWith(terminator)) {
        closed = true;
        text = text.slice(0, -1).trimEnd();
      }
      // The join only separates sentences, so the last one restores the closing
      // stop it brought. A sentence that brought none still gets none.
      return index === sentences.length - 1 && closed ? `${text}${terminator}` : text;
    })
    .join(joiner);
}
