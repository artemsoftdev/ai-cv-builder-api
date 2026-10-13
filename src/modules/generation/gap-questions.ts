import type { CvContent, ExperienceItem } from '../cvs/cv-content.schema.js';
import type { QuestionSection } from '../cvs/cv.types.js';
import { MAX_QUESTIONS, type NewQuestion } from './draft-sanitizer.js';

type Lang = 'en' | 'ru';

const TEMPLATES: Record<
  Lang,
  {
    email: string;
    phoneOrLink: string;
    dates: (entry: string) => string;
    bullets: (entry: string) => string;
    experience: string;
    education: string;
    skills: string;
  }
> = {
  en: {
    email: 'What email address should employers use to contact you?',
    phoneOrLink:
      'Would you like to add a phone number or a profile link (LinkedIn, GitHub, portfolio)?',
    dates: (entry) => `When did you start and finish at ${entry}? Month and year are enough.`,
    bullets: (entry) => `What were your main responsibilities and results at ${entry}?`,
    experience: 'Which jobs, internships, freelance work or projects should this CV include?',
    education: 'Do you have any education, courses or certifications you would like to list?',
    skills: 'Which skills, tools and technologies do you use in your work?',
  },
  ru: {
    email: 'Какой email указать для связи с работодателями?',
    phoneOrLink: 'Хотите добавить телефон или ссылку на профиль (LinkedIn, GitHub, портфолио)?',
    dates: (entry) => `Когда вы начали и закончили работу в ${entry}? Достаточно месяца и года.`,
    bullets: (entry) => `Какие у вас были основные обязанности и результаты в ${entry}?`,
    experience: 'Какой опыт работы, стажировки, фриланс или проекты стоит включить в резюме?',
    education: 'Есть ли у вас образование, курсы или сертификаты, которые стоит указать?',
    skills: 'Какие навыки, инструменты и технологии вы используете в работе?',
  },
};

function detectLang(sourceText: string): Lang {
  const letters = sourceText.match(/\p{L}/gu)?.length ?? 0;
  const cyrillic = sourceText.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  return letters > 0 && cyrillic / letters > 0.3 ? 'ru' : 'en';
}

const entryName = (item: ExperienceItem) => item.company || item.title;

/**
 * Deterministic safety net: the model sometimes returns no questions at all, so structural gaps
 * it did not ask about become questions here. Model questions come first.
 */
export function withGapQuestions(
  content: CvContent,
  modelQuestions: readonly NewQuestion[],
  sourceText: string,
): NewQuestion[] {
  const t = TEMPLATES[detectLang(sourceText)];
  const covered = (section: QuestionSection, itemId: string | null = null) =>
    modelQuestions.some((q) => q.section === section && q.itemId === itemId);
  const gaps: NewQuestion[] = [];
  const add = (section: QuestionSection, itemId: string | null, question: string) => {
    if (!covered(section, itemId)) gaps.push({ section, itemId, question });
  };

  const { contact } = content;
  if (!contact.email) add('contact', null, t.email);
  else if (!contact.phone && contact.links.length === 0) add('contact', null, t.phoneOrLink);

  if (content.experience.length === 0) add('experience', null, t.experience);
  for (const item of content.experience) {
    const name = entryName(item);
    if (!name) continue;
    if (item.bullets.length === 0) add('experience', item.id, t.bullets(name));
    else if (!item.startDate || !item.endDate) add('experience', item.id, t.dates(name));
  }

  if (content.education.length === 0) add('education', null, t.education);
  if (content.skills.length === 0) add('skills', null, t.skills);

  return [...modelQuestions, ...gaps].slice(0, MAX_QUESTIONS);
}
