// They only copy text from the source or the answer, like a well-behaved model.
import type {
  DraftCv,
  DraftEducation,
  DraftExperience,
  DraftQuestion,
  DraftSkillGroup,
} from '../generation/llm-output.schemas.js';
import type { DraftCvInput, RewriteSectionInput, SectionRewrite } from './llm-client.js';

const EMAIL_RE = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i;
const PHONE_RE = /\+?\d[\d ().-]{6,}\d/;
const URL_SOURCE = String.raw`\b(?:https?://|www\.)[^\s<>()]+|\b(?:github|gitlab|linkedin)\.com/[^\s<>()]+`;
const URL_RE = new RegExp(URL_SOURCE, 'gi');
const HAS_URL_RE = new RegExp(URL_SOURCE, 'i');
const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;
const DATE_RANGE_RE = new RegExp(
  String.raw`((?:${MONTH} )?(?:19|20)\d{2})\s*(?:-|–|—|to)\s*((?:${MONTH} )?(?:19|20)\d{2}|present|now|current)`,
  'i',
);
const ROLE_AT_COMPANY_RE = /^(.{2,80}?)\s+(?:at|@)\s+(.{2,80}?)(?:\s*[,(|]\s*(.*?)\)?)?$/i;
// \b is ASCII-only in JS, so letter boundaries are spelled out for the Cyrillic words.
const EDUCATION_RE =
  /(?<!\p{L})(?:university|college|institute|school|academy|bsc|msc|bachelor|master|phd|университет|институт)(?!\p{L})/iu;
const SKILLS_RE = /^(?:skills|technologies|tech stack|stack|tools)\s*:\s*(.+)$/i;
const BULLET_PREFIX_RE = /^[-•*–]\s*/;
const NAME_RE = /^\p{Lu}[\p{L}'-]+(?: \p{Lu}[\p{L}'.-]*){1,3}$/u;

export const FAKE_TRANSCRIPTION = `Alex Example
alex@example.com
Backend developer with 6 years of experience building APIs in Node.js and PostgreSQL.
Backend Developer at Example Corp (2019 - Present)
- Built REST APIs in Node.js serving 2 million requests per day
- Migrated the billing database to PostgreSQL
Skills: Node.js, TypeScript, PostgreSQL, Docker`;

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function leadingQuote(text: string, count = 8): string {
  const match = new RegExp(`^\\s*(?:\\S+\\s+){0,${count - 1}}\\S+`).exec(text);
  return (match?.[0] ?? text).trim();
}

function relevance(item: DraftExperience, targetRole: string): number {
  const roleWords = new Set(words(targetRole).filter((w) => w.length >= 3));
  const itemWords = words([item.title, item.company, ...item.bullets.map((b) => b.text)].join(' '));
  const hits = itemWords.filter((w) => roleWords.has(w)).length;
  return Math.min(100, 30 + hits * 15);
}

function dates(line: string): { startDate: string; endDate: string; rest: string } {
  const match = DATE_RANGE_RE.exec(line);
  if (!match) return { startDate: '', endDate: '', rest: line };
  return {
    startDate: match[1] ?? '',
    endDate: match[2] ?? '',
    rest: line
      .replace(match[0], '')
      .replace(/[\s,(|)–-]+$/, '')
      .trim(),
  };
}

function emptyExperience(): DraftExperience {
  return {
    company: '',
    title: '',
    location: '',
    startDate: '',
    endDate: '',
    relevance: 0,
    bullets: [],
  };
}

export function heuristicDraft({ sourceText, targetRole }: DraftCvInput): DraftCv {
  const lines = sourceText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const email = EMAIL_RE.exec(sourceText)?.[0] ?? '';
  const phone = PHONE_RE.exec(sourceText)?.[0].trim() ?? '';
  const urls = [...new Set(sourceText.match(URL_RE) ?? [])].slice(0, 5);
  const fullName = lines[0] && NAME_RE.test(lines[0]) ? lines[0] : '';

  const experience: DraftExperience[] = [];
  const education: DraftEducation[] = [];
  const skills: DraftSkillGroup[] = [];
  const looseLines: string[] = [];

  for (const line of lines) {
    if (line === fullName || (email && line.includes(email)) || HAS_URL_RE.test(line)) continue;
    const skillsMatch = SKILLS_RE.exec(line);
    if (skillsMatch?.[1]) {
      const items = skillsMatch[1]
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
      skills.push({ name: 'Skills', items });
      continue;
    }
    const { startDate, endDate, rest } = dates(line);
    const role = ROLE_AT_COMPANY_RE.exec(rest);
    if (role?.[1] && role[2] && !BULLET_PREFIX_RE.test(line)) {
      experience.push({
        ...emptyExperience(),
        title: role[1].trim(),
        company: role[2].trim(),
        startDate,
        endDate,
      });
      continue;
    }
    if (EDUCATION_RE.test(line) && !BULLET_PREFIX_RE.test(line)) {
      education.push({
        institution: rest,
        degree: '',
        location: '',
        startDate,
        endDate,
        details: '',
      });
      continue;
    }
    const current = experience.at(-1);
    if (current && BULLET_PREFIX_RE.test(line)) {
      const text = line.replace(BULLET_PREFIX_RE, '');
      current.bullets.push({ text, evidence: [text] });
      continue;
    }
    looseLines.push(line.replace(BULLET_PREFIX_RE, ''));
  }

  const summaryLine = looseLines.find((line) => words(line).length >= 8) ?? '';
  if (experience.length === 0) {
    const bullets = looseLines
      .filter((line) => line !== summaryLine && words(line).length >= 5)
      .slice(0, 6)
      .map((text) => ({ text, evidence: [text] }));
    if (bullets.length > 0) experience.push({ ...emptyExperience(), bullets });
  }
  for (const item of experience) item.relevance = relevance(item, targetRole);

  return {
    contact: {
      fullName,
      headline: experience[0]?.title || targetRole,
      email,
      phone,
      location: '',
      links: urls.map((url) => ({ label: linkLabel(url), url })),
    },
    summary: { text: summaryLine, evidence: summaryLine ? [leadingQuote(summaryLine)] : [] },
    experience,
    education,
    skills,
    questions: heuristicQuestions({ email, experience, education, summaryLine }),
  };
}

