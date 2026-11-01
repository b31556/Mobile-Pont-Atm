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

/**
 * What to trust as a reverse proxy, from the TRUST_PROXY setting. Only the addresses named here may tell the server
 * a client's address and whether the request was https (X-Forwarded-For / X-Forwarded-Proto); anyone else's are ignored.
 *  - unset, "0" or "false": no proxy is trusted
 *  - "1", "true" or "loopback": a proxy on this same machine (127.0.0.1 / ::1)
 *  - anything else: a comma-separated list of proxy addresses or ranges, like "203.0.113.7" or "10.0.0.0/8"
 */
export function parseTrustProxy(value: string | undefined): false | string | string[] {
  const v = (value ?? '').trim();
  if (!v || v === '0' || v.toLowerCase() === 'false') return false;
  if (v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'loopback') return 'loopback';
  const list = v.split(',').map(x => x.trim()).filter(Boolean);
  return list.length === 1 ? list[0] : list;
}
