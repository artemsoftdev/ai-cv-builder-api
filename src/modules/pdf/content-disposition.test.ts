import { describe, expect, it } from 'vitest';
import { attachmentDisposition, cvFileBaseName } from './content-disposition.js';

const RLO = String.fromCharCode(0x202e);
const NEWLINE = String.fromCharCode(10);

describe('cvFileBaseName', () => {
  it('combines the name and the title', () => {
    expect(cvFileBaseName('Jane Doe', 'Senior Backend Engineer')).toBe(
      'Jane Doe - Senior Backend Engineer',
    );
    expect(cvFileBaseName('', 'Backend CV')).toBe('Backend CV');
    expect(cvFileBaseName('Jane', 'Jane')).toBe('Jane');
    expect(cvFileBaseName(' ', '')).toBe('CV');
  });

  it('removes characters that are unsafe in file names or headers', () => {
    expect(cvFileBaseName('Jane "JD" Doe', 'C:\\cv/../x?*')).toBe('Jane JD Doe - C cv .. x');
    expect(cvFileBaseName(`Ja${RLO}ne${NEWLINE}Doe`, '')).toBe('Jane Doe');
    expect(cvFileBaseName('...', '.hidden')).toBe('hidden');
    expect(Array.from(cvFileBaseName('Ж'.repeat(300), ''))).toHaveLength(100);
  });
});

describe('attachmentDisposition', () => {
  it('gives an ASCII fallback and the exact UTF-8 name', () => {
    expect(attachmentDisposition('Jane Doe - Backend', 'pdf')).toBe(
      `attachment; filename="Jane Doe - Backend.pdf"; filename*=UTF-8''Jane%20Doe%20-%20Backend.pdf`,
    );
    expect(attachmentDisposition("Résumé Иван's (2)", 'pdf')).toBe(
      `attachment; filename="Resume 's (2).pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%D0%98%D0%B2%D0%B0%D0%BD%27s%20%282%29.pdf`,
    );
    expect(attachmentDisposition('Иван Петров', 'pdf')).toMatch(
      /^attachment; filename="CV\.pdf"; /,
    );
  });
});
