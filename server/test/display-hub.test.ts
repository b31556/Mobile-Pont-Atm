import { describe, it, expect } from 'vitest';
import { DisplayHub, eventFor, type DisplayEvent } from '../src/display.js';

const card = { id: 'c1', name: 'Anna Kovács', photoUrl: '/cards/c1/photo' };
const ok = (body: object, status = 200) => ({ status, body });
const ev = (r: { status: number; body: object }, mode: 'fixed' | 'presence' | 'atm') => eventFor(r, mode) as Omit<DisplayEvent, 'seq' | 'at'>;

describe('DisplayHub', () => {
  it('numbers events in order, tells subscribers, and stops when they leave', () => {
    const hub = new DisplayHub();
    const got: number[] = [];
    const off = hub.subscribe('t1', e => got.push(e.seq));
    const a = hub.publish('t1', { tone: 'good', headline: 'A', details: [], balance: null, card: null, sound: null });
    const b = hub.publish('t1', { tone: 'good', headline: 'B', details: [], balance: null, card: null, sound: null });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(got).toEqual([a.seq, b.seq]);
    off();
    hub.publish('t1', { tone: 'good', headline: 'C', details: [], balance: null, card: null, sound: null });
    expect(got).toHaveLength(2);
    expect(hub.count('t1')).toBe(0);
  });

  it('keeps terminals apart', () => {
    const hub = new DisplayHub();
    const got: string[] = [];
    hub.subscribe('t1', e => got.push(e.headline));
    hub.publish('t2', { tone: 'good', headline: 'other terminal', details: [], balance: null, card: null, sound: null });
    expect(got).toEqual([]);
  });

  it('remembers the latest event, and the cards that tapped in the last hour (at most 20 events)', () => {
    let now = 1_000_000;
    const hub = new DisplayHub(() => now);
    expect(hub.last('t1')).toBeNull();
    const base = { tone: 'good' as const, headline: 'x', details: [], balance: null, sound: null };
    hub.publish('t1', { ...base, card: { id: 'c1', name: 'A' } });
    now += 30 * 60 * 1000;
    hub.publish('t1', { ...base, card: { id: 'c2', name: 'B' } });
    hub.publish('t1', { ...base, card: null });
    expect(hub.last('t1')!.card).toBeNull();
    expect([...hub.recentCardIds('t1')].sort()).toEqual(['c1', 'c2']);
    now += 40 * 60 * 1000;                                       // c1 tapped 70 minutes ago, c2 40
    expect([...hub.recentCardIds('t1')]).toEqual(['c2']);
    for (let i = 0; i < 30; i++) hub.publish('t1', { ...base, card: { id: `n${i}`, name: 'N' } });
    expect(hub.recentCardIds('t1').size).toBeLessThanOrEqual(20);
    expect(hub.recentCardIds('t1').has('c2')).toBe(false);       // pushed out by newer taps
  });

  it('one subscriber that throws does not stop the others', () => {
    const hub = new DisplayHub();
    const got: number[] = [];
    hub.subscribe('t1', () => { throw new Error('closed socket'); });
    hub.subscribe('t1', e => got.push(e.seq));
    hub.publish('t1', { tone: 'good', headline: 'x', details: [], balance: null, card: null, sound: null });
    expect(got).toHaveLength(1);
  });
});

