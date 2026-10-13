import { describe, expect, it } from 'vitest';
import { Corpus } from './corpus.js';
import { normalizeText, normalizeUrl } from './normalize.js';

const LEFT_QUOTE = String.fromCharCode(0x201c);
const RIGHT_QUOTE = String.fromCharCode(0x201d);
const EN_DASH = String.fromCharCode(0x2013);
const ELLIPSIS = String.fromCharCode(0x2026);
const SOFT_HYPHEN = String.fromCharCode(0xad);

const SOURCE = [
  'Jane Doe - jane.doe@example.com - +49 (30) 123 45 67',
  'https://www.GitHub.com/JaneDoe/',
  `Backend Engineer at Acme Payments, 2019${EN_DASH}2023.`,
  'Built the "billing service" in Go; cut p99 latency by 40%.',
  'Stack: Node.js, TypeScript, JavaScript, PostgreSQL, CI/CD, C++.',
].join('\n');

describe('normalizeText', () => {
  it('unifies typography, case and whitespace', () => {
    expect(normalizeText(`  ${LEFT_QUOTE}Billing${RIGHT_QUOTE}\n\tService${ELLIPSIS} `)).toBe(
      '"billing" service...',
    );
    expect(normalizeText(`2019${EN_DASH}2023`)).toBe('2019-2023');
    expect(normalizeText(`co${SOFT_HYPHEN}operate`)).toBe('cooperate');
  });
});

describe('normalizeUrl', () => {
  it('drops scheme, www, trailing slash and case', () => {
    expect(normalizeUrl('https://www.GitHub.com/JaneDoe/')).toBe('github.com/janedoe');
    expect(normalizeUrl('github.com/janedoe')).toBe('github.com/janedoe');
    expect(normalizeUrl('mailto:Jane@Example.com')).toBe('jane@example.com');
  });
});

