export interface AuthUser {
  id: string;
  email: string;
  createdAt: Date;
}

/** Attached to authenticated requests by the requireAuth middleware. */
export interface AuthContext {
  sessionId: string;
  user: AuthUser;
}

/** Contract DTO (docs/API.md `User`). */
export interface UserDto {
  id: string;
  email: string;
  createdAt: string;
}

export function toUserDto(user: AuthUser): UserDto {
  return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
}

export function toAuthUser(user: AuthUser): AuthUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}
