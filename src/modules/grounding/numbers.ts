// Numbers in normalised text, canonicalised so "1,000" == "1 000" == "1k", "40 %" == "40",
// "eight" == "8". Units are ignored: the check is "this number appears in the source".

const SPACE_SEPARATOR = '[ \\u00A0\\u202F]';
const NUMBER = `\\d{1,3}(?:(?:[.,]|${SPACE_SEPARATOR})\\d{3})+(?!\\d)(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?`;
const YEAR = '(?:19|20)\\d{2}';
const DAY = '(?:0?[1-9]|[12]\\d|3[01])';
const MONTH = '(?:0?[1-9]|1[0-2])';
// 15.03.2019, 03.2019, 3/2019 and 2019-03(-15): only the year is a fact worth checking.
const DATE = [
  `(?<![\\d.,/])(?:${DAY}[./])?${MONTH}[./](?<dmy>${YEAR})(?![\\d.,/]?\\d)`,
  `(?<![\\d.,/-])(?<iso>${YEAR})-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\\d|3[01]))?(?![\\d-])`,
].join('|');
const MAGNITUDE = `(?:(?<suffix>[kmb])|\\s?(?<scale>thousand|million|billion|mln|mn|bn|тыс|млн|млрд))(?![\\p{L}\\p{N}])`;

const SCALES: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  тыс: 1e3,
  m: 1e6,
  million: 1e6,
  mln: 1e6,
  mn: 1e6,
  млн: 1e6,
  b: 1e9,
  billion: 1e9,
  bn: 1e9,
  млрд: 1e9,
};

const NUMBER_WORDS: Record<string, string> = {
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
  hundred: '100',
  dozen: '12',
  twice: '2',
  double: '2',
  doubled: '2',
  triple: '3',
  tripled: '3',
  quadrupled: '4',
  два: '2',
  две: '2',
  три: '3',
  четыре: '4',
  пять: '5',
  шесть: '6',
  семь: '7',
  восемь: '8',
  девять: '9',
  десять: '10',
  дважды: '2',
  вдвое: '2',
  втрое: '3',
};

const WORD = `(?<![\\p{L}\\p{N}])(?<word>${Object.keys(NUMBER_WORDS).join('|')})(?![\\p{L}\\p{N}])`;
const TOKEN_RE = new RegExp(`${DATE}|(?<number>${NUMBER})(?:${MAGNITUDE})?|${WORD}`, 'gu');

// Contact data is not a metric: a phone's area code must not ground "30%".
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const URL_RE = /(?:https?:\/\/|www\.)\S+|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+\/\S*/gu;
const PHONE_RUN_RE = /\+?\d[\d\s()./-]{5,}\d/g;

const SPACE_SEPARATOR_RE = new RegExp(SPACE_SEPARATOR, 'g');
const GROUPED_RE = /^\d{1,3}(?:[.,]\d{3})+$/;
const GROUPED_WITH_DECIMALS_RE = /^(\d{1,3}(?:[.,]\d{3})+)[.,](\d+)$/;

export interface NumberToken {
  /** As written, for messages. */
  raw: string;
  canonical: string;
}

export function canonicalNumber(raw: string): string {
  const token = raw.replace(SPACE_SEPARATOR_RE, '');
  let integer: string;
  let fraction = '';
  const withDecimals = GROUPED_WITH_DECIMALS_RE.exec(token);
  if (GROUPED_RE.test(token)) {
    integer = token.replace(/[.,]/g, '');
  } else if (withDecimals) {
    integer = withDecimals[1]!.replace(/[.,]/g, '');
    fraction = withDecimals[2]!;
  } else {
    const [int = '', frac = ''] = token.split(/[.,]/);
    integer = int;
    fraction = frac;
  }
  integer = integer.replace(/^0+(?=\d)/, '');
  fraction = fraction.replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

function scaled(canonical: string, factor: number): string {
  const value = Math.round(Number(canonical) * factor * 1e6) / 1e6;
  return Number.isSafeInteger(Math.round(value)) ? String(value) : canonical;
}

/** A phone number, not a range of years or a grouped amount. */
export function isPhoneRun(run: string): boolean {
  const groups = run.split(/\D+/).filter(Boolean);
  const digits = groups.join('').length;
  const dateParts = groups.every((group) => group.length <= 2 || /^(?:19|20)\d{2}$/.test(group));
  if (digits < 7 || dateParts) return false;
  if (run.startsWith('+') || run.includes('(')) return true;
  const thousandsGrouped = groups.length > 1 && groups.slice(1).every((g) => g.length === 3);
  return digits >= 10 && !thousandsGrouped;
}

function withoutContactData(text: string): string {
  return text
    .replace(EMAIL_RE, ' ')
    .replace(URL_RE, ' ')
    .replace(PHONE_RUN_RE, (run) => (isPhoneRun(run) ? ' ' : run));
}

export function extractNumbers(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  for (const match of withoutContactData(text).matchAll(TOKEN_RE)) {
    const groups = match.groups ?? {};
    const year = groups.dmy ?? groups.iso;
    if (year) {
      tokens.push({ raw: year, canonical: year });
    } else if (groups.number) {
      const canonical = canonicalNumber(groups.number);
      const scale = SCALES[groups.suffix ?? groups.scale ?? ''];
      tokens.push({
        raw: scale ? match[0].trim() : groups.number,
        canonical: scale ? scaled(canonical, scale) : canonical,
      });
    } else if (groups.word) {
      tokens.push({ raw: groups.word, canonical: NUMBER_WORDS[groups.word]! });
    }
  }
  return tokens;
}
