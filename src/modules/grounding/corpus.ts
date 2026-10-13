import {
  collapseAbbreviations,
  compact,
  normalizePhrase,
  normalizeText,
  normalizeUrl,
  sameWord,
  stripEdgePunctuation,
  wordsOf,
} from './normalize.js';
import { extractNumbers } from './numbers.js';

const MIN_QUOTE_CHARS = 12;
const MIN_QUOTE_WORDS = 2;
const MAX_FRAGMENT_GAP = 300;
const MAX_COMPACT_WINDOW = 3;
export const MIN_PHONE_DIGITS = 7;

const PHONE_RUN_RE = /\+?\d[\d\s()./-]{5,}\d/g;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const URL_RE =
  /(?:[a-z][a-z0-9+.-]*:\/\/)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?::\d+)?(?:[/?#][^\s|,;()<>"'[\]{}]*)?/gu;
// "The migration led to fewer outages" supports no leadership claim.
const LED_TO_RE = /(?<![\p{L}\p{N}])led to(?![\p{L}\p{N}])/gu;

const TERM_ALIASES: readonly (readonly string[])[] = [
  ['postgres', 'postgresql'],
  ['k8s', 'kubernetes'],
  ['js', 'javascript'],
  ['ts', 'typescript'],
  ['golang', 'go'],
  ['reactjs', 'react'],
  ['vuejs', 'vue'],
  ['mongo', 'mongodb'],
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function boundedRe(phrase: string, flags = 'u'): RegExp {
  // Short terms must not match "go-to" or "R&D".
  const tail = phrase.length <= 2 ? '(?![\\p{L}\\p{N}&-])' : '(?![\\p{L}\\p{N}])';
  const head = phrase.length <= 2 ? '(?<![\\p{L}\\p{N}&])' : '(?<![\\p{L}\\p{N}])';
  return new RegExp(`${head}${escapeRegExp(phrase)}${tail}`, flags);
}

export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, '').replace(/^0+/, '');
}

/** Source, answers and what the user typed or confirmed; never the model's questions. */
export class Corpus {
  readonly text: string;
  private readonly words: Set<string>;
  private readonly inflectedWords = new Map<string, string[]>();
  private readonly compactTerms = new Set<string>();
  private readonly urls = new Set<string>();
  private readonly emails = new Set<string>();
  private readonly numbers: Set<string>;
  private readonly phones: string[];
  private readonly confirmed: Set<string>;

  constructor(
    sourceText: string,
    answers: readonly string[] = [],
    confirmed: readonly string[] = [],
  ) {
    this.text = normalizeText([sourceText, ...answers, ...confirmed].join('\n'));
    this.confirmed = new Set(confirmed.map(normalizePhrase).filter(Boolean));
    const plain = this.text.replace(LED_TO_RE, ' to');
    this.words = new Set([...wordsOf(plain), ...wordsOf(collapseAbbreviations(plain))]);
    for (const word of this.words) {
      if (/^[a-z0-9]+$/.test(word) || word.length < 4) continue;
      const key = word.slice(0, 3);
      this.inflectedWords.set(key, [...(this.inflectedWords.get(key) ?? []), word]);
    }
    this.numbers = new Set(extractNumbers(this.text).map((n) => n.canonical));
    this.phones = [...this.text.matchAll(PHONE_RUN_RE)]
      .map(([run]) => phoneDigits(run))
      .filter((digits) => digits.length >= MIN_PHONE_DIGITS);
    for (const [email] of this.text.matchAll(EMAIL_RE)) this.emails.add(email);
    for (const [url] of this.text.matchAll(URL_RE)) this.urls.add(normalizeUrl(url));

    const terms = this.text.split(' ').map(stripEdgePunctuation).filter(Boolean);
    for (let i = 0; i < terms.length; i++) {
      for (let size = 1; size <= MAX_COMPACT_WINDOW && i + size <= terms.length; size++) {
        this.compactTerms.add(compact(terms.slice(i, i + size).join(' ')));
      }
    }
  }

  /** Word-bounded; "..." fragments must appear in order and close together. */
  hasQuote(quote: string): boolean {
    const fragments = normalizeText(quote)
      .split('...')
      .map(stripEdgePunctuation)
      .filter((fragment) => fragment.length > 0);
    const joined = fragments.join(' ');
    if (joined.length < MIN_QUOTE_CHARS && wordsOf(joined).length < MIN_QUOTE_WORDS) return false;
    const [first, ...rest] = fragments.map((fragment) => boundedRe(fragment, 'gu'));
    if (!first) return false;
    for (const match of this.text.matchAll(first)) {
      let end = match.index + match[0].length;
      const found = rest.every((re) => {
        re.lastIndex = end;
        const next = re.exec(this.text);
        if (!next || next.index - end > MAX_FRAGMENT_GAP) return false;
        end = next.index + next[0].length;
        return true;
      });
      if (found) return true;
    }
    return false;
  }

  isConfirmed(text: string): boolean {
    return this.confirmed.has(normalizePhrase(text));
  }

  hasNumber(canonical: string): boolean {
    return this.numbers.has(canonical);
  }

  hasWord(word: string): boolean {
    return this.words.has(word);
  }

  hasWordLike(word: string): boolean {
    if (this.words.has(word)) return true;
    if (/^[a-z0-9]+$/.test(word)) {
      const variants = [`${word}s`, `${word}es`];
      if (word.endsWith('s')) variants.push(word.slice(0, -1));
      if (word.endsWith('es')) variants.push(word.slice(0, -2));
      return variants.some((variant) => this.words.has(variant));
    }
    return (this.inflectedWords.get(word.slice(0, 3)) ?? []).some((other) => sameWord(word, other));
  }

  hasWordWithStem(stem: string): boolean {
    for (const word of this.words) if (word.startsWith(stem)) return true;
    return false;
  }

  /** Whole phrase, compact form ("NodeJS" for "Node.js") or a known alias. */
  hasTerm(term: string): boolean {
    const phrase = normalizePhrase(term);
    if (!phrase) return false;
    const aliases = TERM_ALIASES.find((group) => group.includes(compact(phrase))) ?? [];
    return [phrase, ...aliases].some(
      (candidate) =>
        boundedRe(candidate).test(this.text) || this.compactTerms.has(compact(candidate)),
    );
  }

  hasEmail(email: string): boolean {
    return this.emails.has(normalizePhrase(email).replace(/^mailto:/, ''));
  }

  /** One digit string may end with the other (country code, trunk zero). */
  hasPhone(phone: string): boolean {
    const digits = phoneDigits(phone);
    if (digits.length < MIN_PHONE_DIGITS) return false;
    return this.phones.some((run) => run.endsWith(digits) || digits.endsWith(run));
  }

  hasUrl(url: string): boolean {
    return this.urls.has(normalizeUrl(url));
  }
}
