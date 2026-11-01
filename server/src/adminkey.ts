import type { Db } from './db.js';

export interface KeyOwner { id: string; name: string; role: string; active: number; token_version: number }

/** The staff member whose sign-in key has this UID (already in the canonical form), or undefined. */
export const findAdminByKey = (db: Db, uid: string) =>
  db.prepare('select id, name, role, active, token_version from staff where key_uid=?').get(uid) as KeyOwner | undefined;

/** What an admin's sign-in key looks like in a list: only the last byte, so the list does not give the key away. */
export const keyHint = (uid: string | null) => (uid ? '…' + uid.slice(-2) : null);

export const KEY_UID_TAKEN = 'That UID is an admin sign-in key, so it can’t be a card';
