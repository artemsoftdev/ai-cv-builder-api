import {
  compact,
  normalizePhrase,
  normalizeText,
  normalizeUrl,
  stripEdgePunctuation,
  wordsOf,
} from './normalize.js';
import { extractNumbers } from './numbers.js';

/** Shorter quotes ("a", "in") would "prove" anything. */
const MIN_QUOTE_CHARS = 3;
/** Multi-word technical terms compared in compact form ("Type Script" vs "TypeScript"). */
const MAX_COMPACT_WINDOW = 3;
/** Shortest digit sequence accepted as a phone number. */
export const MIN_PHONE_DIGITS = 7;

// A run of digits with phone punctuation in between, e.g. "+49 (30) 123-45-67".
const PHONE_RUN_RE = /\+?\d[\d\s()./-]{5,}\d/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Digits of a phone number without trunk/international zeros: "+49 030 1234" -> "49301234". */
export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, '').replace(/^0+/, '');
}

/**
 * Everything a generated claim may be grounded in: the source text plus the user's answers.
 * The questions the model asked are deliberately NOT part of it: a question is not a fact.
 */
export class Corpus {
  readonly text: string;
  private readonly words: Set<string>;
  private readonly compactTerms = new Set<string>();
  /** Whole terms that look like URLs / emails, in comparable form. */
  private readonly urls = new Set<string>();
  private readonly emails = new Set<string>();
  private readonly numbers: Set<string>;
  private readonly phones: string[];

  constructor(sourceText: string, answers: readonly string[] = []) {
    this.text = normalizeText([sourceText, ...answers].join('\n'));
    this.words = new Set(wordsOf(this.text));
    this.numbers = new Set(extractNumbers(this.text).map((n) => n.canonical));
    this.phones = [...this.text.matchAll(PHONE_RUN_RE)]
      .map(([run]) => phoneDigits(run))
      .filter((digits) => digits.length >= MIN_PHONE_DIGITS);

    // Whitespace-separated terms, for exact (not substring) lookups: "jan@x.com" must not
    // match inside "jane@x.com", nor "github.com/jan" inside "github.com/jane".
    const terms = this.text.split(' ').map(stripEdgePunctuation).filter(Boolean);
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i]!;
      if (term.includes('@')) this.emails.add(term.replace(/^mailto:/, ''));
      if (term.includes('.')) this.urls.add(normalizeUrl(term));
      for (let size = 1; size <= MAX_COMPACT_WINDOW && i + size <= terms.length; size++) {
        this.compactTerms.add(compact(terms.slice(i, i + size).join(' ')));
      }
    }
  }

  /**
   * True if the quote occurs verbatim (after normalisation). A quote shortened with "..." is
   * accepted when every fragment occurs.
   */
  hasQuote(quote: string): boolean {
    const fragments = normalizeText(quote)
      .split('...')
      .map(stripEdgePunctuation)
      .filter((fragment) => fragment.length > 0);
    if (fragments.join('').length < MIN_QUOTE_CHARS) return false;
    return fragments.every((fragment) => this.text.includes(fragment));
  }

  hasNumber(canonical: string): boolean {
    return this.numbers.has(canonical);
  }

  /** `word` must be a lowercase letter/digit run (see wordsOf). */
  hasWord(word: string): boolean {
    return this.words.has(word);
  }

  /**
   * True if the term occurs as a whole phrase ("Go" in "Go and Rust", not in "Google"), or in
   * compact form as a term of the source ("NodeJS" vs "Node.js", "CI/CD" vs "CICD").
   */
  hasTerm(term: string): boolean {
    const phrase = normalizePhrase(term);
    if (!phrase) return false;
    const boundary = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`,
      'u',
    );
    return boundary.test(this.text) || this.compactTerms.has(compact(phrase));
  }

  hasEmail(email: string): boolean {
    return this.emails.has(normalizePhrase(email).replace(/^mailto:/, ''));
  }

  /** Same number if one digit string ends with the other (country code, trunk zero). */
  hasPhone(phone: string): boolean {
    const digits = phoneDigits(phone);
    if (digits.length < MIN_PHONE_DIGITS) return false;
    return this.phones.some((run) => run.endsWith(digits) || digits.endsWith(run));
  }

  hasUrl(url: string): boolean {
    return this.urls.has(normalizeUrl(url));
  }
}
