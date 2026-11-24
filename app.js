/* دفتر المهام — المرحلة ١: محرك المزامنة (يعمل بلا إنترنت) + شاشة تجربة.
   كل تعديل يُحفظ على الجوال فورًا في «صندوق صادر» ويُرسل إلى Supabase حين يتاح الاتصال.
   التحميل يجلب ما تغيّر منذ آخر مزامنة فقط. */
(function () {
  'use strict';
  const C = window.DAFTAR_CONFIG || {};
  const $ = id => document.getElementById(id);
  const TIMEOUT = 15000;

  /* ---------- اتصال Supabase مع مهلة، حتى لا يعلق الطلب على شبكة ضعيفة ---------- */
  const timedFetch = (input, init = {}) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT);
    if (init.signal) init.signal.addEventListener('abort', () => ac.abort());
    return fetch(input, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
  };
  const LINK = (location.hash.match(/type=(invite|recovery|signup)/) || [])[1] || null;
  const sb = window.supabase.createClient(C.url, C.key, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'daftar-auth' },
    global: { fetch: timedFetch }
  });

  /* ---------- المخزن المحلي ---------- */
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  };
  const Store = {
    uid: null, items: new Map(), outbox: new Map(), lastSync: null,
    net: navigator.onLine === false ? 'off' : 'unknown', busy: false, timer: 0, fail: 0, listeners: [],
    k(name) { return 'daftar-' + name + '-' + this.uid; },
    load(uid) {
      this.uid = uid;
      this.items = new Map(ls.get(this.k('items'), []));
      this.outbox = new Map(ls.get(this.k('outbox'), []));
      this.lastSync = ls.get(this.k('sync'), null); this.lastOk = ls.get(this.k('ok'), null);
      this.emit();
    },
    save() {
      ls.set(this.k('items'), [...this.items.entries()]);
      ls.set(this.k('outbox'), [...this.outbox.entries()]);
      ls.set(this.k('sync'), this.lastSync); ls.set(this.k('ok'), this.lastOk);
    },
    on(fn) { this.listeners.push(fn); },
    emit() { this.listeners.forEach(fn => { try { fn(); } catch (_) {} }); },
    all() { return [...this.items.entries()].filter(([, v]) => !v.deleted).map(([id, v]) => ({ id, ...v.data })); },
    put(id, data) { this.items.set(id, { data, deleted: false }); this.outbox.set(id, { data, deleted: false }); this.save(); this.emit(); this.flush(); },
    remove(id) { const cur = this.items.get(id); this.items.set(id, { data: cur ? cur.data : {}, deleted: true }); this.outbox.set(id, { data: cur ? cur.data : {}, deleted: true }); this.save(); this.emit(); this.flush(); },
    async flush() {
      if (!this.uid || this.busy || !this.outbox.size) return;
      this.busy = true; clearTimeout(this.timer);
      const batch = [...this.outbox.entries()];
      const rows = batch.map(([id, e]) => ({ user_id: this.uid, id, data: e.data, deleted: e.deleted }));
      try {
        const { error } = await sb.from('items').upsert(rows, { onConflict: 'user_id,id' });
        if (error) throw error;
        batch.forEach(([id, e]) => { if (this.outbox.get(id) === e) this.outbox.delete(id); });
        this.fail = 0; this.net = 'ok'; this.lastOk = new Date().toISOString(); this.save();
      } catch (err) {
        this.fail++; if (!err || !err.code || err.name === 'AbortError' || /fetch|network|Failed/i.test(String(err.message || err))) this.net = 'off';
      }
      this.busy = false; this.emit();
      if (this.outbox.size) this.timer = setTimeout(() => this.flush(), Math.min(60000, 3000 * Math.pow(2, Math.min(this.fail, 5))));
    },
    async pull() {
      if (!this.uid) return;
      try {
        let q = sb.from('items').select('id,data,deleted,updated_at').order('updated_at', { ascending: true }).limit(1000);
        if (this.lastSync) q = q.gt('updated_at', this.lastSync);
        const { data, error } = await q;
        if (error) throw error;
        for (const r of data) {
          if (!this.outbox.has(r.id)) this.items.set(r.id, { data: r.data, deleted: r.deleted });
          this.lastSync = r.updated_at;
        }
        this.net = 'ok'; this.lastOk = new Date().toISOString(); this.save(); this.emit();
        if (data.length === 1000) return this.pull();
      } catch (_) { this.net = 'off'; this.emit(); }
    },
    sync() { return this.flush().then(() => this.pull()); }
  };
  window.DaftarStore = Store;

  /* ---------- الواجهة ---------- */
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = iso => { if (!iso) return 'لم تتم بعد'; const d = new Date(iso); return d.toLocaleString('ar-SA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }); };
  function pill() {
    const el = $('pill'), n = Store.outbox.size, off = Store.net === 'off' || navigator.onLine === false;
    const saved = n === 1 ? 'تعديل واحد محفوظ على جوالك ويُرسل' : n === 2 ? 'تعديلان محفوظان على جوالك ويُرسلان' : n + ' تعديلات محفوظة على جوالك وتُرسل';
    const sending = n === 1 ? 'تعديلًا واحدًا' : n === 2 ? 'تعديلين' : n + ' تعديلات';
    el.className = off ? 'off' : 'ok';
    el.textContent = off ? (n ? `غير متصل · ${saved} تلقائيًا` : 'غير متصل · يعمل الدفتر من النسخة المحفوظة')
      : (n ? `يُرسل ${sending}…` : 'متصل · كل شيء محفوظ');
  }
  function render() {
    pill();
    const items = Store.all().filter(i => i.type === 'test').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    $('list').innerHTML = items.length ? items.map(i => `<li class="${i.done ? 'done' : ''}"><span class="t">${esc(i.title)}</span><button data-a="done" data-id="${esc(i.id)}">${i.done ? 'أعد فتحها' : 'تم'}</button><button class="ghost" data-a="del" data-id="${esc(i.id)}" aria-label="حذف">حذف</button></li>`).join('')
      : '<li class="muted">لا شيء بعد. أضف ملاحظة تجربة.</li>';
    $('c-sync').textContent = '🔄 آخر اتصال بالخزنة: ' + fmt(Store.lastOk);
  }
  Store.on(render);

  $('af').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('nt').value.trim(); if (!v) return;
    const id = 'test-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    Store.put(id, { type: 'test', title: v, done: false, createdAt: Date.now() });
    $('nt').value = '';
  });
  $('list').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const id = b.dataset.id, cur = Store.items.get(id); if (!cur) return;
    if (b.dataset.a === 'done') Store.put(id, { ...cur.data, done: !cur.data.done });
    if (b.dataset.a === 'del') Store.remove(id);
  });

  /* ---------- الدخول ---------- */
  function show(which) { ['login', 'setpw', 'app'].forEach(k => $(k).classList.toggle('hide', which !== k)); }
  /* أول مرة: رابط الدعوة أو استعادة كلمة المرور يفتح هنا، فيختار كلمة مروره بنفسه */
  $('pf').addEventListener('submit', async e => {
    e.preventDefault(); $('perr').textContent = '';
    const a = $('np').value, b = $('np2').value;
    if (a.length < 8) { $('perr').textContent = 'اجعلها 8 أحرف على الأقل.'; return; }
    if (a !== b) { $('perr').textContent = 'الكلمتان غير متطابقتين.'; return; }
    const { data, error } = await sb.auth.updateUser({ password: a });
    if (error) { $('perr').textContent = 'تعذّر الحفظ. افتح الرابط من البريد مرة أخرى.'; return; }
    history.replaceState(null, '', location.pathname);
    $('pdone').classList.remove('hide'); $('pf').classList.add('hide');
    start(data.user.id, true);
  });
  $('forgot').addEventListener('click', async () => {
    const em = $('em').value.trim();
    if (!em) { $('lerr').textContent = 'اكتب بريدك أولًا، ثم اضغط «نسيت كلمة المرور».'; return; }
    const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo: location.origin + location.pathname });
    $('lerr').textContent = error ? 'تعذّر الإرسال، حاول بعد دقائق.' : 'أرسلنا رابطًا إلى بريدك. افتحه واختر كلمة مرور جديدة.';
  });
  $('lf').addEventListener('submit', async e => {
    e.preventDefault(); $('lerr').textContent = '';
    const { data, error } = await sb.auth.signInWithPassword({ email: $('em').value.trim(), password: $('pw').value });
    if (error) { $('lerr').textContent = navigator.onLine === false ? 'لا يوجد اتصال. الدخول أول مرة يحتاج الإنترنت.' : 'البريد أو كلمة المرور غير صحيحة.'; return; }
    start(data.session.user.id);
  });
  $('out').addEventListener('click', async () => {
    if (Store.outbox.size && !confirm('عندك تعديلات لم تُرسل بعد، وستضيع إن خرجت الآن. أتخرج؟')) return;
    try { await sb.auth.signOut(); } catch (_) {}
    Store.uid = null; show('login');
  });

  function start(uid, keepScreen) {
    if (Store.uid === uid) return;
    Store.load(uid); if (!keepScreen) show('app'); render(); Store.sync();
  }

  addEventListener('online', () => { Store.net = 'unknown'; Store.sync(); });
  addEventListener('offline', () => { Store.net = 'off'; Store.emit(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Store.sync(); });
  setInterval(() => { if (document.visibilityState === 'visible') Store.sync(); }, 60000);

  /* الجلسة محفوظة على الجوال، فتُقرأ بلا إنترنت */
  (async () => {
    let uid = null;
    try { const { data } = await sb.auth.getSession(); uid = data && data.session && data.session.user.id; } catch (_) {}
    if (uid && (LINK === 'invite' || LINK === 'recovery')) show('setpw');
    else if (uid) start(uid); else show('login');
    pill();
  })();

  /* ---------- فحص الجاهزية ---------- */
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  $('c-home').textContent = standalone ? '✓ يعمل من أيقونة الشاشة الرئيسية' : 'ⓘ افتحه من Safari ثم: زر المشاركة ← «إضافة إلى الشاشة الرئيسية»';
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready)
      .then(() => { $('c-sw').textContent = '✓ التطبيق محفوظ على جوالك ويفتح بلا إنترنت'; })
      .catch(() => { $('c-sw').textContent = '✗ تعذّر حفظ التطبيق للعمل بلا إنترنت'; });
  } else $('c-sw').textContent = '✗ المتصفح لا يدعم العمل بلا إنترنت';
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then(ok => { $('c-persist').textContent = ok ? '✓ بيانات الجوال محمية من المسح التلقائي' : 'ⓘ الجوال قد يمسح النسخة المحلية إن امتلأت مساحته، والأصل محفوظ في الخزنة'; });
  } else $('c-persist').textContent = 'ⓘ النسخة المحلية بلا حماية خاصة، والأصل محفوظ في الخزنة';
})();
