import { describe, expect, it } from 'vitest';
import { canonicalNumber, extractNumbers, isPhoneRun } from './numbers.js';

const NBSP = String.fromCharCode(0xa0);

const canon = (text: string) => extractNumbers(text).map((n) => n.canonical);

describe('extractNumbers', () => {
  it('finds integers, decimals, years and percentages', () => {
    expect(canon('Cut p99 latency by 40% (3.5x) in 2021')).toEqual(['99', '40', '3.5', '2021']);
  });

  it('treats grouped thousands as one number, whatever the separator', () => {
    expect(canon('1,000 users')).toEqual(['1000']);
    expect(canon('1.000.000 requests')).toEqual(['1000000']);
    expect(canon('10 000 clients')).toEqual(['10000']);
    expect(canon(`10${NBSP}000 clients`)).toEqual(['10000']);
    expect(canon('$1,250.50 saved')).toEqual(['1250.5']);
  });

  it('keeps adjacent years apart', () => {
    expect(canon('2019 2021')).toEqual(['2019', '2021']);
    expect(canon('2019-2021')).toEqual(['2019', '2021']);
    expect(canon('2019, 2021')).toEqual(['2019', '2021']);
  });

  it('ignores units and leading zeros', () => {
    expect(canon('40 %')).toEqual(['40']);
    expect(canon('007')).toEqual(['7']);
  });

  it('reads numeric dates as their year only', () => {
    expect(canon('03.2019 - 05.2021')).toEqual(['2019', '2021']);
    expect(canon('15.03.2019')).toEqual(['2019']);
    expect(canon('10/2018')).toEqual(['2018']);
    expect(canon('2019-03-15 and 2019-2021')).toEqual(['2019', '2019', '2021']);
  });

  it('expands magnitude suffixes', () => {
    expect(canon('10k users')).toEqual(['10000']);
    expect(canon('$1.5m and 2 bn')).toEqual(['1500000', '2000000000']);
    expect(canon('1,2 млн рублей')).toEqual(['1200000']);
    expect(canon('200ms, 5mb')).toEqual(['200', '5']);
  });

  it('reads spelled-out numbers and multipliers', () => {
    expect(canon('eight years, a dozen teams, doubled revenue')).toEqual(['8', '12', '2']);
    expect(canon('пять лет')).toEqual(['5']);
    expect(canon('someone eighty-ish')).toEqual(['80']);
    expect(canon('weighty tenfold')).toEqual([]);
  });

  it('skips phone numbers, emails and links', () => {
    expect(canon('+49 30 1234567, jane42@x.com, github.com/jane/repo2 and 30 clients')).toEqual([
      '30',
    ]);
    expect(canon('(555) 010-0222 or 0171 2345678')).toEqual([]);
  });
});

describe('isPhoneRun', () => {
  it('tells phone numbers from year ranges and grouped amounts', () => {
    expect(isPhoneRun('+7 916 123 456')).toBe(true);
    expect(isPhoneRun('0171 2345678')).toBe(true);
    expect(isPhoneRun('2015 - 2019 2019 - 2021')).toBe(false);
    expect(isPhoneRun('15.03.2019 - 20.05.2021')).toBe(false);
    expect(isPhoneRun('8 (916) 123-45-67')).toBe(true);
    expect(isPhoneRun('1.000.000.000')).toBe(false);
    expect(isPhoneRun('555-0100')).toBe(false);
  });
});

describe('canonicalNumber', () => {
  it('reads a single comma or point as a decimal separator', () => {
    expect(canonicalNumber('3,5')).toBe('3.5');
    expect(canonicalNumber('3.50')).toBe('3.5');
    expect(canonicalNumber('12.0')).toBe('12');
  });
});
