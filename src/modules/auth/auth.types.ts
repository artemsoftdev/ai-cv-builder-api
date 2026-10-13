export interface AuthUser {
  id: string;
  email: string;
  createdAt: Date;
}

export interface AuthContext {
  sessionId: string;
  user: AuthUser;
}

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
