// طبقة البيانات: واجهة واحدة للتطبيق، وثلاثة محرّكات خلفها.
//  • LocalAdapter    — localStorage على الجهاز (بلا حساب).
//  • SnapshotAdapter — آخر نسخة من بيانات الحساب محفوظة على الجهاز: تُعرض فورًا عند الفتح
//                      قبل تحميل Firebase، وأي تعديل خلالها يُحفظ في طابور ويُرسل لاحقًا.
//  • CloudAdapter    — Firebase Firestore بمزامنة لحظية، ونسخة محلية للعمل دون اتصال.
//
// لماذا SnapshotAdapter؟ مكتبة Firebase نحو ٦٩٠ ك.ب. انتظارها قبل أول عرض كان سبب بطء الفتح.
// الآن: الشاشة تظهر من النسخة المحلية فورًا، وFirebase يُحمَّل بعد أول رسم ويُحدّث ما تغيّر فقط.

import { firebaseConfig } from './config.js';
import { now } from './utils.js';

export const COLLS = ['areas', 'goals', 'tasks', 'reviews'];
const LS_DATA = 'cc:data:v1';
const LS_MIGRATED = 'cc:migrated:'; // + uid
const LS_LAST = 'cc:lastUser'; // {uid, email} آخر حساب سجّل الدخول على هذا الجهاز
const LS_SNAP = 'cc:snap:'; // + uid  آخر نسخة من بيانات الحساب
const LS_QUEUE = 'cc:queue:'; // + uid  كتابات تمت قبل جاهزية Firebase
const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

/** المجالات الافتراضية بمعرّفات ثابتة — تكرار الإضافة لا يُنشئ نسخًا مكررة. */
export const SEED_AREAS = [
  { id: 'area-asas', name: 'أسس تيليكوم', color: '#2f7d6d', emoji: '💼', order: 1 },
  { id: 'area-aljoby', name: 'الجوبي', color: '#b5832a', emoji: '🛋️', order: 2 },
  { id: 'area-personal', name: 'شخصي / تطوير ذاتي', color: '#5b6bbf', emoji: '🌱', order: 3 },
];

const emptyState = () => ({ areas: [], goals: [], tasks: [], reviews: [] });
const clean = (o) => JSON.parse(JSON.stringify(o)); // Firestore يرفض undefined
const readJSON = (k) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch { return null; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { console.warn('storage write failed', k, e); return false; } };

/** ينفّذ الدالة مرة واحدة بعد انتهاء سلسلة استدعاءات متتالية (يمنع كتابة التخزين عشرات المرات). */
function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

/** تعديل مصفوفة مجموعة بنسخة جديدة (لا نعدّل الكائنات في مكانها). */
function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) { const c = list.slice(); c[i] = item; return c; }
  return [...list, item];
}

/* ───────────── المحرّك المحلي ───────────── */
class LocalAdapter {
  kind = 'local';

  read() {
    const d = readJSON(LS_DATA);
    return d ? { ...emptyState(), ...d } : null;
  }

  start(onChange) {
    this.onChange = onChange;
    const existing = this.read();
    this.state = existing || emptyState();
    if (!existing) {
      this.state.areas = SEED_AREAS.map((a) => ({ ...a, createdAt: now(), updatedAt: now() }));
      this.save.flush();
    }
    this._onStorage = (e) => {
      if (e.key === LS_DATA) { this.state = this.read() || emptyState(); onChange(this.state, { ready: true }, true); }
    };
    window.addEventListener('storage', this._onStorage); // مزامنة بين نوافذ نفس الجهاز (مثل الـWidget)
    onChange(this.state, { ready: true }, true);
  }

  stop() { window.removeEventListener('storage', this._onStorage); this.save.flush(); }

  save = debounce(() => writeJSON(LS_DATA, this.state), 150);

  put(coll, item) {
    this.state = { ...this.state, [coll]: upsert(this.state[coll], item) };
    this.save();
    this.onChange(this.state, { ready: true }, true);
  }

  remove(coll, id) {
    this.state = { ...this.state, [coll]: this.state[coll].filter((x) => x.id !== id) };
    this.save();
    this.onChange(this.state, { ready: true }, true);
  }
}

/* ───────────── نسخة الحساب المحفوظة (عرض فوري قبل Firebase) ───────────── */
class SnapshotAdapter {
  kind = 'snapshot';

  constructor(uid) { this.uid = uid; }

  start(onChange) {
    this.onChange = onChange;
    this.state = { ...emptyState(), ...(readJSON(LS_SNAP + this.uid) || {}) };
    onChange(this.state, { ready: true, serverConfirmed: false, booting: true }, true);
  }

  stop() { this.save.flush(); }

  save = debounce(() => writeJSON(LS_SNAP + this.uid, this.state), 150);

