import type { CvContent } from '../../src/modules/cvs/cv-content.schema.js';
import type { CvReview } from '../../src/modules/cvs/cv.types.js';

/** A small but complete, valid CV. Returns a fresh object on every call. */
export function sampleContent(): CvContent {
  return {
    contact: {
      fullName: 'Jane Doe',
      headline: 'Senior Backend Engineer',
      email: 'jane@example.com',
      phone: '+49 30 1234567',
      location: 'Berlin, Germany',
      links: [{ id: 'link-1', label: 'GitHub', url: 'https://github.com/janedoe' }],
    },
    summary: 'Backend engineer with 8 years of experience.\nFocused on payments and reliability.',
    experience: [
      {
        id: 'exp-1',
        company: 'Acme Payments',
        title: 'Backend Engineer',
        location: 'Berlin',
        startDate: 'Mar 2021',
        endDate: 'Present',
        bullets: [
          { id: 'b-1', text: 'Built the billing service in Go.' },
          { id: 'b-2', text: 'Cut p99 latency by 40%.' },
        ],
      },
    ],
    education: [
      {
        id: 'edu-1',
        institution: 'TU Berlin',
        degree: 'BSc Computer Science',
        location: 'Berlin',
        startDate: '2012',
        endDate: '2016',
        details: '',
      },
    ],
    skills: [{ id: 'skills-1', name: 'Languages', items: ['Go', 'TypeScript'] }],
  };
}

/** Review with one flag per kind of target, matching sampleContent(). */
export function sampleReview(): CvReview {
  return {
    flags: [
      { id: 'flag-bullet', itemId: 'b-2', reason: 'Number "40%" does not appear in your source' },
      { id: 'flag-exp', itemId: 'exp-1', reason: 'Company name not found in your source' },
      { id: 'flag-summary', itemId: 'summary', reason: 'Claim not supported by your source' },
    ],
    removed: [{ field: 'contact.phone', value: '+1 555 0100', reason: 'Not in your source' }],
    evidence: { 'b-1': ['built the billing service'] },
  };
}
