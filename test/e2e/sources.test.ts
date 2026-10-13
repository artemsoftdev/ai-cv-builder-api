import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { FAKE_TRANSCRIPTION } from '../../src/modules/llm/fake-heuristics.js';
import { makeFlateBombPdf, makePdf, makeScannedPdf } from '../fixtures/pdf-files.js';
import { signedInUser, type Browser } from '../helpers/app.js';
import { gate, isSettled, pollCv, useE2eStack } from '../helpers/e2e.js';

const stack = useE2eStack();

function upload(agent: Browser, pdf: Buffer, filename: string) {
  return agent
    .post('/api/cvs')
    .field('targetRole', 'Backend Engineer')
    .attach('file', pdf, { filename, contentType: 'application/pdf' });
}

describe('PDF sources', () => {
  it('turns a PDF with a Cyrillic text layer into a ready CV', async () => {
    const { agent } = await signedInUser(stack.app);
    const pdf = await makePdf(
      [
        [
          'Иван Петров',
          'ivan@example.com',
          'Бэкенд-разработчик с опытом создания платёжных систем на Go и PostgreSQL.',
          'Разработчик at ООО Ромашка (2018 - 2022)',
          '- Разработал сервис биллинга на Go',
          '- Перевёл отчёты компании с MySQL на PostgreSQL',
          'Skills: Go, PostgreSQL, Docker',
        ],
      ],
      { unicode: true },
    );
    const created = await upload(agent, pdf, 'Резюме.pdf');
    expect(created.status).toBe(202);
    expect(created.body.cv).toMatchObject({ sourceType: 'pdf', sourceFilename: 'Резюме.pdf' });

    const { cv } = await pollCv(agent, created.body.cv.id, isSettled);
    expect(cv.status).toBe('ready');
    expect(cv.content!.contact.fullName).toBe('Иван Петров');
    expect(cv.content!.experience[0]).toMatchObject({ company: 'ООО Ромашка', startDate: '2018' });
    expect(cv.review!.flags).toEqual([]);

    const source = await agent.get(`/api/cvs/${cv.id}/source`);
    expect(source.body.source).toMatchObject({ type: 'pdf', transcribed: false });
    expect(source.body.source.text).toContain('Разработал сервис биллинга на Go');
  });

  it('shows the extracting stage while Claude transcribes a scanned PDF', async () => {
    const { agent } = await signedInUser(stack.app);
    const transcription = gate();
    stack.llm.overrides.transcribePdf = async () => {
      await transcription.opened;
      return FAKE_TRANSCRIPTION;
    };
    const created = await upload(agent, await makeScannedPdf(), 'scan.pdf');
    expect(created.status).toBe(202);
    const id = created.body.cv.id as string;

    await pollCv(agent, id, (cv) => cv.stage === 'extracting');
    transcription.open();
    const { cv, stages } = await pollCv(agent, id, isSettled);
    expect(stages.at(-1)).toBe('done');
    expect(cv.status).toBe('ready');
    expect(cv.content!.contact.fullName).toBe('Alex Example');

    const source = await agent.get(`/api/cvs/${id}/source`);
    expect(source.body.source).toMatchObject({ type: 'pdf', transcribed: true });
    expect(source.body.source.text).toContain('Alex Example');
  });

  it('rejects a decompression bomb while the API keeps answering', async () => {
    const { agent } = await signedInUser(stack.app);
    const bomb = await makeFlateBombPdf(40);
    const uploading = upload(agent, bomb, 'bomb.pdf').then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const startedAt = Date.now();
    const health = await supertest(stack.app).get('/api/health');
    expect(health.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(500);

    const rejected = await uploading;
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('UNPROCESSABLE_SOURCE');
    expect((await agent.get('/api/cvs')).body.items).toEqual([]);
  });
});
