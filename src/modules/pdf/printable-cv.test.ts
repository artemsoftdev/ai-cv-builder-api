import { describe, expect, it } from 'vitest';
import { sampleContent } from '../../../test/fixtures/cv-content.js';
import { dateRange, linkHref, linkText, toPrintableCv } from './printable-cv.js';

describe('linkHref', () => {
  it('keeps http(s) and mailto links as they are', () => {
    expect(linkHref('https://github.com/jane')).toBe('https://github.com/jane');
    expect(linkHref('HTTP://example.com')).toBe('HTTP://example.com');
    expect(linkHref('mailto:jane@example.com')).toBe('mailto:jane@example.com');
  });

  it('links bare domains and e-mail addresses', () => {
    expect(linkHref('github.com/jane')).toBe('https://github.com/jane');
    expect(linkHref('www.jane.dev')).toBe('https://www.jane.dev');
    expect(linkHref('jane@example.com')).toBe('mailto:jane@example.com');
  });

  it('does not link anything else', () => {
    expect(linkHref('javascript:alert(1)')).toBeNull();
    expect(linkHref('data:text/html,hi')).toBeNull();
    expect(linkHref('ftp://example.com')).toBeNull();
    expect(linkHref('@janedoe')).toBeNull();
    expect(linkHref('v1.2')).toBeNull();
    expect(linkHref('my site')).toBeNull();
  });
});

describe('linkText', () => {
  it('prints the address without the protocol, or the label when there is no address', () => {
    expect(linkText({ label: 'GitHub', url: 'https://github.com/jane/' })).toBe('github.com/jane');
    expect(linkText({ label: 'Mail', url: 'mailto:jane@example.com' })).toBe('jane@example.com');
    expect(linkText({ label: 'Portfolio', url: '' })).toBe('Portfolio');
  });
});

describe('dateRange', () => {
  it('joins the dates that are present', () => {
    expect(dateRange('Mar 2021', 'Present')).toBe('Mar 2021 – Present');
    expect(dateRange('', '2019')).toBe('2019');
    expect(dateRange(' ', '')).toBe('');
  });
});

describe('toPrintableCv', () => {
  it('maps every section of a complete CV', () => {
    expect(toPrintableCv(sampleContent())).toEqual({
      name: 'Jane Doe',
      headline: 'Senior Backend Engineer',
      contact: [
        { text: 'jane@example.com', href: 'mailto:jane@example.com' },
        { text: '+49 30 1234567', href: null },
        { text: 'Berlin, Germany', href: null },
        { text: 'github.com/janedoe', href: 'https://github.com/janedoe' },
      ],
      summary: 'Backend engineer with 8 years of experience.\nFocused on payments and reliability.',
      experience: [
        {
          id: 'exp-1',
          title: 'Backend Engineer',
          subtitle: 'Acme Payments',
          dates: 'Mar 2021 – Present',
          location: 'Berlin',
          details: '',
          bullets: [
            { id: 'b-1', text: 'Built the billing service in Go.' },
            { id: 'b-2', text: 'Cut p99 latency by 40%.' },
          ],
        },
      ],
      education: [
        {
          id: 'edu-1',
          title: 'BSc Computer Science',
          subtitle: 'TU Berlin',
          dates: '2012 – 2016',
          location: 'Berlin',
          details: '',
          bullets: [],
        },
      ],
      skills: [{ id: 'skills-1', name: 'Languages', items: 'Go, TypeScript' }],
    });
  });

  it('drops empty values, bullets, entries, skill groups and links', () => {
    const content = sampleContent();
    content.contact = {
      fullName: '',
      headline: '',
      email: 'not-an-email',
      phone: '',
      location: '',
      links: [{ id: 'l-1', label: '', url: '' }],
    };
    content.experience[0]!.bullets = [{ id: 'b-1', text: '' }];
    content.experience.push({
      id: 'exp-empty',
      company: '',
      title: '',
      location: '',
      startDate: '',
      endDate: '',
      bullets: [{ id: 'b-x', text: '' }],
    });
    content.education = [];
    content.skills = [{ id: 's-1', name: 'Tools', items: ['', ''] }];

    const cv = toPrintableCv(content);
    expect(cv.contact).toEqual([{ text: 'not-an-email', href: null }]);
    expect(cv.experience.map((entry) => entry.id)).toEqual(['exp-1']);
    expect(cv.experience[0]!.bullets).toEqual([]);
    expect(cv.education).toEqual([]);
    expect(cv.skills).toEqual([]);
  });
});
