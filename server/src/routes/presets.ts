import type { FastifyInstance } from 'fastify';

const DEFAULTS = [4, 8, 12, 20];

export function registerPresets(app: FastifyInstance) {
  const db = app.db;
  const read = (terminalId: string) => {
    const t = db.prepare('select presets_saved, instant_preset from terminals where id=?').get(terminalId) as { presets_saved: number; instant_preset: number };
    const values = t.presets_saved
      ? (db.prepare('select value from presets where terminal_id=? order by value').all(terminalId) as { value: number }[]).map(r => r.value)
      : DEFAULTS;
    return { values, instantPreset: !!t.instant_preset };
  };

  app.get('/presets', { preHandler: app.requireOperator }, async req => read(req.user.terminalId!));

  app.put('/presets', { preHandler: app.requireOperator }, async (req, reply) => {
    const b = (req.body ?? {}) as { values?: unknown; instantPreset?: unknown };
    const v = b.values;
    const ok = Array.isArray(v) && v.length <= 8 && v.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 9999) && new Set(v).size === v.length;
    if (!ok) return reply.code(400).send({ error: 'Use up to 8 different whole numbers from 1 to 9999' });
    const terminalId = req.user.terminalId!;
    db.transaction(() => {
      db.prepare('delete from presets where terminal_id=?').run(terminalId);
      for (const n of v as number[]) db.prepare('insert into presets(terminal_id,value) values(?,?)').run(terminalId, n);
      db.prepare('update terminals set presets_saved=1, instant_preset=? where id=?').run(b.instantPreset === false ? 0 : 1, terminalId);
    })();
    return read(terminalId);
  });
}