function linkLabel(url: string): string {
  if (/github/i.test(url)) return 'GitHub';
  if (/linkedin/i.test(url)) return 'LinkedIn';
  if (/gitlab/i.test(url)) return 'GitLab';
  return 'Website';
}

function heuristicQuestions(found: {
  email: string;
  experience: DraftExperience[];
  education: DraftEducation[];
  summaryLine: string;
}): DraftQuestion[] {
  const questions: DraftQuestion[] = [];
  const undated = found.experience.findIndex((item) => !item.startDate);
  if (undated >= 0) {
    const company = found.experience[undated]?.company;
    questions.push({
      section: 'experience',
      itemIndex: undated,
      question: `When did you start and finish ${company ? `at ${company}` : 'this role'}?`,
    });
  }
  if (found.experience.length > 0) {
    questions.push({
      section: 'experience',
      itemIndex: 0,
      question: 'What measurable result are you most proud of in this role?',
    });
  }
  if (!found.email) {
    questions.push({
      section: 'contact',
      itemIndex: null,
      question: 'Which email address should recruiters use to contact you?',
    });
  }
  if (found.education.length === 0) {
    questions.push({
      section: 'education',
      itemIndex: null,
      question: 'What is your highest degree or qualification, and where did you get it?',
    });
  }
  if (!found.summaryLine) {
    questions.push({
      section: 'summary',
      itemIndex: null,
      question: 'How would you describe your professional focus in one or two sentences?',
    });
  }
  return questions.slice(0, 8);
}

export function heuristicRewrite(input: RewriteSectionInput): SectionRewrite {
  const answer = input.answer.trim();
  const quote = leadingQuote(answer);
  switch (input.section) {
    case 'contact': {
      const email = EMAIL_RE.exec(answer)?.[0];
      const phone = PHONE_RE.exec(answer)?.[0].trim();
      const urls = answer.match(URL_RE) ?? [];
      const { current } = input;
      return {
        section: 'contact',
        data: {
          ...current,
          email: email ?? current.email,
          phone: phone ?? current.phone,
          location: !email && !phone && urls.length === 0 ? answer.slice(0, 100) : current.location,
          links: [...current.links, ...urls.map((url) => ({ label: linkLabel(url), url }))],
        },
      };
    }
    case 'summary':
      return {
        section: 'summary',
        data: {
          headline: input.current.headline,
          summary: {
            text: [input.current.summary, answer].filter(Boolean).join(' '),
            evidence: [quote],
          },
        },
      };
    case 'experience': {
      const [item] = input.current.items;
      const fromAnswer = dates(answer);
      if (!item) {
        return {
          section: 'experience',
          data: { items: [{ ...emptyExperience(), title: quote, ...pickDates(fromAnswer) }] },
        };
      }
      const bullets = item.bullets.map((text) => ({ text, evidence: [text] }));
      if (!fromAnswer.startDate) bullets.push({ text: answer, evidence: [quote] });
      return {
        section: 'experience',
        data: {
          items: [
            {
              ...item,
              startDate: item.startDate || fromAnswer.startDate,
              endDate: item.endDate || fromAnswer.endDate,
              relevance: 50,
              bullets,
            },
          ],
        },
      };
    }
    case 'education': {
      const [item] = input.current.items;
      const fromAnswer = dates(answer);
      return {
        section: 'education',
        data: {
          items: [
            item
              ? { ...item, details: [item.details, answer].filter(Boolean).join('\n') }
              : {
                  institution: fromAnswer.rest.slice(0, 200),
                  degree: '',
                  location: '',
                  ...pickDates(fromAnswer),
                  details: '',
                },
          ],
        },
      };
    }
    case 'skills': {
      const added = answer
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        section: 'skills',
        data: { groups: [...input.current.groups, { name: 'Additional skills', items: added }] },
      };
    }
  }
}

function pickDates({ startDate, endDate }: { startDate: string; endDate: string }) {
  return { startDate, endDate };
}
