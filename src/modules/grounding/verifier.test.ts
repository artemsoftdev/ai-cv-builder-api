import { describe, expect, it } from 'vitest';
import type { CvContent, ExperienceItem } from '../cvs/cv-content.schema.js';
import type { CvReview } from '../cvs/cv.types.js';
import { Corpus } from './corpus.js';
import {
  REASONS,
  replaceReviewPart,
  verifyContact,
  verifyContent,
  verifyEducationItem,
  verifyExperienceItem,
  verifySkills,
  verifySummary,
} from './verifier.js';

const SOURCE = `Jane Doe
jane@example.com | +49 30 1234567 | github.com/janedoe | Berlin
Backend engineer with 8 years of experience in payments.

Software Engineer at Acme Payments (2019 - Present)
- Built the billing service in Go and Node.js
- Reduced p99 latency from 200ms to 120ms

TU Berlin, BSc Computer Science, 2012 - 2016
Skills: Go, NodeJS, PostgreSQL, Kafka`;

const corpus = new Corpus(SOURCE);

function experience(overrides: Partial<ExperienceItem> = {}): ExperienceItem {
  return {
    id: 'exp-1',
    company: 'Acme Payments',
    title: 'Software Engineer',
    location: '',
    startDate: '2019',
    endDate: 'Present',
    bullets: [
      { id: 'b-1', text: 'Built the billing service in Go and Node.js' },
      { id: 'b-2', text: 'Reduced p99 latency from 200ms to 120ms' },
    ],
    ...overrides,
  };
}

function content(overrides: Partial<CvContent> = {}): CvContent {
  return {
    contact: {
      fullName: 'Jane Doe',
      headline: 'Backend Engineer',
      email: 'jane@example.com',
      phone: '+49 30 1234567',
      location: 'Berlin',
      links: [{ id: 'l-1', label: 'GitHub', url: 'https://github.com/janedoe' }],
    },
    summary: 'Backend engineer with 8 years of experience in payments.',
    experience: [experience()],
    education: [
      {
        id: 'edu-1',
        institution: 'TU Berlin',
        degree: 'BSc Computer Science',
        location: '',
        startDate: '2012',
        endDate: '2016',
        details: '',
      },
    ],
    skills: [{ id: 's-1', name: 'Languages', items: ['Go', 'Node.js', 'PostgreSQL'] }],
    ...overrides,
  };
}

const goodEvidence = {
  summary: ['Backend engineer with 8 years'],
  'b-1': ['Built the billing service in Go'],
  'b-2': ['Reduced p99 latency from 200ms to 120ms'],
};

const reasonsFor = (review: CvReview, itemId: string) =>
  review.flags.filter((f) => f.itemId === itemId).map((f) => f.reason);

