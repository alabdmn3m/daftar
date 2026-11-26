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

  /* طلبات الدخول لا تُقطع ولا تُقاطَع بإعادة تحميل: الخادم يستبدل مفتاح التجديد عند كل طلب،
     فإن ضاع الرد بقي على الجوال مفتاح مستعمل، فيُلغي الخادم الجلسة كلها ويُطلب الدخول من جديد. */
  const authNet = { busy: 0, last: 0 };
  window.DaftarAuthNet = authNet;
  const timedFetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/auth/v1/')) {
      authNet.busy++;
      return fetch(input, init).finally(() => { authNet.busy--; authNet.last = Date.now(); });
    }
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

  /* ---------- الدوال في الخادم (الفهم الذكي والتقويم) ---------- */
  const FN = C.url + '/functions/v1/';
  async function fnFetch(name, body, signal) {
    const session = await liveSession();
    return fetch(FN + name, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', apikey: C.key, Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify(body)
    });
  }
  const isAbort = e => e && (e.name === 'AbortError' || e.code === 'cancelled');

  /* الفهم الذكي: نفس واجهة Claude — sample(نص) للمسودات مع البث، و sample.json(نص) للفهم */
  async function aiCall(prompt, opts = {}, asJson) {
    if (navigator.onLine === false) throw { code: 'offline' };
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 60000);
    if (opts.signal) { if (opts.signal.aborted) ac.abort(); opts.signal.addEventListener('abort', () => ac.abort()); }
    try {
      let r;
      try { r = await fnFetch('ai', { prompt, json: !!asJson, tier: opts.modelTier === 'quick' ? 'quick' : 'default', stream: !asJson && !!opts.onText }, ac.signal); }
      catch (e) { if (opts.signal && opts.signal.aborted) throw { code: 'cancelled' }; if (e && e.code) throw e; throw { code: 'unavailable' }; }
      /* الدالة غير منشورة بعد (404) أو بلا مفتاح: الدفتر يرتّب محليًا دون رسالة خطأ */
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw { code: r.status === 404 ? 'not_configured' : (['rate_limited', 'refused', 'session_expired', 'not_configured'].includes(e.code) ? e.code : 'unavailable') }; }
      if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
        const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '', text = '', stop = '';
        for (;;) {
          const { done, value } = await rd.read(); if (done) break;
          buf += dec.decode(value, { stream: true }); const parts = buf.split('\n'); buf = parts.pop();
          for (const ln of parts) {
            if (!ln.startsWith('data:')) continue;
            let ev; try { ev = JSON.parse(ln.slice(5)); } catch (_) { continue; }
            if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { text += ev.delta.text; try { opts.onText({ text }); } catch (_) {} }
            if (ev.type === 'message_delta' && ev.delta) stop = ev.delta.stop_reason || stop;
            if (ev.type === 'error') throw { code: 'unavailable' };
          }
        }
        if (stop === 'refusal') throw { code: 'refused' };
        return { text, truncated: stop === 'max_tokens' };
      }
      const o = await r.json();
      if (o.code) throw { code: o.code };
      if (!asJson) { if (opts.onText) try { opts.onText({ text: o.text }); } catch (_) {} return { text: o.text, truncated: !!o.truncated }; }
      /* يُستخرج أول كائن JSON من الرد ولو أحاط به نص */
      const s = String(o.text || ''), a = s.search(/[[{]/), b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
      try { return JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s); } catch (_) { throw { code: 'invalid_json' }; }
    } catch (e) { if (isAbort(e) || (opts.signal && opts.signal.aborted)) throw { code: 'cancelled' }; throw e; }
    finally { clearTimeout(t); }
  }
  const sample = (prompt, opts) => aiCall(prompt, opts, false);
  sample.json = (prompt, opts) => aiCall(prompt, opts, true);

  /* ---------- تقويم Google: يعمل بلا إنترنت ----------
     الإضافة تأخذ رقمًا يولّده الجوال، فإن تعذّر الإرسال حُفظت في طابور وأُرسلت لاحقًا بالرقم نفسه دون تكرار.
     التعديل والحذف يُدمجان في الطابور مع ما سبقهما للحدث نفسه. */
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Riyadh'; } catch (_) { return 'Asia/Riyadh'; } })();
  const QK = () => 'daftar-calout-' + (storedUid() || 'x');
  const qLoad = () => { try { return JSON.parse(localStorage.getItem(QK()) || '[]'); } catch (_) { return []; } };
  const qSave = q => { try { localStorage.setItem(QK(), JSON.stringify(q)); } catch (_) {} };
  const newEventId = () => { const a = crypto.getRandomValues(new Uint8Array(20)); return 'd' + [...a].map(x => '0123456789abcdefghijklmnopqrstuv'[x & 31]).join(''); };
  const softErr = c => c === 'unavailable' || c === 'server_unavailable' || c === 'offline';
  let calState = (() => { try { return JSON.parse(localStorage.getItem('daftar-gcal') || 'null'); } catch (_) { return null; } })();
  const setCal = s => { calState = s; try { localStorage.setItem('daftar-gcal', JSON.stringify(s)); } catch (_) {} rerender(); };

  async function calSend(tool, args) {
    if (navigator.onLine === false) throw { code: 'offline' };
    let r; try { r = await fnFetch('gcal', { action: 'call', tool, args, tz: TZ }); } catch (e) { throw { code: e && e.code === 'revoked' ? 'revoked' : 'unavailable' }; }
    const o = await r.json().catch(() => null);
    if (r.status === 404 || (o && o.code === 'not_configured')) throw { code: 'server_not_connected' };
    if (!r.ok || !o) throw { code: r.status === 401 ? 'session_expired' : 'server_unavailable' };
    if (o.error) throw o.error;
    return o;
  }
  function enqueue(tool, args) {
    let q = qLoad(); const id = args.eventId;
    const prev = q.filter(x => x.args.eventId === id);
    if (tool === 'delete_event' && prev.some(x => x.tool === 'create_event')) { qSave(q.filter(x => x.args.eventId !== id)); return; }
    if (tool === 'update_event' && prev.length) { const last = prev[prev.length - 1]; if (last.tool !== 'delete_event') { last.args = Object.assign({}, last.args, args); qSave(q); return; } }
    if (tool === 'delete_event') q = q.filter(x => x.args.eventId !== id);
    q.push({ tool, args }); qSave(q);
  }
  let flushing = false;
  async function calFlush() {
    if (flushing || navigator.onLine === false || !storedUid()) return;
    let q = qLoad(); if (!q.length) return; flushing = true;
    try {
      while (q.length) {
        const op = q[0];
        try { await calSend(op.tool, op.args); }
        catch (e) {
          const c = e && e.code;
          if (softErr(c) || c === 'revoked' || c === 'session_expired') break; /* يعاد لاحقًا */
          if (c === 'needs_reauth' || c === 'server_not_connected') { setCal({ connected: false, email: calState && calState.email, reauth: c === 'needs_reauth' }); break; }
          const gone = c === 'tool_error' && /not ?found|404|410/i.test(String(e.message || ''));
          if (!gone) toast('لم يصل تعديل إلى تقويم Google: ' + String(e.message || c).slice(0, 80));
        }
        q = qLoad(); q.shift(); qSave(q);
      }
    } finally { flushing = false; }
  }
  addEventListener('online', () => setTimeout(calFlush, 1500));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') calFlush(); });
  setInterval(calFlush, 60000);

  const mcp = {
    async callTool(server, tool, args) {
      args = Object.assign({}, args || {});
      if (tool === 'create_event' && !args.eventId) args.eventId = newEventId();
      if (calState && calState.connected === false && !calState.unknown) throw { code: calState.reauth ? 'needs_reauth' : 'server_not_connected' };
      /* ما سبقه في الطابور للحدث نفسه يُرسل أولًا، فيبقى الترتيب صحيحًا */
      if (qLoad().some(x => x.args.eventId === args.eventId)) { enqueue(tool, args); calFlush(); return { payload: { id: args.eventId, queued: true } }; }
      try { return await calSend(tool, args); }
      catch (e) {
        const c = e && e.code;
        if (softErr(c) || c === 'revoked' || c === 'session_expired') { enqueue(tool, args); return { payload: { id: args.eventId, queued: true } }; }
        if (c === 'server_not_connected' || c === 'needs_reauth') setCal({ connected: false, email: calState && calState.email, reauth: c === 'needs_reauth' });
        throw e;
      }
    }
  };

  /* ربط التقويم من قسم «بياناتك» */
  async function calStatus() {
    if (navigator.onLine === false || !storedUid()) return;
    try { const r = await fnFetch('gcal', { action: 'status' }); const o = await r.json(); if (r.ok && 'connected' in o) setCal({ connected: o.connected, email: o.email }); } catch (_) {}
  }
  async function calConnect() {
    if (navigator.onLine === false) return toast('الربط يحتاج الإنترنت.');
    try {
      const r = await fnFetch('gcal', { action: 'start', returnTo: location.origin + location.pathname });
      const o = await r.json(); if (!r.ok || !o.url) throw o;
      location.href = o.url;
    } catch (e) { toast(e && e.code === 'not_configured' ? 'ربط التقويم لم يُجهَّز في الخادم بعد.' : 'تعذّر بدء الربط. جرّب بعد قليل.'); }
  }
  async function calDisconnect() {
    if (!confirm('تفصل تقويم Google عن الدفتر؟ الأحداث الموجودة تبقى في التقويم.')) return;
    try { await fnFetch('gcal', { action: 'disconnect' }); setCal({ connected: false }); toast('فُصل تقويم Google.'); } catch (_) { toast('تعذّر الفصل الآن.'); }
  }
  window.DaftarCalHTML = () => {
    const s = calState;
    if (s && s.connected) return `<div class="data-row" style="margin-top:8px;align-items:center"><span style="font-size:13px;color:var(--muted)">✓ تقويم Google مربوط${s.email ? ' · <bdi dir="ltr">' + String(s.email).replace(/[<>&"]/g, '') + '</bdi>' : ''}</span><button class="btn quiet small" data-gcal="off">افصل</button></div>`;
    return `<div class="data-row" style="margin-top:8px"><button class="btn primary small" data-gcal="on">${s && s.reauth ? 'أعد ربط تقويم Google' : 'اربط تقويم Google'}</button></div>`;
  };
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-gcal]'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (b.dataset.gcal === 'on') calConnect(); else calDisconnect();
  }, true);
  /* ---------- ودجت الآيفون: قائمة مهام الأيام السبعة القادمة يقرؤها الودجت برمز للقراءة فقط ---------- */
  /* القائمة يبنيها الدفتر نفسه (window.DaftarWidgetFeed في build.py) لأن بياناته داخل نطاقه */
  const widgetFeed = () => { try { return window.DaftarWidgetFeed ? window.DaftarWidgetFeed() : null; } catch (_) { return null; } };
  let wfBusy = false, wfTimer = 0;
  async function widgetPush() {
    if (wfBusy || navigator.onLine === false || !storedUid()) return;
    const f = widgetFeed(); if (!f) return;
    const s = JSON.stringify(f);
    let last = ''; try { last = localStorage.getItem('daftar-widget-sent') || ''; } catch (_) {}
    if (s === last) return;
    wfBusy = true;
    try {
      const session = await liveSession();
      const res = await sb.from('meta').upsert({ user_id: session.user.id, key: 'widget', data: f }, { onConflict: 'user_id,key' });
      if (!res.error) { try { localStorage.setItem('daftar-widget-sent', s); } catch (_) {} }
    } catch (_) {} finally { wfBusy = false; }
  }
  window.DaftarWidgetSync = () => { clearTimeout(wfTimer); wfTimer = setTimeout(widgetPush, 2000); };
  setInterval(() => { if (document.visibilityState === 'visible') widgetPush(); }, 60000);

  let wk = (() => { try { return localStorage.getItem('daftar-widget-linked') === '1'; } catch (_) { return false; } })();
  let wkShow = '';
  const setWk = (on, show) => { wk = on; wkShow = show || ''; try { localStorage.setItem('daftar-widget-linked', on ? '1' : '0'); } catch (_) {} rerender(); };
  async function sha256(s) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  async function wkLink() {
    if (navigator.onLine === false) return toast('الربط يحتاج الإنترنت.');
    const a = new Uint8Array(24); crypto.getRandomValues(a);
    const key = [...a].map(x => x.toString(16).padStart(2, '0')).join('');
    try {
      const session = await liveSession();
      const res = await sb.from('widget_keys').upsert({ user_id: session.user.id, key_hash: await sha256(key) }, { onConflict: 'user_id' });
      if (res.error) throw res.error;
      try { localStorage.removeItem('daftar-widget-sent'); } catch (_) {}
      setWk(true, key); widgetPush();
    } catch (_) { toast('تعذّر إنشاء رمز الربط. جرّب بعد قليل.'); }
  }
  async function wkUnlink() {
    if (!confirm('تفصل ودجت الآيفون عن الدفتر؟ تختفي المهام منه وتبقى المواعيد.')) return;
    try {
      const session = await liveSession();
      const res = await sb.from('widget_keys').delete().eq('user_id', session.user.id);
      if (res.error) throw res.error;
      setWk(false); toast('فُصل الودجت عن الدفتر.');
    } catch (_) { toast('تعذّر الفصل الآن.'); }
  }
  async function wkCopy() {
    try { await navigator.clipboard.writeText(wkShow); toast('✓ نُسخ الرمز. الصقه في Scriptable.'); }
    catch (_) { const i = document.getElementById('wk-key'); if (i) { i.focus(); i.select(); } toast('حدّد الرمز وانسخه.'); }
  }
  window.DaftarWidgetHTML = () => {
    if (wkShow) return `<div class="confirm" style="background:var(--brand-tint);margin-top:8px"><p style="color:var(--fg)">رمز ربط الودجت (يظهر مرة واحدة). انسخه، ثم افتح Scriptable وشغّل سكربت «مواعيد اليوم» والصقه.</p><input id="wk-key" readonly dir="ltr" value="${wkShow}" style="width:100%;box-sizing:border-box;font:13px ui-monospace,monospace;padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--fg)"><div><button class="btn primary small" data-wk="copy">انسخ الرمز</button><button class="btn quiet small" data-wk="done">تم</button></div></div>`;
    if (wk) return `<div class="data-row" style="margin-top:8px;align-items:center"><span style="font-size:13px;color:var(--muted)">✓ ودجت الآيفون مربوط</span><button class="btn quiet small" data-wk="new">رمز جديد</button><button class="btn quiet small" data-wk="off">افصل</button></div>`;
    return `<div class="data-row" style="margin-top:8px"><button class="btn quiet small" data-wk="on">اربط ودجت الآيفون</button></div>`;
  };
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-wk]'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const a = b.dataset.wk;
    if (a === 'on' || a === 'new') wkLink(); else if (a === 'off') wkUnlink(); else if (a === 'copy') wkCopy(); else if (a === 'done') { wkShow = ''; rerender(); }
  }, true);

  function rerender() { try { window.dispatchEvent(new Event('daftar-rerender')); } catch (_) {} }
  /* العودة من Google */
  const GC = (location.hash.match(/gcal=([a-z-]+)/) || [])[1];
  if (GC) {
    history.replaceState(null, '', location.pathname);
    const msg = { ok: '✓ رُبط تقويم Google بالدفتر.', denied: 'لم تكتمل الموافقة على الربط.', expired: 'انتهت مهلة الربط. أعد المحاولة.', failed: 'تعذّر إكمال الربط. أعد المحاولة.' }[GC];
    if (msg) setTimeout(() => toast(msg), 600);
    if (GC === 'ok') { calState = { connected: true }; setTimeout(calStatus, 300); }
  }
  setTimeout(() => { calStatus(); calFlush(); }, 2500);

  function toast(msg) {
    const show = () => {
      let d = document.getElementById('bridge-toast');
      if (!d) { d = document.createElement('div'); d.id = 'bridge-toast'; d.setAttribute('role', 'status'); d.setAttribute('dir', 'rtl');
        d.style.cssText = 'position:fixed;inset-inline:16px;top:calc(env(safe-area-inset-top,0px) + 12px);z-index:2147483002;max-width:520px;margin:0 auto;padding:10px 14px;border-radius:14px;background:var(--fg,#1D1828);color:var(--bg,#fff);font:500 14px/1.6 var(--f-body,system-ui);box-shadow:0 8px 28px rgba(20,10,45,.25);text-align:center';
        document.body.appendChild(d); }
      d.textContent = msg; clearTimeout(toast.h); toast.h = setTimeout(() => d.remove(), 4500);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }

  window.claude = {
    use: async name => {
      if (name === 'db') return { collection };
      if (name === 'user') return { id: async () => storedUid() };
      if (name === 'downloads') return { save };
      if (name === 'sample') return sample;
      if (name === 'mcp') return mcp;
      throw { code: 'unavailable' };
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
<form id="g-lf"><input id="g-em" type="email" autocomplete="username" placeholder="البريد" dir="ltr" required value="${(() => { try { return (localStorage.getItem('daftar-email') || '').replace(/[^\w.@+-]/g, ''); } catch (_) { return ''; } })()}">
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
        try { localStorage.setItem('daftar-email', $('g-em').value.trim()); } catch (_) {}
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
  /* يُسجَّل فورًا لا بعد اكتمال التحميل، حتى يُحفظ التطبيق ولو أُغلق سريعًا */
  if ('serviceWorker' in navigator) {
    const hadSW = !!navigator.serviceWorker.controller;
    /* يخبر عامل الخدمة أن هذه الصفحة تعرف كيف تُحدّث نفسها */
    navigator.serviceWorker.addEventListener('message', ev => {
      if (ev.data === 'daftar-ping' && ev.source) ev.source.postMessage('daftar-modern');
    });
    try { navigator.serviceWorker.startMessages(); } catch (_) {}
    navigator.serviceWorker.register('sw.js').then(reg => {
      /* الآيفون يُبقي التطبيق مفتوحًا في الخلفية، فيُسأل عن إصدار جديد كلما عاد للواجهة */
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
      return navigator.serviceWorker.ready;
    }).then(() => caches.match('index.html')).then(hit => offlineStatus(!!hit)).catch(() => offlineStatus(false));
    /* وصل إصدار جديد: تُعاد الصفحة مرة واحدة فيظهر من الفتحة نفسها، لا في الفتحة التالية.
       لا تُعاد أثناء الكتابة أو والمحرّر مفتوح أو عناصر بانتظار المراجعة؛ تنتظر إلى أن يفرغ أو يُغلق التطبيق. */
    const busy = () => authNet.busy > 0 || Date.now() - authNet.last < 3000 || !!document.querySelector('input:focus, textarea:focus, select:focus, [data-act="e-save"], #review [data-act="p-add"]');
    let reloading = false;
    /* بعد إعادة التحميل يُقال للمستخدم إن التحديث وصل، فلا يحتاج أن يغلق ويفتح ليتأكد */
    function markUpdated() { try { sessionStorage.setItem('daftar-updated', '1'); } catch (_) {} }
    try { if (sessionStorage.getItem('daftar-updated')) { sessionStorage.removeItem('daftar-updated'); setTimeout(() => toast('✓ وصل تحديث جديد للدفتر'), 900); } } catch (_) {}
    const reloadSoon = () => {
      if (reloading) return;
      if (busy()) { setTimeout(reloadSoon, 4000); return; }
      reloading = true; markUpdated(); location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadSW) return; // أول تثبيت: الصفحة جديدة أصلًا
      if (document.visibilityState === 'hidden' && authNet.busy === 0) { reloading = true; markUpdated(); location.reload(); } else reloadSoon();
    });
  } else offlineStatus(false);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* الآيفون يحفظ نسخة مستقلة لكل طريقة فتح (سفاري، رابط داخل تطبيق، أيقونة الشاشة الرئيسية)،
     والأيقونة وحدها تفتح بلا إنترنت بثبات. فيُنبَّه حين يُفتح من غيرها، ويُطمأن مرة حين تجهز الأيقونة. */
  function offlineStatus(ready) {
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const ss = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (_) {} };
    const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (_) {} };
    let msg = '', sticky = false;
    if (!standalone && !ss('daftar-open-hint')) { ss('daftar-open-hint', '1'); sticky = true;
      msg = 'للعمل بلا إنترنت افتح الدفتر من أيقونته على الشاشة الرئيسية، لا من رابط أو من سفاري.'; }
    else if (standalone && ready && !ls('daftar-offline-ok')) { ls('daftar-offline-ok', '1');
      msg = '✓ الدفتر محفوظ على جوالك ويفتح بلا إنترنت.'; }
    if (!msg) return;
    const show = () => {
      const st = document.createElement('style');
      st.textContent = `#offhint{position:fixed;inset-inline:12px;bottom:calc(92px + var(--navgap,80px));z-index:2147483001;max-width:536px;margin:0 auto;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;background:var(--surface,#fff);color:var(--fg,#1D1828);border:1px solid var(--line,#E3E0EA);box-shadow:0 8px 28px rgba(20,10,45,.18);font:500 14px/1.6 var(--f-body,system-ui)}
#offhint p{margin:0;flex:1}#offhint button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:8px 12px;min-height:40px;background:var(--brand,#522D8E);color:#fff}`;
      document.head.appendChild(st);
      const d = document.createElement('div'); d.id = 'offhint'; d.setAttribute('dir', 'rtl'); d.setAttribute('role', 'status');
      d.innerHTML = '<p></p><button type="button">فهمت</button>'; d.querySelector('p').textContent = msg;
      d.querySelector('button').onclick = () => d.remove(); document.body.appendChild(d);
      if (!sticky) setTimeout(() => d.remove(), 5000);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }
})();