  _queue(op) {
    const q = readJSON(LS_QUEUE + this.uid) || [];
    q.push(op);
    if (!writeJSON(LS_QUEUE + this.uid, q)) console.error('queue write failed — edit kept on screen only', op);
  }

  // نحفظ الحقول التي تغيّرت فقط (patch) لا المستند كاملًا: إن عدّل جهاز آخر حقولًا أخرى
  // في الأثناء فلن تُمحى عند الإرسال، لأن الدمج يتم على مستوى الحقل.
  put(coll, item, patch) {
    this.state = { ...this.state, [coll]: upsert(this.state[coll], item) };
    this._queue(patch ? { op: 'patch', coll, id: item.id, data: patch } : { op: 'put', coll, id: item.id, data: item });
    this.save();
    this.onChange(this.state, { ready: true, serverConfirmed: false, pending: true, booting: true }, true);
  }

  remove(coll, id) {
    this.state = { ...this.state, [coll]: this.state[coll].filter((x) => x.id !== id) };
    this._queue({ op: 'remove', coll, id });
    this.save();
    this.onChange(this.state, { ready: true, serverConfirmed: false, pending: true, booting: true }, true);
  }
}

/* ───────────── المحرّك السحابي ───────────── */
class CloudAdapter {
  kind = 'cloud';

  async init() {
    const [appMod, authMod, fs] = await Promise.all([
      import(FB + 'firebase-app.js'),
      import(FB + 'firebase-auth.js'),
      import(FB + 'firebase-firestore.js'),
    ]);
    this.fs = fs;
    this.authMod = authMod;
    const app = appMod.initializeApp(firebaseConfig);
    this.auth = authMod.getAuth(app);
    try {
      this.db = fs.initializeFirestore(app, {
        localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
      });
    } catch (e) {
      console.warn('persistent cache unavailable, using memory cache', e);
      this.db = fs.getFirestore(app);
    }
  }

  onAuth(cb) { return this.authMod.onAuthStateChanged(this.auth, cb); }
  signIn(email, pass) { return this.authMod.signInWithEmailAndPassword(this.auth, email, pass); }
  signUp(email, pass) { return this.authMod.createUserWithEmailAndPassword(this.auth, email, pass); }
  resetPassword(email) { return this.authMod.sendPasswordResetEmail(this.auth, email); }
  signOut() { return this.authMod.signOut(this.auth); }
  idToken() { return this.auth.currentUser ? this.auth.currentUser.getIdToken() : Promise.resolve(null); }

  /**
   * يبدأ من النسخة المحفوظة (لا شاشة فارغة)، ثم يستبدل كل مجموعة عند وصول بياناتها.
   * التحديثات تُطبَّق تدريجيًا (docChanges) بدل إعادة بناء المجموعة كاملة،
   * وتغيّرات الحالة فقط (متزامن/يزامن) لا تعيد رسم الشاشة.
   */
  start(uid, onChange, seed) {
    const { fs } = this;
    this.uid = uid;
    this.onChange = onChange;
    this.state = { ...emptyState(), ...(seed || {}) };
    // الخرائط تبدأ بالنسخة المحفوظة حتى لا تختفي البيانات لحظة كتابة قبل وصول المجموعة من Firebase
    this.maps = Object.fromEntries(COLLS.map((c) => [c, new Map(this.state[c].map((x) => [x.id, x]))]));
    const loaded = new Set();
    const fromServer = new Set();
    const pending = new Set();
    const status = () => ({
      ready: true,
      serverConfirmed: fromServer.size === COLLS.length,
      pending: pending.size > 0,
    });
    this.status = status;

    this.unsubs = COLLS.map((c) =>
      fs.onSnapshot(fs.collection(this.db, 'users', uid, c), { includeMetadataChanges: true }, (snap) => {
        const m = this.maps[c];
        let changed = false;
        if (!loaded.has(c)) {
          // نسخة Firestore المحلية فارغة (مُسحت أو جهاز جديد) ونحن نعرض بيانات محفوظة ⇒ ننتظر الخادم
          if (snap.metadata.fromCache && !snap.docs.length && m.size) return;
          m.clear();
          snap.docs.forEach((d) => m.set(d.id, d.data()));
          loaded.add(c);
          changed = true;
        } else {
          for (const ch of snap.docChanges()) {
            if (ch.type === 'removed') m.delete(ch.doc.id);
            else m.set(ch.doc.id, ch.doc.data());
            changed = true;
          }
        }
        if (!snap.metadata.fromCache) fromServer.add(c);
        if (snap.metadata.hasPendingWrites) pending.add(c); else pending.delete(c);
        if (changed) this.state = { ...this.state, [c]: [...m.values()] };
        onChange(this.state, status(), changed);
        if (changed && fromServer.size === COLLS.length) this.saveSnap();
      }, (err) => {
        console.error('snapshot error', err);
        onChange(this.state, { ...status(), error: err }, false);
      })
    );
  }

