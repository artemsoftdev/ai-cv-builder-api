const AFFIRMATIVE_RE =
  /^(?:yes|yeah|yep|yup|sure|correct|right|exactly|indeed|absolutely|true|да|верно|конечно|точно|ja|genau|oui|sí|si)(?!\p{L})/iu;
const NEGATION_RE = /(?<!\p{L})(?:no|not|never|nope|нет|не|nicht|nein|non)(?!\p{L})/iu;
const MAX_BARE_ANSWER_WORDS = 3;

/** A bare "yes" carries no facts of its own, so it confirms its question's statement. */
export function answerFacts(question: string, answer: string): string[] {
  const text = answer.trim();
  const words = text.match(/[\p{L}\p{N}']+/gu) ?? [];
  const bareYes =
    words.length > 0 &&
    words.length <= MAX_BARE_ANSWER_WORDS &&
    AFFIRMATIVE_RE.test(text) &&
    !NEGATION_RE.test(text);
  return bareYes ? [answer, question] : [answer];
}
