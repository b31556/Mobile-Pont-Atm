import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { jwtSecretProblem, MIN_JWT_SECRET_LENGTH } from '../src/config.js';

describe('JWT secret strength', () => {
  it('refuses a missing or empty secret', () => {
    expect(jwtSecretProblem(undefined)).toMatch(/required/);
    expect(jwtSecretProblem('')).toMatch(/required/);
  });

  it('refuses a secret shorter than 32 characters and says how to make a good one', () => {
    const msg = jwtSecretProblem('x'.repeat(MIN_JWT_SECRET_LENGTH - 1));
    expect(msg).toMatch(/too short/);
    expect(msg).toMatch(/openssl rand -hex 32/);
    expect(msg).not.toContain('xxxx');   // never echoes the secret
  });

  it('accepts 32 characters or more', () => {
    expect(jwtSecretProblem('x'.repeat(32))).toBeNull();
    expect(jwtSecretProblem('a1b2'.repeat(16))).toBeNull();
  });

  it('the server process exits with an error on a short secret and does not print it', () => {
    const r = spawnSync('npx', ['tsx', 'src/index.ts'], { env: { ...process.env, JWT_SECRET: 'short-secret-value', DB_PATH: ':memory:', PORT: '0' }, encoding: 'utf8', timeout: 30000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/too short/);
    expect(r.stderr + r.stdout).not.toContain('short-secret-value');
  });
});
