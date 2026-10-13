/*
 * Manual check of the real Claude integration (no database needed). Drafts a CV from a text
 * file, or transcribes a PDF first, then runs the sanitiser and the grounding verifier and
 * prints the result. Optionally applies an answer to the first question.
 *
 *   npm run smoke:llm -- [source.txt|source.pdf] [target role] [answer to the first question]
 *
 * Reads ANTHROPIC_API_KEY (and the other ANTHROPIC_* settings) from .env.
 */
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config/config.js';
import { createLogger } from '../src/logger.js';
import { sanitizeDraft } from '../src/modules/generation/draft-sanitizer.js';
import { applySectionRewrite, sectionSnapshot } from '../src/modules/generation/section-rewrite.js';
import { Corpus } from '../src/modules/grounding/corpus.js';
import { replaceReviewPart, verifyContent } from '../src/modules/grounding/verifier.js';
import { normalizeSourceText } from '../src/modules/ingestion/source-text.js';
import { AnthropicLlmClient } from '../src/modules/llm/anthropic-llm-client.js';

const SAMPLE = `Jane Doe
jane.doe@example.com | +49 30 1234567 | github.com/janedoe
Backend developer, 6 years. Mostly Node.js and PostgreSQL, some Go.

Acme Payments, Berlin — Backend Developer, 2021 – now
- billing service rewrite (Node.js -> Go), p99 latency 450ms -> 120ms
- on-call for payment gateway, wrote runbooks
- mentoring two juniors

Globex GmbH — Web Developer, 2018–2021
- PHP/Symfony shop, migrated to Node.js
- set up CI with GitHub Actions

TU Berlin — BSc Computer Science (2014–2018)`;

async function main(): Promise<void> {
  const [path, role = 'Senior Backend Engineer', answer] = process.argv.slice(2);
  // The LLM settings are all this needs; DATABASE_URL is required by the schema only.
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused@localhost/unused',
  });
  const logger = createLogger('info');
  const llm = new AnthropicLlmClient({ ...config.llm, provider: 'anthropic' }, logger);

  let sourceText = SAMPLE;
  if (path?.endsWith('.pdf')) {
    sourceText = normalizeSourceText(await llm.transcribePdf(await readFile(path)));
    console.log(`--- transcription ---\n${sourceText}\n`);
  } else if (path) {
    sourceText = normalizeSourceText(await readFile(path, 'utf8'));
  }

  const startedAt = Date.now();
  const draft = await llm.draftCv({ sourceText, targetRole: role });
  const sanitized = sanitizeDraft(draft);
  const corpus = new Corpus(sourceText);
  const { content, review } = verifyContent(sanitized.content, sanitized.claimedEvidence, corpus);
  console.log(`--- draft (${Date.now() - startedAt} ms) ---`);
  console.log(JSON.stringify({ content, review, questions: sanitized.questions }, null, 2));

  const question = sanitized.questions[0];
  if (answer && question) {
    const target = { section: question.section, itemId: question.itemId };
    const rewrite = await llm.rewriteSection({
      ...sectionSnapshot(content, target),
      targetRole: role,
      sourceText,
      question: question.question,
      answer,
      priorAnswers: [],
    });
    const applied = applySectionRewrite(content, target, rewrite, new Corpus(sourceText, [answer]));
    console.log(`--- after answering "${question.question}" ---`);
    console.log(
      JSON.stringify(
        { rewrite, review: replaceReviewPart(review, applied.scope, applied.review) },
        null,
        2,
      ),
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
