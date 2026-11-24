/* دفتر المهام — الجسر بين الدفتر وخزنة Supabase.
   يقدّم للدفتر الواجهة نفسها التي يقدّمها Claude (window.claude.use)، فيبقى كود الدفتر واحدًا في المكانين.
   المتاح الآن: البيانات (db)، والمستخدم (user)، والتنزيل (downloads).
   الذكاء (sample) والتقويم (mcp) يُضافان في المرحلة 3؛ وحتى ذلك يعمل الدفتر بالمحلّل المحلي وبلا ربط تقويم. */
(function () {
  'use strict';
  const C = window.DAFTAR_CONFIG || {};
  const TIMEOUT = 15000;
  /* نوع الرابط القادم من البريد (دعوة أو استعادة كلمة مرور) يُقرأ قبل أن تستهلكه المكتبة */
  const LINK = (location.hash.match(/type=(invite|recovery|signup|magiclink)/) || [])[1] || null;

  const timedFetch = (input, init = {}) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT);
    if (init.signal) init.signal.addEventListener('abort', () => ac.abort());
    return fetch(input, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
  };
  const sb = window.supabase.createClient(C.url, C.key, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'daftar-auth', detectSessionInUrl: true },
    global: { fetch: timedFetch }
  });
  window.DaftarSB = sb;

  const race = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r({ code: 'timeout' }), ms))]);
  /* رقم المستخدم محفوظ على الجوال، فيُقرأ حتى بلا إنترنت وبجلسة منتهية */
  function storedUid() {
    try { const s = JSON.parse(localStorage.getItem('daftar-auth') || 'null'); return (s && s.user && s.user.id) || null; } catch (_) { return null; }
  }

  /* جلسة صالحة قبل أي طلب: بلا جلسة لا نطلب شيئًا، حتى لا تعود قراءة فارغة فتمسح ما على الشاشة */
  async function liveSession() {
    let session = null;
    try { const r = await race(sb.auth.getSession(), 6000); session = r && r.data && r.data.session; } catch (_) {}
    if (session) return session;
    if (navigator.onLine === false) throw { code: 'unavailable' };
    /* المكتبة تمسح الجلسة المحفوظة حين يرفض الخادم تجديدها: الدخول سُحب أو انتهى */
    if (!storedUid()) { authLost(); throw { code: 'revoked' }; }
    try {
      const r = await race(sb.auth.refreshSession(), 8000);
      if (r && r.data && r.data.session) return r.data.session;
      if (r && r.error && r.error.status >= 400 && r.error.status < 500) { authLost(); throw { code: 'revoked' }; }
    } catch (e) { if (e && e.code === 'revoked') throw e; }
    throw { code: 'unavailable' };
  }
  function mapErr(res) {
    const st = res && res.status, msg = (res && res.error && res.error.message) || '';
    if (st === 401 || /jwt/i.test(msg)) { authLost(); return { code: 'revoked', message: msg }; }
    if (st === 413) return { code: 'quota_exceeded', message: msg };
    return { code: 'unavailable', message: msg };
  }

  /* مجموعة بيانات بالشكل الذي يتوقعه الدفتر: onSnapshot و doc(id).set / delete */
  function collection(path) {
    const parts = path.split('/');
    const isMeta = parts.length === 5 && parts[3] === 'meta';
    const table = isMeta ? 'meta' : 'items', keyCol = isMeta ? 'key' : 'id';
    const subs = [];
    let gen = 0, busy = false, again = false, debounce = 0;

    async function fetchAll() {
      await liveSession();
      let q = sb.from(table).select(keyCol + ',data');
      if (!isMeta) q = q.eq('deleted', false);
      const res = await q;
      if (res.error) throw mapErr(res);
      return res.data || [];
    }
    async function refresh() {
      if (!subs.length) return;
      if (busy) { again = true; return; }
      busy = true;
      do {
        again = false;
        const g = gen;
        try {
          const rows = await fetchAll();
          if (g !== gen) { again = true; continue; } /* كتابة جرت أثناء القراءة: أعد القراءة */
          const docs = rows.filter(r => !(r.data && r.data.type === 'test'))
            .map(r => ({ id: r[keyCol], exists: true, data: () => r.data }));
          subs.forEach(s => { try { s.cb({ docs }); } catch (_) {} });
        } catch (e) {
          subs.forEach(s => { try { s.err && s.err(e); } catch (_) {} });
        }
      } while (again);
      busy = false;
    }
    const soon = () => { clearTimeout(debounce); debounce = setTimeout(refresh, 1500); };
    refreshers.push(refresh);

    async function write(fn) {
      gen++;
      try {
        const session = await liveSession();
        const res = await fn(session.user.id);
        if (res.error) throw mapErr(res);
      } finally { gen++; soon(); }
    }
    return {
      onSnapshot(cb, err) { subs.push({ cb, err }); refresh(); return () => { const i = subs.findIndex(s => s.cb === cb); if (i >= 0) subs.splice(i, 1); }; },
      doc(id) {
        return {
          set: data => write(uid => sb.from(table).upsert(
            isMeta ? { user_id: uid, key: id, data } : { user_id: uid, id, data, deleted: false },
            { onConflict: 'user_id,' + keyCol })),
          delete: () => write(() => sb.from(table).delete().eq(keyCol, id))
        };
      }
    };
  }

  /* تحديث دوري: عند العودة للتطبيق، وعند عودة الاتصال، وكل دقيقة ما دام ظاهرًا */
  const refreshers = [];
  const refreshAll = () => refreshers.forEach(f => f());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshAll(); });
  addEventListener('online', refreshAll);
  setInterval(() => { if (document.visibilityState === 'visible') refreshAll(); }, 60000);

  /* تنزيل ملف: مشاركة الآيفون أولًا (حفظ في «الملفات»)، ثم التنزيل العادي */
  async function save({ filename, data, mimeType }) {
    const type = mimeType || (/\.json$/i.test(filename) ? 'application/json' : /\.csv$/i.test(filename) ? 'text/csv' : 'text/plain');
    const file = new File([data], filename, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; }
      catch (e) { if (e && e.name === 'AbortError') throw { code: 'declined' }; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  window.claude = {
    use: async name => {
      if (name === 'db') return { collection };
      if (name === 'user') return { id: async () => storedUid() };
      if (name === 'downloads') return { save };
      throw { code: 'unavailable' }; /* sample و mcp: المرحلة 3 */
    }
  };

  /* ---------- شاشة الدخول ---------- */
  const CSS = `#gate{position:fixed;inset:0;z-index:2147483000;background:var(--bg,#F5F4F8);color:var(--fg,#1D1828);display:flex;align-items:flex-start;justify-content:center;padding:calc(env(safe-area-inset-top,0px) + 48px) 16px 24px;overflow:auto;font-family:var(--f-body,system-ui)}
#gate .gc{width:100%;max-width:420px;background:var(--surface,#fff);border:1px solid var(--line,#E3E0EA);border-radius:18px;padding:20px;box-shadow:var(--shadow,0 6px 24px rgba(20,10,45,.1));display:flex;flex-direction:column;gap:12px}
#gate h1{font-family:var(--f-head,inherit);font-size:24px;margin:0}
#gate p{margin:0;color:var(--muted,#625B70);font-size:14.5px;line-height:1.6}
#gate input{font:inherit;font-size:16px;padding:12px 14px;border:1px solid var(--line,#E3E0EA);border-radius:12px;background:var(--bg,#F5F4F8);color:var(--fg,#1D1828);text-align:right;width:100%;box-sizing:border-box}
#gate button{font:inherit;font-weight:600;font-size:15px;border:0;border-radius:12px;padding:12px 16px;min-height:46px;background:var(--brand,#522D8E);color:#fff;cursor:pointer}
#gate button.ghost{background:transparent;color:var(--muted,#625B70);border:1px solid var(--line,#E3E0EA)}
#gate .err{color:#C2410C;font-size:13.5px;min-height:1em}
#gate form{display:flex;flex-direction:column;gap:10px;margin:0}`;
  let gateShown = false;
  function gate(mode, msg) {
    if (gateShown && mode !== 'setpw') return;
    gateShown = true;
    const mount = () => {
      let g = document.getElementById('gate');
      if (!g) {
        const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
        g = document.createElement('div'); g.id = 'gate'; g.setAttribute('dir', 'rtl'); g.setAttribute('lang', 'ar');
        document.body.appendChild(g);
      }
      g.innerHTML = mode === 'setpw' ? `<div class="gc"><h1>اختر كلمة مرور</h1>
<p>ستكتبها مرة واحدة في كل جهاز، ثم يبقى الدفتر مفتوحًا حتى بلا إنترنت.</p>
<form id="g-pf"><input id="g-np" type="password" autocomplete="new-password" placeholder="كلمة المرور (8 أحرف على الأقل)" dir="ltr" required>
<input id="g-np2" type="password" autocomplete="new-password" placeholder="أعدها للتأكيد" dir="ltr" required>
<button type="submit">احفظ وافتح الدفتر</button><div id="g-err" class="err"></div></form></div>`
        : `<div class="gc"><h1>دفتر المهام</h1>
<p>${msg || 'ادخل ببريدك وكلمة مرور الدفتر. الدخول أول مرة يحتاج الإنترنت، ثم يعمل الدفتر بدونه.'}</p>
<form id="g-lf"><input id="g-em" type="email" autocomplete="username" placeholder="البريد" dir="ltr" required>
<input id="g-pw" type="password" autocomplete="current-password" placeholder="كلمة المرور" dir="ltr" required>
<button type="submit">دخول</button><button type="button" id="g-forgot" class="ghost">نسيت كلمة المرور</button>
<div id="g-err" class="err" role="status" aria-live="polite"></div></form></div>`;
      const $ = id => document.getElementById(id), err = t => { $('g-err').textContent = t; };
      if (mode === 'setpw') {
        $('g-pf').addEventListener('submit', async e => {
          e.preventDefault(); err('');
          const a = $('g-np').value, b = $('g-np2').value;
          if (a.length < 8) return err('اجعلها 8 أحرف على الأقل.');
          if (a !== b) return err('الكلمتان غير متطابقتين.');
          const { error } = await sb.auth.updateUser({ password: a });
          if (error) return err('تعذّر الحفظ. افتح الرابط من البريد مرة أخرى.');
          location.replace(location.pathname);
        });
        return;
      }
      $('g-lf').addEventListener('submit', async e => {
        e.preventDefault(); err('');
        if (navigator.onLine === false) return err('لا يوجد اتصال. الدخول أول مرة يحتاج الإنترنت.');
        const { error } = await sb.auth.signInWithPassword({ email: $('g-em').value.trim(), password: $('g-pw').value });
        if (error) return err(error.status >= 500 || !error.status ? 'تعذّر الاتصال. حاول بعد قليل.' : 'البريد أو كلمة المرور غير صحيحة.');
        location.replace(location.pathname);
      });
      $('g-forgot').addEventListener('click', async () => {
        const em = $('g-em').value.trim();
        if (!em) return err('اكتب بريدك أولًا، ثم اضغط «نسيت كلمة المرور».');
        const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo: location.origin + location.pathname });
        err(error ? 'تعذّر الإرسال، حاول بعد دقائق.' : 'أرسلنا رابطًا إلى بريدك. افتحه واختر كلمة مرور جديدة.');
      });
    };
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  }
  function authLost() { if (navigator.onLine !== false) gate('login', 'انتهت جلسة الدخول. ادخل مرة أخرى لتُرسل تعديلاتك؛ ما كتبته محفوظ على جوالك.'); }

  if (LINK === 'invite' || LINK === 'recovery') {
    sb.auth.getSession().then(r => { if (r.data && r.data.session) gate('setpw'); else gate('login', 'انتهت صلاحية الرابط. اطلب رابطًا جديدًا من «نسيت كلمة المرور».'); });
  } else if (!storedUid()) gate('login');
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') authLost(); });

  /* حفظ التطبيق على الجوال ليفتح بلا إنترنت، وطلب حماية بياناته من المسح التلقائي */
  if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
})();
