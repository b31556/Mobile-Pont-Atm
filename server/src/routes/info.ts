import type { FastifyInstance } from 'fastify';
import { cardHistory } from '../cardinfo.js';
import { normalizeUid } from '../uid.js';
import { findCardByUid } from './cards.js';
import { publishTap } from './display.js';
import { recordSuggestion } from './suggestions.js';

const HISTORY_LINES = 10;

/**
 * Info kiosk mode: a tap on a reader or a phone in this mode changes nothing. It shows the holder's points and recent history
 * (a phone on its screen, a reader on its digit display, and on its display page if one is open).
 */
export function registerInfo(app: FastifyInstance) {
  const db = app.db;

  app.post('/info/tap', { preHandler: app.requireOperator }, async (req, reply) => {
    const terminalId = req.user.terminalId!;
    const term = db.prepare('select mode from terminals where id=?').get(terminalId) as { mode: string } | undefined;
    if (term?.mode !== 'info') return reply.code(409).send({ error: 'This terminal is not an info kiosk.', code: 'wrong_mode' });

    const uid = normalizeUid(String((req.body as { cardUid?: unknown } | undefined)?.cardUid ?? ''));
    const card = uid ? findCardByUid(db, uid) : undefined;
    let status: number, body: object;
    if (!card) {
      if (uid) recordSuggestion(db, uid, terminalId);
      status = 404; body = { error: 'Card not registered', code: 'unknown_card' };
    } else if (card.status === 'blocked') {
      status = 403; body = { error: 'Card is blocked', code: 'card_blocked', card: { name: card.name, photoUrl: `/cards/${card.id}/photo` } };
    } else {
      status = 200;
      body = { action: 'info', card: { id: card.id, name: card.name, photoUrl: `/cards/${card.id}/photo`, balance: card.balance }, history: cardHistory(db, card.id, HISTORY_LINES) };
    }
    publishTap(app, terminalId, 'info', { status, body });
    return reply.code(status).send(body);
  });
}
