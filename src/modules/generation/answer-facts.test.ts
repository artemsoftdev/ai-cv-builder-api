import { describe, expect, it } from 'vitest';
import { answerFacts } from './answer-facts.js';

const QUESTION = 'Did you lead the team of 5 engineers?';

describe('answerFacts', () => {
  it.each(['Yes', 'yes!', 'Yes, correct', 'Да', 'да, верно', 'Exactly'])(
    'treats %j as confirming the question',
    (answer) => {
      expect(answerFacts(QUESTION, answer)).toEqual([answer, QUESTION]);
    },
  );

  it.each(['No', 'Yes, but not as the lead', 'Not really', 'Нет', 'Yes. I led 3 of them in 2021'])(
    'keeps %j to itself',
    (answer) => {
      expect(answerFacts(QUESTION, answer)).toEqual([answer]);
    },
  );
});
