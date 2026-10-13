/*
 * Number tokens in free text: integers, decimals, years, percentages and amounts. Formatting
 * is canonicalised so "1,000" == "1000" == "1 000", "40 %" == "40%" == "40", "03" == "3".
 * The unit (%, $, k...) is ignored: the check is "this number appears in the source".
 */

// Space-like thousands separators: space, no-break space, narrow no-break space.
const SPACE_SEPARATOR = '[ \\u00A0\\u202F]';
// Grouped thousands ("1,000", "1.000.000", "10 000", optionally with decimals) or a plain
// number ("2019", "3.5", "3,5"). (?!\d) keeps "2019 2021" from being read as one number.
const NUMBER_RE = new RegExp(
  `\\d{1,3}(?:(?:[.,]|${SPACE_SEPARATOR})\\d{3})+(?!\\d)(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?`,
  'g',
);
const SPACE_SEPARATOR_RE = new RegExp(SPACE_SEPARATOR, 'g');
const GROUPED_RE = /^\d{1,3}(?:[.,]\d{3})+$/;
const GROUPED_WITH_DECIMALS_RE = /^(\d{1,3}(?:[.,]\d{3})+)[.,](\d+)$/;

export interface NumberToken {
  /** As written, for messages ("40%" is reported as "40"). */
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
    // At most one separator left: a decimal point or decimal comma ("3.5", "3,5").
    const [int = '', frac = ''] = token.split(/[.,]/);
    integer = int;
    fraction = frac;
  }
  integer = integer.replace(/^0+(?=\d)/, '');
  fraction = fraction.replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

export function extractNumbers(text: string): NumberToken[] {
  return [...text.matchAll(NUMBER_RE)].map(([raw]) => ({ raw, canonical: canonicalNumber(raw) }));
}
