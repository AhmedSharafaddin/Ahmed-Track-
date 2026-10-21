// طبقة البيانات: واجهة واحدة للتطبيق، ومحرّكان خلفها.
//  • LocalAdapter  — localStorage على الجهاز الحالي (افتراضي، بلا حساب).
//  • CloudAdapter  — Firebase Firestore مع نسخة محلية للعمل دون اتصال ومزامنة لحظية.
// التطبيق لا يعرف أي محرّك يعمل؛ يستدعي store.put / store.remove فقط.

import { firebaseConfig } from './config.js';
import { now } from './utils.js';

export const COLLS = ['areas', 'goals', 'tasks', 'reviews'];
const LS_DATA = 'cc:data:v1';
const LS_MIGRATED = 'cc:migrated:'; // + uid
const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

/** المجالات الافتراضية بمعرّفات ثابتة — تكرار الإضافة لا يُنشئ نسخًا مكررة. */
export const SEED_AREAS = [
  { id: 'area-asas', name: 'أسس تيليكوم', color: '#2f7d6d', order: 1 },
  { id: 'area-aljoby', name: 'الجوبي', color: '#b5832a', order: 2 },
  { id: 'area-personal', name: 'شخصي / تطوير ذاتي', color: '#5b6bbf', order: 3 },
];

const emptyState = () => ({ areas: [], goals: [], tasks: [], reviews: [] });
const clean = (o) => JSON.parse(JSON.stringify(o)); // Firestore يرفض undefined

/* ───────────── المحرّك المحلي ───────────── */
class LocalAdapter {
  kind = 'local';

  read() {
    try {
      const raw = localStorage.getItem(LS_DATA);
      if (raw) return { ...emptyState(), ...JSON.parse(raw) };
    } catch (e) {
      console.warn('local read failed', e);
    }
    return null;
  }

  start(onChange) {
    this.onChange = onChange;
    const existing = this.read();
    this.state = existing || emptyState();
    if (!existing) {
      this.state.areas = SEED_AREAS.map((a) => ({ ...a, createdAt: now(), updatedAt: now() }));
      this.save();
    }
    this._onStorage = (e) => {
      if (e.key === LS_DATA) {
        this.state = this.read() || emptyState();
        onChange(this.state, { ready: true });
      }
    };
    window.addEventListener('storage', this._onStorage); // مزامنة بين نوافذ نفس الجهاز
    onChange(this.state, { ready: true });
  }

  stop() {
    window.removeEventListener('storage', this._onStorage);
  }

  save() {
    try {
      localStorage.setItem(LS_DATA, JSON.stringify(this.state));
    } catch (e) {
      console.error('local save failed', e);
    }
  }

  put(coll, item) {
    const list = this.state[coll];
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item;
    else list.push(item);
    this.save();
    this.onChange(this.state, { ready: true });
  }

