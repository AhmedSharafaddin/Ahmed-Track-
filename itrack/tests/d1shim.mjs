// للاختبار: قاعدة D1 فوق node:sqlite (نفس ما يستخدمه خادم الشركة) + رموز Firebase مزيّفة للتوافق القديم.
import crypto from 'node:crypto';
export { makeD1 } from '../server/d1.mjs';
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