describe('verifyContent', () => {
  it('accepts a fully grounded CV and keeps the verified quotes as evidence', () => {
    const result = verifyContent(content(), goodEvidence, corpus);
    expect(result.review.flags).toEqual([]);
    expect(result.review.removed).toEqual([]);
    expect(result.review.evidence).toEqual(goodEvidence);
    expect(result.content).toEqual(content());
  });

  it('gives every flag a unique, id-safe id', () => {
    const result = verifyContent(content({ summary: 'Invented 99 claims.' }), {}, corpus);
    const ids = result.review.flags.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe('evidence quotes', () => {
  it('flags a bullet without a verifiable quote and drops unverified quotes', () => {
    const review = verifyExperienceItem(
      experience(),
      {
        'b-1': ['Designed the billing platform'], // not in the source
        'b-2': ['Reduced p99 latency', 'improved everything'],
      },
      corpus,
    );
    expect(reasonsFor(review, 'b-1')).toEqual([REASONS.noEvidence]);
    expect(reasonsFor(review, 'b-2')).toEqual([]);
    expect(review.evidence).toEqual({ 'b-2': ['Reduced p99 latency'] });
  });

  it('accepts quotes shortened with an ellipsis', () => {
    const review = verifyExperienceItem(
      experience(),
      { ...goodEvidence, 'b-1': ['Built the billing service ... Node.js'] },
      corpus,
    );
    expect(review.flags).toEqual([]);
  });

  it('flags a summary without evidence', () => {
    const review = verifySummary(content(), {}, corpus);
    expect(reasonsFor(review, 'summary')).toEqual([REASONS.noEvidence]);
  });
});

describe('numbers', () => {
  it('flags an invented metric with the specific number', () => {
    const item = experience({
      bullets: [{ id: 'b-1', text: 'Cut p99 latency by 40% for 1,000 merchants' }],
    });
    const review = verifyExperienceItem(item, { 'b-1': ['Reduced p99 latency'] }, corpus);
    expect(reasonsFor(review, 'b-1')).toEqual([REASONS.number('40'), REASONS.number('1,000')]);
  });

  it('accepts numbers that only differ in formatting', () => {
    const answers = ['We served 1 000 merchants with 40 % less latency'];
    const review = verifyExperienceItem(
      experience({ bullets: [{ id: 'b-1', text: 'Served 1,000 merchants; 40% lower latency' }] }),
      { 'b-1': ['served 1 000 merchants'] },
      new Corpus(SOURCE, answers),
    );
    expect(review.flags).toEqual([]);
  });

  it('flags invented numbers in the summary, headline and dates', () => {
    const review = verifySummary(
      {
        summary: 'Backend engineer with 10 years of experience.',
        contact: { headline: 'Top 1% Backend Engineer' },
      },
      { summary: ['Backend engineer with'] },
      corpus,
    );
    expect(reasonsFor(review, 'summary')).toEqual([REASONS.number('10')]);
    expect(reasonsFor(review, 'headline')).toEqual([
      REASONS.number('1'),
      REASONS.entity('Headline', 'Top 1% Backend Engineer'),
    ]);

    const item = verifyExperienceItem(experience({ startDate: 'Mar 2018' }), goodEvidence, corpus);
    expect(reasonsFor(item, 'exp-1')).toEqual([REASONS.number('2018')]);
  });
});

describe('ownership claims', () => {
  it('flags an ownership verb the source does not support', () => {
    const item = experience({
      bullets: [{ id: 'b-1', text: 'Led the billing service rewrite in Go' }],
    });
    const review = verifyExperienceItem(item, { 'b-1': ['Built the billing service'] }, corpus);
    expect(reasonsFor(review, 'b-1')).toEqual([REASONS.ownership('led')]);

    const summary = verifySummary(
      { summary: 'Backend engineer who managed payments.', contact: { headline: '' } },
      { summary: ['Backend engineer with 8 years'] },
      corpus,
    );
    expect(reasonsFor(summary, 'summary')).toEqual([REASONS.ownership('managed')]);
  });

  it('accepts it when the source or an answer uses the same word family', () => {
    const item = experience({ bullets: [{ id: 'b-1', text: 'Led the billing service team' }] });
    const evidence = { 'b-1': ['Built the billing service'] };
    expect(
      verifyExperienceItem(
        item,
        evidence,
        new Corpus(`${SOURCE}
Team lead`),
      ).flags,
    ).toEqual([]);
    const answered = new Corpus(SOURCE, ['I led the billing team']);
    expect(verifyExperienceItem(item, evidence, answered).flags).toEqual([]);
  });

  it('does not treat nouns like "lead" as claims', () => {
    const item = experience({
      bullets: [{ id: 'b-1', text: 'Built the billing service lead form' }],
    });
    expect(
      verifyExperienceItem(item, { 'b-1': ['Built the billing service'] }, corpus).flags,
    ).toEqual([]);
  });
});

describe('entries', () => {
  it('flags a company or title that is not in the source', () => {
    const review = verifyExperienceItem(
      experience({ company: 'Globex Corporation', title: 'Software Engineer' }),
      goodEvidence,
      corpus,
    );
    expect(reasonsFor(review, 'exp-1')).toEqual([REASONS.entity('Company', 'Globex Corporation')]);
  });

  it('tolerates small wording changes but not an invented seniority', () => {
    const tolerated = verifyExperienceItem(
      experience({ company: 'Acme Payments GmbH' }),
      goodEvidence,
      corpus,
    );
    expect(tolerated.flags).toEqual([]);

    const inflated = verifyExperienceItem(
      experience({ title: 'Senior Software Engineer' }),
      goodEvidence,
      corpus,
    );
    expect(reasonsFor(inflated, 'exp-1')).toEqual([REASONS.seniority('senior')]);
  });

  it('checks education institution, degree and years', () => {
    const review = verifyEducationItem(
      {
        id: 'edu-1',
        institution: 'Harvard University',
        degree: 'BSc Computer Science',
        location: '',
        startDate: '2012',
        endDate: '2017',
        details: '',
      },
      corpus,
    );
    expect(reasonsFor(review, 'edu-1')).toEqual([
      REASONS.entity('Institution', 'Harvard University'),
      REASONS.number('2017'),
    ]);
  });
});

describe('contact', () => {
  it('removes an email, phone and link that are not in the source', () => {
    const result = verifyContact(
      {
        ...content().contact,
        email: 'jane.doe@gmail.com',
        phone: '+1 555 0100 222',
        links: [
          { id: 'l-1', label: 'GitHub', url: 'https://github.com/janedoe' },
          { id: 'l-2', label: 'LinkedIn', url: 'https://linkedin.com/in/janedoe' },
        ],
      },
      corpus,
    );
    expect(result.contact.email).toBe('');
    expect(result.contact.phone).toBe('');
    expect(result.contact.links.map((l) => l.id)).toEqual(['l-1']);
    expect(result.review.removed).toEqual([
      { field: 'contact.email', value: 'jane.doe@gmail.com', reason: REASONS.email },
      { field: 'contact.phone', value: '+1 555 0100 222', reason: REASONS.phone },
      { field: 'contact.links', value: 'https://linkedin.com/in/janedoe', reason: REASONS.link },
    ]);
  });

  it('matches email case-insensitively and phones by digits', () => {
    const result = verifyContact(
      { ...content().contact, email: 'JANE@EXAMPLE.COM', phone: '0049 (30) 123-45-67' },
      corpus,
    );
    expect(result.review.removed).toEqual([]);
  });

  it('removes a name or location that the source does not contain', () => {
    const result = verifyContact(
      { ...content().contact, fullName: 'Janet Doe', location: 'Munich, Germany' },
      corpus,
    );
    expect(result.contact.fullName).toBe('');
    expect(result.contact.location).toBe('');
    expect(result.review.removed.map((r) => r.field)).toEqual([
      'contact.fullName',
      'contact.location',
    ]);
  });
});

describe('skills', () => {
  it('removes invented skills, keeps spelling variants, drops emptied groups', () => {
    const result = verifySkills(
      [
        { id: 's-1', name: 'Languages', items: ['Go', 'Node.js', 'Rust'] },
        { id: 's-2', name: 'Infrastructure', items: ['Kubernetes'] },
        { id: 's-3', name: 'Data', items: ['Postgresql', 'Kafka'] },
      ],
      corpus,
    );
    expect(result.skills).toEqual([
      { id: 's-1', name: 'Languages', items: ['Go', 'Node.js'] },
      { id: 's-3', name: 'Data', items: ['Postgresql', 'Kafka'] },
    ]);
    expect(result.review.removed).toEqual([
      { field: 'skills', value: 'Rust', reason: REASONS.skill },
      { field: 'skills', value: 'Kubernetes', reason: REASONS.skill },
    ]);
  });
});

describe('corpus boundaries', () => {
  it('lets answers support new facts', () => {
    const answers = ['I led a team of 5 engineers and used Kubernetes'];
    const withAnswers = new Corpus(SOURCE, answers);
    const item = experience({
      bullets: [{ id: 'b-9', text: 'Led a team of 5 engineers' }],
    });
    expect(verifyExperienceItem(item, { 'b-9': ['led a team of 5'] }, withAnswers).flags).toEqual(
      [],
    );
    expect(
      verifySkills([{ id: 's', name: 'x', items: ['Kubernetes'] }], withAnswers).skills,
    ).toHaveLength(1);
  });

  it('does not treat question text as a source of facts', () => {
    // Only answers extend the corpus; a question that suggests a number proves nothing.
    const question = 'Did you lead a team of 5 engineers?';
    const answers = ['Yes'];
    const item = experience({ bullets: [{ id: 'b-9', text: 'Led a team of 5 engineers' }] });
    const review = verifyExperienceItem(item, { 'b-9': [question] }, new Corpus(SOURCE, answers));
    expect(reasonsFor(review, 'b-9')).toEqual([
      REASONS.noEvidence,
      REASONS.number('5'),
      REASONS.ownership('led'),
    ]);
  });

  it('works for Cyrillic sources', () => {
    const ru = new Corpus(
      'Иван Петров\nРазработчик в ООО «Ромашка», 2018–2022\n- Разработал платёжный сервис на Go',
    );
    const item: ExperienceItem = {
      id: 'exp-ru',
      company: 'ООО «Ромашка»',
      title: 'Ведущий разработчик',
      location: '',
      startDate: '2018',
      endDate: '2023',
      bullets: [{ id: 'b-ru', text: 'Разработал платёжный сервис на Go для 300 клиентов' }],
    };
    const review = verifyExperienceItem(item, { 'b-ru': ['Разработал платёжный сервис'] }, ru);
    expect(reasonsFor(review, 'exp-ru')).toEqual([
      REASONS.entity('Job title', 'Ведущий разработчик'),
      REASONS.number('2023'),
    ]);
    expect(reasonsFor(review, 'b-ru')).toEqual([REASONS.number('300')]);
  });
});

describe('replaceReviewPart', () => {
  it('replaces only the flags, removed claims and evidence of the given part', () => {
    const review: CvReview = {
      flags: [
        { id: 'f-1', itemId: 'b-1', reason: 'old' },
        { id: 'f-2', itemId: 'summary', reason: 'keep' },
      ],
      removed: [
        { field: 'skills', value: 'Rust', reason: 'x' },
        { field: 'contact.email', value: 'a@b.c', reason: 'keep' },
      ],
      evidence: { 'b-1': ['old quote'], summary: ['keep'] },
    };
    const updated = replaceReviewPart(
      review,
      { targetIds: new Set(['exp-1', 'b-1', 'b-2']), removedFields: ['skills'] },
      {
        flags: [{ id: 'f-3', itemId: 'b-2', reason: 'new' }],
        removed: [],
        evidence: { 'b-1': ['new quote'] },
      },
    );
    expect(updated).toEqual({
      flags: [
        { id: 'f-2', itemId: 'summary', reason: 'keep' },
        { id: 'f-3', itemId: 'b-2', reason: 'new' },
      ],
      removed: [{ field: 'contact.email', value: 'a@b.c', reason: 'keep' }],
      evidence: { summary: ['keep'], 'b-1': ['new quote'] },
    });
  });
});

describe('named terms in prose', () => {
  const java = new Corpus('Software engineer at Acme. Worked on the billing service in Java.');

  it('flags technologies, employers and acronyms the source never mentions', () => {
    const item = experience({
      company: 'Acme',
      title: 'Software engineer',
      startDate: '',
      endDate: '',
      bullets: [
        {
          id: 'b-1',
          text: 'Built billing microservices in Java, Kubernetes and Kafka on AWS for Google',
        },
      ],
    });
    const review = verifyExperienceItem(item, { 'b-1': ['billing service'] }, java);
    expect(reasonsFor(review, 'b-1')).toEqual([
      REASONS.terms(['Kubernetes', 'Kafka', 'AWS', 'Google']),
    ]);
  });

  it('catches lowercase mentions of skills the model listed', () => {
    const item = experience({
      company: 'Acme',
      title: 'Software engineer',
      startDate: '',
      endDate: '',
      bullets: [{ id: 'b-1', text: 'Moved the billing service to kubernetes, e.g. for go-live.' }],
    });
    const review = verifyExperienceItem(item, { 'b-1': ['billing service'] }, java, [
      'Java',
      'Kubernetes',
      'Go',
    ]);
    expect(reasonsFor(review, 'b-1')).toEqual([REASONS.terms(['Kubernetes'])]);
  });

  it('accepts plurals, aliases, inflected names and sentence-initial words', () => {
    const corpus = new Corpus('Работал в Яндексе. Built REST API and PostgreSQL schemas.');
    const item = experience({
      company: 'Яндекс',
      title: '',
      startDate: '',
      endDate: '',
      bullets: [{ id: 'b-1', text: 'Designed REST APIs on Postgres for Яндекс' }],
    });
    const review = verifyExperienceItem(item, { 'b-1': ['Built REST API'] }, corpus);
    expect(review.flags).toEqual([]);
  });
});

describe('evidence relevance', () => {
  const corpus = new Corpus('Handled support tickets. Worked on the tracing service.');

  it('rejects a quote that exists but says nothing about the claim', () => {
    const item = experience({
      company: '',
      title: '',
      startDate: '',
      endDate: '',
      bullets: [{ id: 'b-1', text: 'Designed the distributed tracing platform' }],
    });
    for (const quote of ['led', 'Handled support tickets']) {
      expect(reasonsFor(verifyExperienceItem(item, { 'b-1': [quote] }, corpus), 'b-1')).toEqual([
        REASONS.noEvidence,
      ]);
    }
    expect(
      verifyExperienceItem(item, { 'b-1': ['the tracing service'] }, corpus).evidence['b-1'],
    ).toEqual(['the tracing service']);
  });
});

describe('education', () => {
  const corpus = new Corpus('Bachelor of Science in Computer Science, TU Berlin, 2015');
  const education = (degree: string, details = '') => ({
    id: 'edu-1',
    institution: 'TU Berlin',
    degree,
    location: '',
    startDate: '',
    endDate: '2015',
    details,
  });

  it('flags an upgraded degree level even when most words match', () => {
    const review = verifyEducationItem(education('Master of Science in Computer Science'), corpus);
    expect(reasonsFor(review, 'edu-1')).toEqual([REASONS.degreeLevel('master')]);
    expect(verifyEducationItem(education('B.Sc. Computer Science'), corpus).flags).toEqual([]);
  });

  it('flags invented honours in the details', () => {
    const review = verifyEducationItem(
      education('Bachelor of Science', "Graduated summa cum laude, Dean's list"),
      corpus,
    );
    expect(reasonsFor(review, 'edu-1')).toEqual([
      REASONS.entity('Details', "Graduated summa cum laude, Dean's list"),
      REASONS.terms(['Dean']),
    ]);
  });
});

describe('headline', () => {
  it('flags a headline the source does not back', () => {
    const corpus = new Corpus('Junior QA tester at Acme');
    const review = verifySummary(
      { summary: '', contact: { headline: 'Senior Product Manager' } },
      {},
      corpus,
    );
    expect(reasonsFor(review, 'headline')).toEqual([
      REASONS.entity('Headline', 'Senior Product Manager'),
    ]);
    expect(
      reasonsFor(
        verifySummary({ summary: '', contact: { headline: 'Senior QA Tester' } }, {}, corpus),
        'headline',
      ),
    ).toEqual([REASONS.seniority('senior')]);
  });
});

describe('numbers in context', () => {
  const bullet = (text: string) =>
    experience({ title: '', startDate: '', endDate: '', bullets: [{ id: 'b-1', text }] });

  it('does not let phone numbers or month numbers ground metrics', () => {
    const corpus = new Corpus('Jane, +49 30 1234567. Engineer at Acme Payments since 10/2018.');
    const metric = verifyExperienceItem(
      bullet('Improved checkout conversion by 30% for a team of 10'),
      { 'b-1': ['Engineer at Acme Payments'] },
      corpus,
    );
    expect(reasonsFor(metric, 'b-1')).toEqual([
      REASONS.noEvidence,
      REASONS.number('30'),
      REASONS.number('10'),
    ]);
  });

  it('checks spelled-out numbers both ways and reads European dates', () => {
    const corpus = new Corpus('Team lead at Acme Payments, 03.2019 - 05.2021. Mentored 3 juniors.');
    const review = verifyExperienceItem(
      experience({
        title: 'Team lead',
        startDate: 'March 2019',
        endDate: 'May 2021',
        bullets: [{ id: 'b-1', text: 'Mentored three juniors and twelve interns' }],
      }),
      { 'b-1': ['Mentored 3 juniors'] },
      corpus,
    );
    expect(reasonsFor(review, 'exp-1')).toEqual([]);
    expect(reasonsFor(review, 'b-1')).toEqual([REASONS.number('twelve')]);
  });

  it('treats magnitude suffixes as the same amount', () => {
    const corpus = new Corpus('Served 10,000 users and saved $1,500,000 at Acme Payments.');
    const review = verifyExperienceItem(
      bullet('Served 10K users and saved $1.5M'),
      { 'b-1': ['Served 10,000 users'] },
      corpus,
    );
    expect(review.flags).toEqual([]);
  });
});

describe('inflected languages', () => {
  it('matches companies, titles and locations in another grammatical case', () => {
    const corpus = new Corpus(
      'Иван Петров, живу в Москве. Работал старшим разработчиком в Яндексе. Работал руководителем группы.',
    );
    const review = verifyExperienceItem(
      {
        id: 'exp-ru',
        company: 'Яндекс',
        title: 'Старший разработчик',
        location: 'Москва',
        startDate: '',
        endDate: '',
        bullets: [{ id: 'b-ru', text: 'Руководил группой разработки' }],
      },
      { 'b-ru': ['Работал руководителем группы'] },
      corpus,
    );
    expect(review.flags).toEqual([]);
    const contact = verifyContact(
      {
        ...content().contact,
        fullName: 'Иван Петров',
        location: 'Москва',
        email: '',
        phone: '',
        links: [],
      },
      corpus,
    );
    expect(contact.review.removed).toEqual([]);
  });

  it('still flags a perfective claim the source does not support', () => {
    const corpus = new Corpus('Участвовал в проекте миграции');
    const review = verifySummary(
      { summary: 'Возглавил проект миграции', contact: { headline: '' } },
      { summary: ['проекте миграции'] },
      corpus,
    );
    expect(reasonsFor(review, 'summary')).toEqual([REASONS.ownership('возглавил')]);
  });
});

describe('ownership verbs', () => {
  it('flags owned and drove, and ignores "led to" as support', () => {
    const corpus = new Corpus('Worked on the billing rewrite. The migration led to fewer outages.');
    const review = verifyExperienceItem(
      experience({
        startDate: '',
        endDate: '',
        bullets: [
          { id: 'b-1', text: 'Owned and drove the billing rewrite' },
          { id: 'b-2', text: 'Led the migration' },
          { id: 'b-3', text: 'The billing rewrite led to fewer outages' },
        ],
      }),
      {
        'b-1': ['the billing rewrite'],
        'b-2': ['The migration led to'],
        'b-3': ['led to fewer outages'],
      },
      corpus,
    );
    expect(reasonsFor(review, 'b-1')).toEqual([
      REASONS.ownership('owned'),
      REASONS.ownership('drove'),
    ]);
    expect(reasonsFor(review, 'b-2')).toEqual([REASONS.ownership('led')]);
    expect(reasonsFor(review, 'b-3')).toEqual([]);
  });
});

describe('text the user confirmed', () => {
  it('keeps edited contact data and skills and does not re-flag confirmed text', () => {
    const corpus = new Corpus(
      SOURCE,
      [],
      ['jane.new@mail.com', 'Docker', 'Cut cloud costs by 12% with Terraform'],
    );
    const contact = verifyContact({ ...content().contact, email: 'jane.new@mail.com' }, corpus);
    expect(contact.contact.email).toBe('jane.new@mail.com');
    expect(
      verifySkills([{ id: 's', name: 'Tools', items: ['Docker'] }], corpus).skills,
    ).toHaveLength(1);
    const review = verifyExperienceItem(
      experience({ bullets: [{ id: 'b-1', text: 'Cut cloud costs by 12% with Terraform' }] }),
      {},
      corpus,
    );
    expect(review.flags).toEqual([]);
  });
});