  remove(coll, id) {
    this.state[coll] = this.state[coll].filter((x) => x.id !== id);
    this.save();
    this.onChange(this.state, { ready: true });
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
      // نسخة محلية دائمة: يعمل دون إنترنت ويزامن عند عودة الاتصال
      this.db = fs.initializeFirestore(app, {
        localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
      });
    } catch (e) {
      console.warn('persistent cache unavailable, using memory cache', e);
      this.db = fs.getFirestore(app);
    }
  }

  onAuth(cb) {
    return this.authMod.onAuthStateChanged(this.auth, cb);
  }

  signIn(email, pass) {
    return this.authMod.signInWithEmailAndPassword(this.auth, email, pass);
  }

  signUp(email, pass) {
    return this.authMod.createUserWithEmailAndPassword(this.auth, email, pass);
  }

  resetPassword(email) {
    return this.authMod.sendPasswordResetEmail(this.auth, email);
  }

  signOut() {
    return this.authMod.signOut(this.auth);
  }

  start(uid, onChange) {
    const { fs } = this;
    this.uid = uid;
    this.state = emptyState();
    const loaded = new Set();
    const fromServer = new Set();
    this.unsubs = COLLS.map((c) =>
      fs.onSnapshot(fs.collection(this.db, 'users', uid, c), { includeMetadataChanges: true }, (snap) => {
        this.state[c] = snap.docs.map((d) => d.data());
        loaded.add(c);
        if (!snap.metadata.fromCache) fromServer.add(c);
        if (loaded.size === COLLS.length) {
          onChange(this.state, {
            ready: true,
            serverConfirmed: fromServer.size === COLLS.length,
            pending: snap.metadata.hasPendingWrites,
          });
        }
      }, (err) => {
        console.error('snapshot error', err);
        onChange(this.state, { ready: true, error: err });
      })
    );
  }

  stop() {
    (this.unsubs || []).forEach((u) => u());
    this.unsubs = [];
  }

  ref(coll, id) {
    return this.fs.doc(this.db, 'users', this.uid, coll, id);
  }

  // لا ننتظر الوعد: الكتابة تظهر فورًا محليًا وتُرسل للسحابة عند توفر الاتصال
  put(coll, item) {
    this.fs.setDoc(this.ref(coll, item.id), clean(item)).catch((e) => console.error('put failed', e));
  }

  remove(coll, id) {
    this.fs.deleteDoc(this.ref(coll, id)).catch((e) => console.error('remove failed', e));
  }
}

/* ───────────── الواجهة الموحّدة ───────────── */
export const store = {
  state: emptyState(),
  mode: 'local', // local | cloud | cloud-signed-out | cloud-error
  user: null,
  syncConfigured: Boolean(firebaseConfig),
  status: { ready: false },
  listeners: new Set(),
  _seededCloud: false,

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },

  emit() {
    this.listeners.forEach((fn) => fn(this.state, this.status));
  },

  _attach(adapter, uid) {
    this.adapter?.stop?.();
    this.adapter = adapter;
    const cb = (state, status) => {
      this.state = state;
      this.status = status;
      if (adapter.kind === 'cloud' && status.serverConfirmed) this._afterCloudLoad();
      this.emit();
    };
    if (adapter.kind === 'cloud') adapter.start(uid, cb);
    else adapter.start(cb);
  },

  async boot() {
    this.local = new LocalAdapter();
    if (!this.syncConfigured) {
      this.mode = 'local';
      this._attach(this.local);
      return;
    }
    try {
      this.cloud = new CloudAdapter();
      await this.cloud.init();
    } catch (e) {
      console.error('cloud init failed', e);
      this.mode = 'cloud-error';
      this._attach(this.local);
      return;
    }
    this.cloud.onAuth((user) => {
      this.user = user;
      this._seededCloud = false;
      if (user) {
        this.mode = 'cloud';
        this._attach(this.cloud, user.uid);
      } else {
        this.mode = 'cloud-signed-out';
        this._attach(this.local);
      }
    });
  },

  /** بعد أول تحميل مؤكّد من الخادم: رفع البيانات المحلية مرة واحدة + المجالات الافتراضية. */
  _afterCloudLoad() {
    if (this._seededCloud || !this.user) return;
    this._seededCloud = true;
    const key = LS_MIGRATED + this.user.uid;
    if (!localStorage.getItem(key)) {
      const local = this.local.read();
      if (local) {
        for (const c of COLLS) {
          const remote = new Map(this.state[c].map((x) => [x.id, x]));
          for (const item of local[c] || []) {
            const r = remote.get(item.id);
            // الأحدث يفوز؛ الموجود في السحابة فقط يبقى كما هو
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
    const stamped = { ...item, updatedAt: now(), createdAt: item.createdAt || now() };
    this.adapter.put(coll, stamped);
    return stamped;
  },

  remove(coll, id) {
    this.adapter.remove(coll, id);
  },

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

  signIn: (e, p) => store.cloud.signIn(e, p),
  signUp: (e, p) => store.cloud.signUp(e, p),
  resetPassword: (e) => store.cloud.resetPassword(e),
  signOut: () => store.cloud.signOut(),
};
