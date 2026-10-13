import type { DataSource } from 'typeorm';
import { UserEntity } from '../../db/entities/index.js';
import { isUniqueViolation } from '../../db/errors.js';
import { AppError } from '../../http/errors.js';
import { toAuthUser, type AuthUser } from './auth.types.js';
import { hashPassword, verifyAgainstDummyHash, verifyPassword } from './password.js';
import type { IssuedSession, SessionService } from './session.service.js';

export interface Credentials {
  email: string;
  password: string;
}

export interface AuthResult {
  user: AuthUser;
  session: IssuedSession;
}

const invalidCredentials = () =>
  new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect');

export class AuthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly sessions: SessionService,
  ) {}

  async signup({ email, password }: Credentials): Promise<AuthResult> {
    const passwordHash = await hashPassword(password);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const user = await manager.save(manager.create(UserEntity, { email, passwordHash }));
        const session = await this.sessions.issue(user.id, manager);
        return { user: toAuthUser(user), session };
      });
    } catch (err) {
      // The unique constraint, not a pre-check, keeps concurrent signups race-free.
      if (isUniqueViolation(err, 'users_email_key')) {
        throw new AppError('EMAIL_TAKEN', 'An account with this email already exists');
      }
      throw err;
    }
  }

  async login({ email, password }: Credentials): Promise<AuthResult> {
    const user = await this.dataSource.getRepository(UserEntity).findOneBy({ email });
    if (!user) {
      await verifyAgainstDummyHash(password);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(password, user.passwordHash))) throw invalidCredentials();

    await this.sessions.deleteExpired(user.id);
    const session = await this.sessions.issue(user.id);
    return { user: toAuthUser(user), session };
  }
}
