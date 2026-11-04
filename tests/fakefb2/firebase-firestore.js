// Firestore وهمي بمسارات واستعلامات، ومرآة JS لقواعد firestore.rules لكشف استعلامات/كتابات سترفضها القواعد.
// window.__server = { 'path/with/slashes': doc }  ·  window.__denied = [] سجل الرفض
const S = () => (window.__server ||= {});
const L = [];
export const persistentLocalCache = () => ({}); export const persistentMultipleTabManager = () => ({});
export const initializeFirestore = () => ({}); export const getFirestore = () => ({});
export const connectFirestoreEmulator = () => {};
export const collection = (db, ...p) => ({ type: 'coll', path: p.join('/') });
export const doc = (db, ...p) => ({ type: 'doc', path: p.join('/'), id: p[p.length - 1] });
export const where = (f, op, v) => ({ f, op, v });
export const query = (c, ...w) => ({ type: 'query', path: c.path, w });
const parent = (p) => p.split('/').slice(0, -1).join('/');
const me = () => (window.__fakeUser?.email || '').toLowerCase();
const uidNow = () => window.__fakeUser?.uid;
const get = (p) => S()[p];
const isOwner = () => get('org/main')?.ownerUid === uidNow();
const deny = (why) => { (window.__denied ||= []).push(why); const e = new Error('permission-denied ' + why); e.code = 'permission-denied'; return e; };
function canRead(t) {
  const p = t.path;
  if (p.startsWith('users/')) return p.split('/')[1] === uidNow();
  if (t.type === 'doc') {
    if (p === 'org/main') return true;
    const [c, id] = p.split('/');
    if (c === 'members') return id === me() || isOwner() || get('members/' + id)?.managerEmail === me();
    if (c === 'reports') { const a = id.split('__')[0]; return a === me() || isOwner() || get('members/' + a)?.managerEmail === me(); }
    return false;
  }
  const eq = (f) => (t.w || []).some((w) => w.f === f && w.op === '==' && w.v === me());
  if (p === 'members') return isOwner() || eq('managerEmail');
  if (p === 'reports') return isOwner() || eq('email') || eq('managerEmail');
  return false;
}
function canWrite(path, prev, next) {
  if (path.startsWith('users/')) return path.split('/')[1] === uidNow();
  const [c, id] = path.split('/');
  if (c === 'org') return prev ? isOwner() && next.ownerUid === prev.ownerUid : next.ownerUid === uidNow();
  if (c === 'members') {
    if (isOwner()) return true;
    if (!prev || prev.managerEmail !== me()) return false;
    return changed(prev, next).every((k) => ['jd', 'title', 'updatedAt'].includes(k));
  }
  if (c === 'reports') {
    const okKeys = Object.keys(next).every((k) => ['email', 'date', 'managerEmail', 'items', 'note', 'status', 'submittedAt', 'updatedAt', 'review'].includes(k)) && Array.isArray(next.items) && next.items.length <= 60 && typeof next.note === 'string';
    const m = get('members/' + me());
    if (!prev) return !!m && okKeys && next.email === me() && id === me() + '__' + next.date && ['draft', 'submitted'].includes(next.status) && next.managerEmail === m.managerEmail && !('review' in next);
    const ch = changed(prev, next);
    const emp = prev.email === me() && ['draft', 'returned'].includes(prev.status) && okKeys && next.email === prev.email && next.date === prev.date && m && next.managerEmail === m.managerEmail
      && (['draft', 'submitted'].includes(next.status) || (next.status === 'returned' && prev.status === 'returned')) && !ch.includes('review');
    const rev = (isOwner() || prev.managerEmail === me()) && prev.email !== me() && ['submitted', 'returned'].includes(prev.status) && ch.every((k) => ['review', 'status', 'updatedAt'].includes(k)) && ['submitted', 'returned'].includes(next.status);
    return emp || rev;
  }
  return false;
}
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
function match(t, p, d) {
  if (t.type === 'doc') return t.path === p;
  if (parent(p) !== t.path) return false;
  return (t.w || []).every((w) => (w.op === '==' ? d[w.f] === w.v : w.op === 'in' ? w.v.includes(d[w.f]) : true));
}
function results(t) {
  if (t.type === 'doc') { const d = get(t.path); return { id: t.id, exists: () => !!d, data: () => d }; }
  const docs = Object.entries(S()).filter(([p, d]) => match(t, p, d)).map(([p, d]) => ({ id: p.split('/').pop(), data: () => d }));
  return { docs, docChanges: () => docs.map((d) => ({ type: 'added', doc: d })), metadata: { fromCache: false, hasPendingWrites: false } };
}
export const onSnapshot = (t, a, b, c) => {
  const [cb, err] = typeof a === 'function' ? [a, b] : [b, c];
  if (!canRead(t)) { setTimeout(() => err && err(deny('read ' + t.path + ' ' + JSON.stringify(t.w || []))), 10); return () => {}; }
  const l = { t, cb, err, seen: new Set() };
  L.push(l);
  setTimeout(() => cb(results(t)), window.__snapDelay ?? 60);
  return () => { const i = L.indexOf(l); if (i >= 0) L.splice(i, 1); };
};
function notify(path, removed) {
  for (const l of L) {
    if (l.t.type === 'doc') { if (l.t.path === path) l.cb(results(l.t)); continue; }
    if (parent(path) !== l.t.path) continue;
    const d = get(path); const id = path.split('/').pop();
    const ok = d && match(l.t, path, d);
    const changes = ok ? [{ type: 'modified', doc: { id, data: () => d } }] : [{ type: 'removed', doc: { id, data: () => ({}) } }];
    l.cb({ docs: results(l.t).docs, docChanges: () => changes, metadata: { fromCache: false, hasPendingWrites: false } });
  }
}
export const setDoc = async (ref, data, opts) => {
  const prev = get(ref.path);
  const next = opts?.merge ? { ...(prev || {}), ...JSON.parse(JSON.stringify(data)) } : JSON.parse(JSON.stringify(data));
  (window.__writes ||= []).push([ref.path, Object.keys(data)]);
  if (!canWrite(ref.path, prev, next)) throw deny('write ' + ref.path);
  S()[ref.path] = next;
  setTimeout(() => notify(ref.path), 15);
};
export const deleteDoc = async (ref) => { delete S()[ref.path]; setTimeout(() => notify(ref.path, true), 15); };
