// محاكاة D1 فوق node:sqlite (للاختبار المحلي): نفس واجهة prepare/bind/first/all/run/batch.
import { DatabaseSync } from 'node:sqlite';
export function makeD1(file = ':memory:') {
  const sq = new DatabaseSync(file);
  sq.exec('PRAGMA foreign_keys = OFF');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sq.prepare(sql).get(...args) ?? null,
    run: async () => { const r = sq.prepare(sql).run(...args); return { success: true, meta: { changes: r.changes } }; },
    all: async () => ({ results: sq.prepare(sql).all(...args) }),
    _exec() { const st = sq.prepare(sql); return /^\s*(select|with)|returning/i.test(sql) ? { results: st.all(...args) } : (st.run(...args), { results: [] }); },
  });
  return {
    sq,
    prepare: (s) => stmt(s),
    batch: async (list) => { sq.exec('BEGIN'); try { const out = list.map((x) => x._exec()); sq.exec('COMMIT'); return out; } catch (e) { sq.exec('ROLLBACK'); throw e; } },
  };
}
// رموز Firebase مزيّفة موقّعة بمفتاح اختبار + خادم مفاتيح عام وهمي
import crypto from 'node:crypto';
export function makeTokens(project = 'track-b87ef') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const b = (x) => Buffer.from(x).toString('base64url');
  const token = ({ uid, email, verified = true, exp = 3600 }) => {
    const h = b(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })); const t = Math.floor(Date.now() / 1000);
    const p = b(JSON.stringify({ aud: project, iss: `https://securetoken.google.com/${project}`, sub: uid, email, email_verified: verified, iat: t, exp: t + exp }));
    return `${h}.${p}.${b(crypto.sign('sha256', Buffer.from(`${h}.${p}`), privateKey))}`;
  };
  return { jwk, token };
}
