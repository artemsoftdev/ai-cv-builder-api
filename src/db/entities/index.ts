import { CvQuestionEntity } from './cv-question.entity.js';
import { CvEntity } from './cv.entity.js';
import { JobEntity } from './job.entity.js';
import { SessionEntity } from './session.entity.js';
import { UserEntity } from './user.entity.js';

export { CvEntity, CvQuestionEntity, JobEntity, SessionEntity, UserEntity };

export const ENTITIES = [UserEntity, SessionEntity, CvEntity, CvQuestionEntity, JobEntity];
