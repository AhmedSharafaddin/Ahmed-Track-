// واجهة D1 (Cloudflare) فوق node:sqlite: نفس prepare/bind/first/all/run/batch ⇒ نفس كود الخادم يعمل على سيرفر الشركة.
import { DatabaseSync } from 'node:sqlite';
export function makeD1(file = ':memory:') {
  const sq = new DatabaseSync(file);
  if (file !== ':memory:') {
    // WAL: قراءات متزامنة مع الكتابة، وكتابة أسرع؛ busy_timeout يمنع أخطاء القفل عند الضغط
    sq.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;');
  }
  sq.exec('PRAGMA foreign_keys = OFF');
  const cache = new Map(); // الجمل المحضّرة تُعاد (أسرع من إعادة التحليل في كل طلب)
  const prep = (sql) => { let st = cache.get(sql); if (!st) { st = sq.prepare(sql); if (cache.size < 500) cache.set(sql, st); } return st; };
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => prep(sql).get(...args) ?? null,
    run: async () => { const r = prep(sql).run(...args); return { success: true, meta: { changes: r.changes } }; },
    all: async () => ({ results: prep(sql).all(...args) }),
    _exec() { const st = prep(sql); return /^\s*(select|with)|returning/i.test(sql) ? { results: st.all(...args) } : (st.run(...args), { results: [] }); },
  });
  return {
    sq,
    prepare: (s) => stmt(s),
    batch: async (list) => { sq.exec('BEGIN'); try { const out = list.map((x) => x._exec()); sq.exec('COMMIT'); return out; } catch (e) { sq.exec('ROLLBACK'); throw e; } },
  };
}
