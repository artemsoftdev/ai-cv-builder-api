import { z } from 'zod';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long')
  .pipe(z.email('Enter a valid email address'));

export const signupBodySchema = z.object({
  email,
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
});

// No signup length rule here: any mismatch is just "invalid credentials".
export const loginBodySchema = z.object({
  email,
  password: z.string().min(1, 'Password is required').max(128, 'Password is too long'),
});
