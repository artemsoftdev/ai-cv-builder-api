import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'users' })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Always stored trimmed + lowercased (enforced by a CHECK constraint). */
  @Column({ type: 'text', unique: true })
  email!: string;

  /** "scrypt$N$r$p$salt$hash", see modules/auth/password.ts */
  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