describe('Corpus', () => {
  const corpus = new Corpus(SOURCE);

  it('finds verbatim quotes regardless of case, quotes and line breaks', () => {
    expect(corpus.hasQuote('built the billing service')).toBe(false); // the source has quotes
    expect(corpus.hasQuote(`Built the ${LEFT_QUOTE}billing service${RIGHT_QUOTE} in Go`)).toBe(
      true,
    );
    expect(corpus.hasQuote('acme payments, 2019-2023')).toBe(true);
    expect(corpus.hasQuote('2023. Built the')).toBe(true); // spans a line break
    expect(corpus.hasQuote('Built the payments platform')).toBe(false);
  });

  it('accepts a quote shortened with an ellipsis when every fragment occurs', () => {
    expect(corpus.hasQuote('Built the ... in Go')).toBe(true);
    expect(corpus.hasQuote(`Built the${ELLIPSIS}cut p99 latency`)).toBe(true);
    expect(corpus.hasQuote('Built the ... in Rust')).toBe(false);
  });

  it('rejects trivially short quotes', () => {
    expect(corpus.hasQuote('in')).toBe(false);
    expect(corpus.hasQuote('...')).toBe(false);
  });

  it('matches skills as whole terms or in compact form', () => {
    expect(corpus.hasTerm('Go')).toBe(true);
    expect(corpus.hasTerm('NodeJS')).toBe(true);
    expect(corpus.hasTerm('node.js')).toBe(true);
    expect(corpus.hasTerm('Type Script')).toBe(true);
    expect(corpus.hasTerm('CICD')).toBe(true);
    expect(corpus.hasTerm('C++')).toBe(true);
    expect(corpus.hasTerm('Postgres')).toBe(true); // alias of PostgreSQL
    expect(corpus.hasTerm('Java')).toBe(false); // must not match inside "JavaScript"-like words
    expect(corpus.hasTerm('Kubernetes')).toBe(false);
  });

  it('does not ground short terms in hyphenated or ampersand words', () => {
    const goTo = new Corpus("I'm the go-to person for R&D and C-level reports");
    expect(goTo.hasTerm('Go')).toBe(false);
    expect(goTo.hasTerm('R')).toBe(false);
    expect(goTo.hasTerm('C')).toBe(false);
    expect(new Corpus('Kubernetes, Golang').hasTerm('K8s')).toBe(true);
    expect(new Corpus('Kubernetes, Golang').hasTerm('Go')).toBe(true);
  });

  it('matches quotes on word boundaries only, in order, and needs more than one short word', () => {
    const tickets = new Corpus('Handled support tickets for the billing team');
    expect(tickets.hasQuote('led')).toBe(false);
    expect(tickets.hasQuote('andled support')).toBe(false);
    expect(tickets.hasQuote('support tickets')).toBe(true);
    expect(tickets.hasQuote('billing team ... support tickets')).toBe(false);
    expect(tickets.hasQuote('Handled ... billing team')).toBe(true);
  });

  it('finds emails and links glued to labels, separators and icon glyphs', () => {
    const icon = String.fromCharCode(0xe001);
    const glued = new Corpus(`E-mail:jane@x.com|github.com/jane ${icon}joe@y.org`);
    expect(glued.hasEmail('jane@x.com')).toBe(true);
    expect(glued.hasEmail('joe@y.org')).toBe(true);
    expect(glued.hasUrl('https://github.com/jane')).toBe(true);
    expect(glued.hasUrl('github.com/ja')).toBe(false);
  });

  it('tolerates inflection outside English, and English plurals', () => {
    const ru = new Corpus('Работал старшим разработчиком в Яндексе, живу в Москве');
    expect(ru.hasWordLike('яндекс')).toBe(true);
    expect(ru.hasWordLike('москва')).toBe(true);
    expect(ru.hasWordLike('старший')).toBe(true);
    expect(ru.hasWordLike('мск')).toBe(false);
    const en = new Corpus('Built REST APIs');
    expect(en.hasWordLike('api')).toBe(true);
    expect(en.hasWordLike('apis')).toBe(true);
    expect(en.hasWordLike('ap')).toBe(false);
  });

  it('remembers text the user confirmed verbatim', () => {
    const withFacts = new Corpus(SOURCE, [], ['Cut cloud costs by 12%']);
    expect(withFacts.isConfirmed('  cut cloud costs by 12%. ')).toBe(true);
    expect(withFacts.isConfirmed('Cut cloud costs')).toBe(false);
    expect(withFacts.hasNumber('12')).toBe(true);
  });

  it('matches emails, phones and links exactly', () => {
    expect(corpus.hasEmail('Jane.Doe@Example.com')).toBe(true);
    expect(corpus.hasEmail('doe@example.com')).toBe(false);
    expect(corpus.hasPhone('+49 30 1234567')).toBe(true);
    expect(corpus.hasPhone('030 123 45 67')).toBe(true);
    expect(corpus.hasPhone('+49 30 7654321')).toBe(false);
    expect(corpus.hasPhone('12345')).toBe(false);
    expect(corpus.hasUrl('github.com/janedoe')).toBe(true);
    expect(corpus.hasUrl('https://github.com/jane')).toBe(false);
  });

  it('extends with answers, never with question text', () => {
    const withAnswer = new Corpus(SOURCE, ['I led a team of 5 engineers']);
    expect(withAnswer.hasNumber('5')).toBe(true);
    expect(withAnswer.hasQuote('led a team of 5 engineers')).toBe(true);
    expect(corpus.hasNumber('5')).toBe(false);
  });

  it('handles Cyrillic text', () => {
    const ru = new Corpus('Иван Петров\nСтарший разработчик в ООО «Ромашка», 2018–2022');
    expect(ru.hasQuote('старший разработчик в ООО "Ромашка"')).toBe(true);
    expect(ru.hasWord('ромашка')).toBe(true);
    expect(ru.hasNumber('2018')).toBe(true);
  });
});
