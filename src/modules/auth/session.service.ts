import type { DataSource, EntityManager } from 'typeorm';
import { SessionEntity } from '../../db/entities/index.js';
import { toAuthUser, type AuthContext } from './auth.types.js';
import { generateSessionToken, hashSessionToken, SESSION_TTL_MS } from './session-token.js';

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

export class SessionService {
  constructor(private readonly dataSource: DataSource) {}

  /** Creates a session; pass `manager` to take part in a surrounding transaction. */
  async issue(
    userId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<IssuedSession> {
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await manager.insert(SessionEntity, { userId, tokenHash: hashSessionToken(token), expiresAt });
    return { token, expiresAt };
  }

  /** Resolves a cookie token to its user. Expired sessions are deleted on sight. */
  async authenticate(token: string): Promise<AuthContext | null> {
    const sessions = this.dataSource.getRepository(SessionEntity);
    const session = await sessions.findOne({
      where: { tokenHash: hashSessionToken(token) },
      relations: { user: true },
    });
    if (!session?.user) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      await sessions.delete({ id: session.id });
      return null;
    }
    return { sessionId: session.id, user: toAuthUser(session.user) };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.dataSource.getRepository(SessionEntity).delete({ id: sessionId });
  }

  async revokeToken(token: string): Promise<void> {
    await this.dataSource
      .getRepository(SessionEntity)
      .delete({ tokenHash: hashSessionToken(token) });
  }

  /** Housekeeping on login, so abandoned sessions do not pile up forever. */
  async deleteExpired(userId: string): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .delete()
      .from(SessionEntity)
      .where('user_id = :userId AND expires_at <= now()', { userId })
      .execute();
  }
}