describe('what the page says for each answer', () => {
  it('a fixed-amount grant: points and the balance, with the success sound', () => {
    const e = ev(ok({ action: 'granted', points: 10, card: { ...card, balance: 56 }, balanceBefore: 46 }), 'fixed');
    expect(e).toMatchObject({ tone: 'good', headline: '+10 points', balance: 56, sound: 'success', card: { id: 'c1', name: 'Anna Kovács' } });
  });
  it('too soon, with how long to wait, and the balance', () => {
    const e = ev(ok({ action: 'cooldown', points: 0, retryInSeconds: 40, card: { ...card, balance: 56 } }), 'fixed');
    expect(e).toMatchObject({ tone: 'neutral', headline: 'Too soon', balance: 56, sound: 'refused' });
    expect(e.details.join(' ')).toContain('40 seconds');
  });
  it('limits say which one was reached', () => {
    const uses = ev(ok({ action: 'limit_uses', retryInSeconds: 4 * 3600, card: { ...card, balance: 5 } }), 'fixed');
    expect(uses).toMatchObject({ tone: 'warn', headline: 'Limit reached', sound: 'refused' });
    expect(uses.details.join(' ')).toMatch(/4 hours/);
    expect(ev(ok({ action: 'limit_points', retryInSeconds: 90, card: { ...card, balance: 5 } }), 'fixed').details.join(' ')).toMatch(/points/i);
    const total = ev(ok({ action: 'limit_total', retryInSeconds: null, card: { ...card, balance: 5 } }), 'fixed');
    expect(total.headline).toBe('No more for this card');
  });
  it('signing in shows no balance; signing out shows time, points and the balance', () => {
    const inn = ev(ok({ action: 'in', points: 0, card: { ...card, balance: 46 }, zone: { id: 'z', name: 'Gym' }, inAt: '2026-10-23T12:05:00.000Z' }), 'presence');
    expect(inn).toMatchObject({ tone: 'good', headline: 'Checked in', balance: null, sound: 'in' });
    expect(inn.details.join(' ')).toContain('Gym');
    const out = ev(ok({ action: 'out', points: 24, minutes: 40, card: { ...card, balance: 70 }, zone: { id: 'z', name: 'Gym' } }), 'presence');
    expect(out).toMatchObject({ tone: 'good', headline: 'Checked out', balance: 70, sound: 'out' });
    expect(out.details.join(' ')).toContain('40 min'); expect(out.details.join(' ')).toContain('+24 points');
  });
  it('check-in refusals show no balance', () => {
    expect(ev(ok({ action: 'already_in', card: { ...card, balance: 46 }, inAt: '2026-10-23T12:05:00.000Z' }), 'presence')).toMatchObject({ tone: 'neutral', headline: 'Already checked in', balance: null, sound: 'refused' });
    expect(ev(ok({ action: 'not_in', card: { ...card, balance: 46 } }), 'presence')).toMatchObject({ tone: 'warn', headline: 'Not checked in', balance: null });
    expect(ev(ok({ action: 'cooldown', card: { ...card, balance: 46 }, inAt: '2026-10-23T12:05:00.000Z' }), 'presence')).toMatchObject({ tone: 'neutral', balance: null });
  });
  it('a forgotten visit says it earned nothing', () => {
    expect(ev(ok({ action: 'expired_out', card: { ...card, balance: 46 }, expiredMinutes: 780 }), 'presence').details.join(' ')).toMatch(/earned no points/);
    expect(ev(ok({ action: 'expired_in', card: { ...card, balance: 46 }, inAt: '2026-10-23T12:05:00.000Z' }), 'presence')).toMatchObject({ tone: 'warn', headline: 'Checked in' });
  });
  it('an ATM charge shows the points and the balance', () => {
    const e = ev(ok({ transaction: { id: 7, amount: 8 }, card: { ...card, balanceBefore: 46, balance: 54 } }), 'atm');
    expect(e).toMatchObject({ tone: 'good', headline: '+8 points', balance: 54, sound: 'success' });
  });
  it('an unregistered card shows no name or photo, a blocked one shows the name', () => {
    const unknown = ev(ok({ error: 'Card not registered', code: 'unknown_card' }, 404), 'fixed');
    expect(unknown).toMatchObject({ tone: 'refused', headline: 'Card not registered', card: null, balance: null, sound: 'refused' });
    const blocked = ev(ok({ error: 'Card is blocked', code: 'card_blocked', card: { name: 'Dóra Tóth', photoUrl: '/cards/c4/photo' } }, 403), 'fixed');
    expect(blocked).toMatchObject({ tone: 'refused', headline: 'Card is blocked', card: { id: 'c4', name: 'Dóra Tóth' } });
  });
  it('answers that mean nothing to a person (wrong mode, bad requests) produce no event', () => {
    expect(eventFor(ok({ code: 'wrong_mode' }, 409), 'fixed')).toBeNull();
    expect(eventFor(ok({ code: 'bad_request' }, 400), 'fixed')).toBeNull();
    expect(eventFor(ok({ error: 'x' }, 500), 'fixed')).toBeNull();
    expect(eventFor(ok({ action: 'something_new', card }), 'fixed')).toBeNull();
  });
});
