import { describe, expect, it } from 'vitest';
import { sampleContent } from '../../../test/fixtures/cv-content.js';
import { inspectPdf } from '../../../test/helpers/pdf-inspect.js';
import type { CvContent } from '../cvs/cv-content.schema.js';
import { renderCvPdf } from './render-cv-pdf.js';

const A4 = { width: 595.28, height: 841.89 };

function longCyrillicCv(): CvContent {
  const content = sampleContent();
  content.contact.fullName = 'Иван Петров';
  content.contact.headline = 'Ведущий бэкенд-разработчик';
  content.contact.location = 'Москва, Россия';
  content.summary = 'Бэкенд-разработчик с опытом построения платёжных систем на Go и PostgreSQL.';
  content.experience = Array.from({ length: 5 }, (_, i) => ({
    id: `exp-${i}`,
    company: `ООО «Ромашка ${i}»`,
    title: 'Разработчик',
    location: 'Москва',
    startDate: `${2015 + i}`,
    endDate: `${2016 + i}`,
    bullets: Array.from({ length: 6 }, (_, j) => ({
      id: `b-${i}-${j}`,
      text: `Пункт ${i}.${j}: разработал и сопровождал сервис расчётов, писал тесты, проводил ревью кода и помогал коллегам с архитектурой.`,
    })),
  }));
  return content;
}

// CPU-bound, and runs alongside the other test files.
describe('renderCvPdf', { timeout: 30_000 }, () => {
  it('renders A4 pages with extractable Latin and Cyrillic text', async () => {
    const content = longCyrillicCv();
    const pdf = await renderCvPdf(content, { title: 'Резюме Ивана' });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const doc = await inspectPdf(pdf);
    expect(doc.pageSizes.length).toBeGreaterThanOrEqual(2);
    for (const size of doc.pageSizes) {
      expect(size.width).toBeCloseTo(A4.width, 1);
      expect(size.height).toBeCloseTo(A4.height, 1);
    }
    expect(doc.title).toBe('Резюме Ивана');

    const [firstPage] = doc.pageTexts;
    expect(firstPage).toContain('Иван Петров');
    expect(firstPage).toContain('Ведущий бэкенд-разработчик');
    expect(firstPage).toContain('jane@example.com');
    expect(firstPage).toContain('Разработчик — ООО «Ромашка 0» 2015 – 2016');
    expect(firstPage).toContain(content.experience[0]!.bullets[0]!.text);
    expect(doc.pageTexts.at(-1)).toContain(content.skills[0]!.items.join(', '));
    expect(doc.text).toContain(content.experience[4]!.bullets[5]!.text);
  });

  it('prints sections in order and omits empty ones, empty entries and empty bullets', async () => {
    const content = sampleContent();
    content.summary = '';
    content.education = [
      {
        id: 'edu-empty',
        institution: '',
        degree: '',
        location: '',
        startDate: '',
        endDate: '',
        details: '',
      },
    ];
    content.experience[0]!.bullets.push({ id: 'b-empty', text: '' });
    content.skills = [{ id: 'skills-empty', name: 'Tools', items: [] }];

    const doc = await inspectPdf(await renderCvPdf(content, { title: 'CV' }));
    expect(doc.text).not.toMatch(/SUMMARY|EDUCATION|SKILLS|Tools/);
    expect(doc.text).toContain(
      'EXPERIENCE Backend Engineer — Acme Payments Mar 2021 – Present Berlin ' +
        '• Built the billing service in Go. • Cut p99 latency by 40%.',
    );
    expect(doc.text.match(/•/g)).toHaveLength(2);
  });

  it('links contact details with safe targets only', async () => {
    const content = sampleContent();
    content.contact.links = [
      { id: 'l-1', label: 'GitHub', url: 'https://github.com/janedoe' },
      { id: 'l-2', label: 'Blog', url: 'jane.dev/blog' },
      { id: 'l-3', label: 'Handle', url: 'not a url' },
    ];

    const doc = await inspectPdf(await renderCvPdf(content, { title: 'CV' }));
    expect(doc.text).toContain(
      'jane@example.com · +49 30 1234567 · Berlin, Germany · github.com/janedoe · jane.dev/blog · not a url',
    );
    expect(doc.links.sort()).toEqual([
      'https://github.com/janedoe',
      'https://jane.dev/blog',
      'mailto:jane@example.com',
    ]);
  });

  it('shares no font state between documents', async () => {
    // Regression: a shared font instance broke "M" in documents rendered after a Cyrillic one.
    const cyrillic = sampleContent();
    cyrillic.contact.location = 'Москва, Россия';
    cyrillic.experience[0]!.company = 'ООО «Ромашка»';
    await renderCvPdf(cyrillic, { title: 'CV' });

    const doc = await inspectPdf(await renderCvPdf(sampleContent(), { title: 'CV' }));
    expect(doc.text).toContain('Backend Engineer — Acme Payments Mar 2021 – Present');
  });

  it('renders documents of many pages', async () => {
    // react-pdf's page-number `render` prop crashed at about ten pages.
    const content = sampleContent();
    content.experience = Array.from({ length: 12 }, (_, i) => ({
      ...content.experience[0]!,
      id: `exp-${i}`,
      bullets: Array.from({ length: 15 }, (_, j) => ({
        id: `b-${i}-${j}`,
        text: `Entry ${i}, item ${j}: ${'operated and improved the payment platform '.repeat(8).trim()}.`,
      })),
    }));

    const doc = await inspectPdf(await renderCvPdf(content, { title: 'CV' }));
    expect(doc.pageSizes.length).toBeGreaterThanOrEqual(10);
    expect(doc.text).toContain('Entry 11, item 14:');
  });
});