  saveSnap = debounce(() => { if (this.uid) writeJSON(LS_SNAP + this.uid, this.state); }, 800);

  stop() {
    (this.unsubs || []).forEach((u) => u());
    this.unsubs = [];
    this.saveSnap.flush();
  }

  ref(coll, id) { return this.fs.doc(this.db, 'users', this.uid, coll, id); }

  // تحديث فوري في الواجهة، ثم إرسال للسحابة (يعمل دون اتصال ويُرسل عند عودته).
  // التعديل يُرسل كحقول متغيّرة مدموجة (merge) ⇒ تعديلان من جهازين على حقول مختلفة لا يمحو أحدهما الآخر.
  put(coll, item, patch) {
    this.maps[coll].set(item.id, item);
    this.state = { ...this.state, [coll]: [...this.maps[coll].values()] };
    this.onChange(this.state, { ...this.status(), pending: true }, true);
    const w = patch
      ? this.fs.setDoc(this.ref(coll, item.id), clean(patch), { merge: true })
      : this.fs.setDoc(this.ref(coll, item.id), clean(item));
    w.catch((e) => console.error('put failed', e));
  }

  /** تطبيق تعديل من الطابور على أحدث نسخة معروفة من الخادم (لا على النسخة القديمة). */
  applyPatch(coll, id, patch) {
    const cur = this.maps[coll].get(id);
    this.put(coll, { ...(cur || {}), ...patch, id }, cur ? patch : null);
  }

  remove(coll, id) {
    this.maps[coll].delete(id);
    this.state = { ...this.state, [coll]: [...this.maps[coll].values()] };
    this.onChange(this.state, { ...this.status(), pending: true }, true);
    this.fs.deleteDoc(this.ref(coll, id)).catch((e) => console.error('remove failed', e));
  }
}

