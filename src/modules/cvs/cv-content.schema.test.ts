import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { sampleContent } from '../../../test/fixtures/cv-content.js';
import { CV_CONTENT_LIMITS, cvContentSchema, type CvContent } from './cv-content.schema.js';

const BELL = String.fromCharCode(0x07);
const RLO = String.fromCharCode(0x202e);

function issuePaths(result: z.ZodSafeParseResult<CvContent>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

function withContent(mutate: (content: CvContent) => void): unknown {
  const content = sampleContent();
  mutate(content);
  return content;
}

describe('cvContentSchema', () => {
  it('accepts a valid CV unchanged', () => {
    const content = sampleContent();
    expect(cvContentSchema.parse(content)).toEqual(content);
  });

  it('trims strings and strips control characters', () => {
    const parsed = cvContentSchema.parse(
      withContent((c) => {
        c.contact.fullName = `  Jane${BELL} Doe  `;
        c.experience[0]!.company = `Acme${RLO} Payments`;
        c.experience[0]!.bullets[0]!.text = 'Built the billing\nservice in Go.';
        c.summary = '  First line.\r\nSecond line.  ';
      }),
    );
    expect(parsed.contact.fullName).toBe('Jane Doe');
    expect(parsed.experience[0]!.company).toBe('Acme Payments');
    // Line breaks are only kept in summary and education details.
    expect(parsed.experience[0]!.bullets[0]!.text).toBe('Built the billing service in Go.');
    expect(parsed.summary).toBe('First line.\nSecond line.');
  });

  it('enforces string length limits after trimming', () => {
    const ok = withContent((c) => {
      c.contact.fullName = ` ${'a'.repeat(CV_CONTENT_LIMITS.text)} `;
      c.summary = 's'.repeat(CV_CONTENT_LIMITS.summary);
      c.experience[0]!.bullets[0]!.text = 'b'.repeat(CV_CONTENT_LIMITS.bullet);
      c.education[0]!.details = 'd'.repeat(CV_CONTENT_LIMITS.educationDetails);
    });
    expect(cvContentSchema.safeParse(ok).success).toBe(true);

    const tooLong = withContent((c) => {
      c.contact.fullName = 'a'.repeat(CV_CONTENT_LIMITS.text + 1);
      c.summary = 's'.repeat(CV_CONTENT_LIMITS.summary + 1);
      c.experience[0]!.bullets[0]!.text = 'b'.repeat(CV_CONTENT_LIMITS.bullet + 1);
      c.education[0]!.details = 'd'.repeat(CV_CONTENT_LIMITS.educationDetails + 1);
    });
    expect(issuePaths(cvContentSchema.safeParse(tooLong))).toEqual([
      'contact.fullName',
      'summary',
      'experience.0.bullets.0.text',
      'education.0.details',
    ]);
  });

  it('enforces collection size limits', () => {
    const result = cvContentSchema.safeParse(
      withContent((c) => {
        const item = c.experience[0]!;
        c.experience = Array.from({ length: CV_CONTENT_LIMITS.experienceItems + 1 }, (_, i) => ({
          ...item,
          id: `exp-${i}`,
          bullets: [],
        }));
        c.contact.links = Array.from({ length: CV_CONTENT_LIMITS.links + 1 }, (_, i) => ({
          id: `link-${i}`,
          label: 'Site',
          url: 'https://example.com',
        }));
        c.skills[0]!.items = Array.from({ length: CV_CONTENT_LIMITS.skillsPerGroup + 1 }, String);
      }),
    );
    expect(issuePaths(result)).toEqual(['contact.links', 'experience', 'skills.0.items']);
  });

  it('limits bullets per experience item', () => {
    const result = cvContentSchema.safeParse(
      withContent((c) => {
        c.experience[0]!.bullets = Array.from(
          { length: CV_CONTENT_LIMITS.bulletsPerItem + 1 },
          (_, i) => ({ id: `bullet-${i}`, text: 'Did things.' }),
        );
      }),
    );
    expect(issuePaths(result)).toEqual(['experience.0.bullets']);
  });

  it('rejects duplicate ids and reserved flag targets', () => {
    const result = cvContentSchema.safeParse(
      withContent((c) => {
        c.experience[0]!.bullets[1]!.id = 'b-1';
        c.education[0]!.id = 'summary';
      }),
    );
    expect(issuePaths(result)).toEqual(['experience.0.bullets.1.id', 'education.0.id']);
  });

  it('rejects ids with unexpected characters', () => {
    const result = cvContentSchema.safeParse(
      withContent((c) => {
        c.experience[0]!.id = '<script>';
      }),
    );
    expect(issuePaths(result)).toEqual(['experience.0.id']);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
  ])('rejects dangerous link scheme %s', (url) => {
    const result = cvContentSchema.safeParse(
      withContent((c) => {
        c.contact.links[0]!.url = url;
      }),
    );
    expect(issuePaths(result)).toEqual(['contact.links.0.url']);
  });

  it.each([
    'https://github.com/jane',
    'http://jane.dev',
    'mailto:jane@example.com',
    'github.com/jane',
    '',
  ])('accepts link %j', (url) => {
    const result = cvContentSchema.safeParse(
      withContent((c) => {
        c.contact.links[0]!.url = url;
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects missing and mistyped fields', () => {
    const content = sampleContent() as unknown as Record<string, unknown>;
    delete content.summary;
    content.skills = 'Go, TypeScript';
    expect(issuePaths(cvContentSchema.safeParse(content))).toEqual(['summary', 'skills']);
  });
});
