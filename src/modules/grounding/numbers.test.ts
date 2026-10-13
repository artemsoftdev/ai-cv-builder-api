import { describe, expect, it } from 'vitest';
import { canonicalNumber, extractNumbers } from './numbers.js';

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
    expect(canon('03/2021')).toEqual(['3', '2021']);
  });
});

describe('canonicalNumber', () => {
  it('reads a single comma or point as a decimal separator', () => {
    expect(canonicalNumber('3,5')).toBe('3.5');
    expect(canonicalNumber('3.50')).toBe('3.5');
    expect(canonicalNumber('12.0')).toBe('12');
  });
});