/** بعد أول رسم للشاشة: يعطي المتصفح فرصة لعرض الواجهة قبل العمل الثقيل. */
const afterPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/* ───────────── الواجهة الموحّدة ───────────── */
export const store = {
  state: emptyState(),
  rev: 0, // يزيد مع كل تغيير في البيانات — مفتاح لذاكرة المحددات في model.js
  mode: 'local', // local | cloud | cloud-signed-out | cloud-error
  user: null,
  syncConfigured: Boolean(firebaseConfig),
  status: { ready: false },
  listeners: new Set(),
  _seededCloud: false,

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },

  emit(dataChanged = true) { this.listeners.forEach((fn) => fn(this.state, this.status, dataChanged)); },

  _attach(adapter, ...args) {
    if (this.adapter && this.adapter !== adapter) this.adapter.stop?.();
    this.adapter = adapter;
    const cb = (state, status, dataChanged = true) => {
      if (this.adapter !== adapter) return; // محرّك قديم
      this.state = state;
      this.status = this.offline ? { ...status, offline: true } : status;
      if (dataChanged) this.rev++;
      if (adapter.kind === 'cloud' && status.serverConfirmed) this._afterCloudLoad();
      this.emit(dataChanged);
    };
    adapter.start(...(adapter.kind === 'cloud' ? [args[0], cb, args[1]] : [cb]));
  },

  async boot() {
    this.local = new LocalAdapter();
    if (!this.syncConfigured) {
      this.mode = 'local';
      this._attach(this.local);
      return;
    }

    // ١) عرض فوري: آخر حساب على هذا الجهاز ⇒ نسخته المحفوظة، وإلا البيانات المحلية
    const last = readJSON(LS_LAST);
    if (last?.uid) {
      this.user = { uid: last.uid, email: last.email };
      this.mode = 'cloud';
      this._attach(new SnapshotAdapter(last.uid));
    } else {
      this.mode = 'cloud-signed-out';
      this._attach(this.local);
    }

    // ٢) Firebase بعد أول رسم
    await afterPaint();
    await this._startCloud();
  },

  async _startCloud() {
    try {
      const cloud = new CloudAdapter();
      await cloud.init();
      this.cloud = cloud;
      this.offline = false;
    } catch (e) {
      console.error('cloud init failed', e);
      if (this.mode !== 'cloud') this.mode = 'cloud-error';
      this.offline = true;
      this.status = { ...this.status, offline: true };
      this.emit(false);
      // نعيد المحاولة تلقائيًا حين يعود الاتصال، دون إعادة فتح التطبيق
      window.addEventListener('online', () => this._startCloud(), { once: true });
      return;
    }
    this.cloud.onAuth((user) => {
      this._seededCloud = false;
      if (user) {
        writeJSON(LS_LAST, { uid: user.uid, email: user.email });
        this.user = user;
        this.mode = 'cloud';
        const seed = this.adapter?.kind === 'snapshot' && this.adapter.uid === user.uid
          ? this.adapter.state : readJSON(LS_SNAP + user.uid);
        this._attach(this.cloud, user.uid, seed);
        this._flushQueue(user.uid);
      } else {
        // انتهت الجلسة أو سجّل الخروج: لا نُبقي بيانات الحساب ولا تعديلاته المعلّقة على الجهاز
        const prev = readJSON(LS_LAST);
        try {
          localStorage.removeItem(LS_LAST);
          if (prev?.uid) { localStorage.removeItem(LS_SNAP + prev.uid); localStorage.removeItem(LS_QUEUE + prev.uid); }
        } catch {}
        this.user = null;
        this.mode = 'cloud-signed-out';
        this._attach(this.local);
      }
    });
  },

  /** الكتابات التي تمت أثناء العرض الفوري تُرسل الآن بالترتيب. */
  _flushQueue(uid) {
    const q = readJSON(LS_QUEUE + uid);
    if (!q?.length) return;
    for (const op of q) {
      if (op.op === 'patch') this.cloud.applyPatch(op.coll, op.id, op.data);
      else if (op.op === 'put') this.cloud.put(op.coll, op.data || op.item);
      else this.cloud.remove(op.coll, op.id);
    }
    try { localStorage.removeItem(LS_QUEUE + uid); } catch {}
  },

  /** بعد أول تحميل مؤكّد من الخادم: رفع البيانات المحلية مرة واحدة + المجالات الافتراضية. */
  _afterCloudLoad() {
    if (this._seededCloud || !this.user) return;
    this._seededCloud = true;
    const key = LS_MIGRATED + this.user.uid;
    if (!localStorage.getItem(key)) {
      const local = this.local.read();
      if (local) {
        const seedIds = new Set(SEED_AREAS.map((a) => a.id));
        for (const c of COLLS) {
          const remote = new Map(this.state[c].map((x) => [x.id, x]));
          for (const item of local[c] || []) {
            // المجالات الافتراضية المحلية لا تعلو على مجالات الحساب (قد يكون المستخدم عدّلها أو حذفها)
            if (c === 'areas' && seedIds.has(item.id) && this.state.areas.length) continue;
            const r = remote.get(item.id);
            if (!r || (item.updatedAt || '') > (r.updatedAt || '')) this.cloud.put(c, item);
          }
        }
      }
      localStorage.setItem(key, now());
    }
    if (!this.state.areas.length) {
      SEED_AREAS.forEach((a) => this.cloud.put('areas', { ...a, createdAt: now(), updatedAt: now() }));
    }
  },

  put(coll, item) {
    const prev = this.state[coll].find((x) => x.id === item.id);
    const stamped = { ...item, updatedAt: now(), createdAt: item.createdAt || prev?.createdAt || now() };
    let patch = null;
    if (prev) {
      patch = { id: item.id };
      for (const k of new Set([...Object.keys(stamped), ...Object.keys(prev)])) {
        if (JSON.stringify(stamped[k]) !== JSON.stringify(prev[k])) patch[k] = stamped[k] === undefined ? null : stamped[k];
      }
    }
    this.adapter.put(coll, stamped, patch);
    return stamped;
  },

  /** مسح بيانات الحساب من هذا الجهاز (عند تسجيل الخروج). */
  forgetDevice() {
    const uid = this.user?.uid;
    try {
      localStorage.removeItem(LS_LAST);
      if (uid) { localStorage.removeItem(LS_SNAP + uid); localStorage.removeItem(LS_QUEUE + uid); }
    } catch {}
  },

  remove(coll, id) { this.adapter.remove(coll, id); },

  /** استبدال كامل (استيراد نسخة احتياطية). */
  importAll(data) {
    for (const c of COLLS) {
      const incoming = new Set((data[c] || []).map((x) => x.id));
      for (const old of this.state[c]) if (!incoming.has(old.id)) this.adapter.remove(c, old.id);
      for (const item of data[c] || []) this.adapter.put(c, item);
    }
  },

  exportAll() {
    const out = { app: 'command-center', version: 1, exportedAt: now() };
    for (const c of COLLS) out[c] = this.state[c];
    return out;
  },

  idToken: () => (store.cloud && store.mode === 'cloud' ? store.cloud.idToken() : Promise.resolve(null)),
  signIn: (e, p) => store.cloud.signIn(e, p),
  signUp: (e, p) => store.cloud.signUp(e, p),
  resetPassword: (e) => store.cloud.resetPassword(e),
  signOut: () => store.cloud.signOut(),
};
