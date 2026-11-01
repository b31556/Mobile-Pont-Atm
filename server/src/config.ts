export const MIN_JWT_SECRET_LENGTH = 32;

/** Why a JWT secret is not acceptable, or null when it is fine. A short secret lets anyone who has seen one token work out the secret and forge admin tokens. */
export function jwtSecretProblem(secret: string | undefined): string | null {
  if (!secret) return 'JWT_SECRET is required';
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    return `JWT_SECRET is too short (${secret.length} characters, at least ${MIN_JWT_SECRET_LENGTH} needed). Make one with: openssl rand -hex 32. ` +
      'Changing it signs out every admin and every paired phone (readers re-register by themselves; phones need a new pairing code).';
  }
  return null;
}
