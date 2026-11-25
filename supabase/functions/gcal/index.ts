// دفتر المهام — دالة تقويم Google: ربط مباشر بحساب Google، ومفتاح التجديد محفوظ في الخادم وحده.
// المسارات:
//   POST {action:'start', returnTo}            → رابط موافقة Google
//   GET  /gcal/callback?code&state             → يحفظ مفتاح التجديد ويعود للدفتر
//   POST {action:'status'|'disconnect'}
//   POST {action:'call', tool, args, tz}       → create_event | update_event | delete_event (بنفس شكل موصل Claude)
// الأسرار: GOOGLE_CLIENT_ID، GOOGLE_CLIENT_SECRET، APP_URL (رابط الدفتر). تُنشر الدالة مع إيقاف «Verify JWT» لأن عودة Google لا تحمل جلسة؛ والتحقق من الجلسة يجري هنا.

const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '';
const APP_URL = Deno.env.get('APP_URL') || 'https://alabdmn3m.github.io/daftar/';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = Deno.env.get('GOOGLE_TOKEN_URL') || 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const CAL_API = Deno.env.get('GOOGLE_CAL_API') || 'https://www.googleapis.com/calendar/v3';
const SCOPES = 'openid email https://www.googleapis.com/auth/calendar.events';
const CALLBACK = `${SB_URL}/functions/v1/gcal/callback`;

const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_SERVER_ERROR = 500;
const HTTP_UNAVAILABLE = 503;
const STATE_TTL_MS = 600000;
const TOKEN_MARGIN_MS = 60000;
const MS_PER_S = 1000;
const MESSAGE_MAX = 160;
const DATE_LEN = 10; // طول «2026-11-25»

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const reply = (o: unknown, status: number = HTTP_OK) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

interface Reminder { method?: string; minutes?: number }
interface ToolArgs {
  eventId?: string; summary?: string; description?: string; location?: string;
  startTime?: string; endTime?: string; timeZone?: string; allDay?: boolean;
  recurrenceData?: string[]; useDefaultReminders?: boolean; overrideReminders?: Reminder[]; availability?: string;
}
interface CallRequest { action?: string; tool?: string; args?: ToolArgs; tz?: string; returnTo?: string }
interface TokenRow { user_id: string; refresh_token: string; email: string | null }
interface GoogleToken { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string }
class ToolError { constructor(public code: string, public message = '', public status = HTTP_OK) {} }

// ---------- الجلسة والتخزين ----------
async function userOf(req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { Authorization: auth, apikey: SB_ANON } }).catch(() => null);
  if (!r || !r.ok) return null;
  const u: { id?: string } | null = await r.json().catch(() => null);
  return u?.id ?? null;
}
const db = (path: string, init: RequestInit = {}) => fetch(`${SB_URL}/rest/v1/${path}`, {
  ...init,
  headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
});
async function tokenRow(uid: string): Promise<TokenRow | null> {
  const r = await db(`gcal_tokens?user_id=eq.${uid}&select=user_id,refresh_token,email`);
  const rows: TokenRow[] = r.ok ? await r.json() : [];
  return rows[0] ?? null;
}

// ---------- ختم «state» حتى لا يربط أحد حسابه بحساب غيره ----------
const enc = new TextEncoder();
// ترميز base64 الصالح للروابط: «+» تصير «-» و«/» تصير «_» ويُحذف الحشو «=» من آخره
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll('+', '-').replaceAll('/', '_').split('=')[0];
const fromB64url = (s: string) => atob(s.replaceAll('-', '+').replaceAll('_', '/'));
async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(SB_SERVICE + ':gcal-state'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))));
}
async function sealState(o: Record<string, unknown>): Promise<string> {
  const data = b64url(enc.encode(JSON.stringify(o)));
  return `${data}.${await hmac(data)}`;
}
async function openState(s: string): Promise<{ u: string; exp: number; ret: string } | null> {
  const [data, sig] = s.split('.');
  if (!data || !sig || sig !== (await hmac(data))) return null;
  try {
    const o = JSON.parse(fromB64url(data));
    return o && o.exp > Date.now() ? o : null;
  } catch { return null; }
}
const safeReturn = (u: unknown) => (typeof u === 'string' && u.startsWith(APP_URL) ? u.split('#')[0] : APP_URL);

// ---------- مفاتيح Google ----------
const cache = new Map<string, { token: string; until: number }>();
async function accessToken(uid: string): Promise<string> {
  const hit = cache.get(uid);
  if (hit && hit.until > Date.now()) return hit.token;
  const row = await tokenRow(uid);
  if (!row) throw new ToolError('server_not_connected');
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: row.refresh_token, grant_type: 'refresh_token' }),
  }).catch(() => null);
  if (!r) throw new ToolError('server_unavailable');
  const t: GoogleToken = await r.json().catch(() => ({}));
  if (t.error === 'invalid_grant') throw new ToolError('needs_reauth');
  if (!r.ok || !t.access_token) throw new ToolError('server_unavailable');
  cache.set(uid, { token: t.access_token, until: Date.now() + (t.expires_in ?? 0) * MS_PER_S - TOKEN_MARGIN_MS });
  return t.access_token;
}

// ---------- تحويل مدخلات الموصل إلى حدث Google ----------
function toGoogle(a: ToolArgs, tz: string, partial: boolean): Record<string, unknown> {
  const ev: Record<string, unknown> = {};
  (['summary', 'description', 'location'] as const).filter((k) => typeof a[k] === 'string').forEach((k) => { ev[k] = a[k]; });
  const zone = a.timeZone || tz;
  if (a.startTime) ev.start = a.allDay ? { date: a.startTime.slice(0, DATE_LEN) } : { dateTime: a.startTime, timeZone: zone };
  if (a.endTime) ev.end = a.allDay ? { date: a.endTime.slice(0, DATE_LEN) } : { dateTime: a.endTime, timeZone: zone };
  if (Array.isArray(a.recurrenceData)) ev.recurrence = a.recurrenceData;
  if (Array.isArray(a.overrideReminders) || typeof a.useDefaultReminders === 'boolean') {
    const overrides = (a.overrideReminders ?? []).map((r) => ({ method: r.method === 'email' ? 'email' : 'popup', minutes: Number(r.minutes) || 0 }));
    ev.reminders = { useDefault: a.useDefaultReminders === true && !overrides.length, overrides };
  }
  if (a.availability === 'AVAILABILITY_FREE') ev.transparency = 'transparent';
  if (a.availability === 'AVAILABILITY_BUSY') ev.transparency = 'opaque';
  if (!partial && !ev.reminders) ev.reminders = { useDefault: true };
  return ev;
}

async function google(uid: string, path: string, init: RequestInit): Promise<Response> {
  const go = async (): Promise<Response | null> => {
    const token = await accessToken(uid);
    try {
      return await fetch(`${CAL_API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    } catch { return null; }
  };
  let r = await go();
  if (r && r.status === HTTP_UNAUTHORIZED) { cache.delete(uid); r = await go(); }
  if (!r) throw new ToolError('server_unavailable');
  if (r.status === HTTP_UNAUTHORIZED) throw new ToolError('needs_reauth');
  return r;
}
async function failWith(r: Response): Promise<never> {
  if (r.status >= HTTP_SERVER_ERROR) throw new ToolError('server_unavailable');
  const e: { error?: { message?: string } } = await r.json().catch(() => ({}));
  const msg = `${e.error?.message ?? 'error'} (${r.status})`.slice(0, MESSAGE_MAX);
  throw new ToolError('tool_error', r.status === HTTP_NOT_FOUND || r.status === HTTP_GONE ? `Not Found ${msg}` : msg);
}
const evPath = (id: string) => `/calendars/primary/events/${encodeURIComponent(id)}`;

async function callTool(uid: string, tool: string, a: ToolArgs, tz: string): Promise<unknown> {
  if (tool === 'create_event') {
    const ev = toGoogle(a, tz, false);
    if (a.eventId) ev.id = a.eventId; // رقم يولّده الجوال: يجعل الإعادة بعد انقطاع آمنة بلا تكرار
    const r = await google(uid, '/calendars/primary/events', { method: 'POST', body: JSON.stringify(ev) });
    if (r.status === HTTP_CONFLICT && a.eventId) return { payload: { id: a.eventId } };
    if (!r.ok) return failWith(r);
    const out: { id?: string; htmlLink?: string } = await r.json();
    return { payload: { id: out.id, htmlLink: out.htmlLink } };
  }
  if (!a.eventId) throw new ToolError('tool_error', 'eventId missing');
  if (tool === 'update_event') {
    const r = await google(uid, evPath(a.eventId), { method: 'PATCH', body: JSON.stringify(toGoogle(a, tz, true)) });
    if (!r.ok) return failWith(r);
    return { payload: { id: a.eventId } };
  }
  if (tool === 'delete_event') {
    const r = await google(uid, evPath(a.eventId), { method: 'DELETE' });
    if (!r.ok) return failWith(r);
    return { payload: { id: a.eventId, deleted: true } };
  }
  throw new ToolError('tool_error', `unknown tool ${tool}`);
}

// ---------- المسارات ----------
async function callback(url: URL): Promise<Response> {
  const back = (ret: string, tag: string) => new Response(null, { status: HTTP_FOUND, headers: { Location: `${ret}#gcal=${tag}` } });
  const st = await openState(url.searchParams.get('state') || '');
  if (!st) return back(APP_URL, 'expired');
  const code = url.searchParams.get('code');
  if (!code) return back(st.ret, 'denied');
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: CALLBACK, grant_type: 'authorization_code' }),
  }).catch(() => null);
  const t: GoogleToken = r ? await r.json().catch(() => ({})) : {};
  if (!t.refresh_token) return back(st.ret, 'failed');
  let email: string | null = null;
  try { email = JSON.parse(fromB64url((t.id_token ?? '').split('.')[1] ?? '')).email ?? null; } catch { email = null; }
  const saved = await db('gcal_tokens?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ user_id: st.u, refresh_token: t.refresh_token, email, updated_at: new Date().toISOString() }),
  });
  cache.delete(st.u);
  return back(st.ret, saved.ok ? 'ok' : 'failed');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname.endsWith('/callback')) return callback(url);
  if (req.method !== 'POST') return reply({ code: 'bad_request' }, HTTP_BAD_REQUEST);
  if (!CLIENT_ID || !CLIENT_SECRET) return reply({ code: 'not_configured' }, HTTP_UNAVAILABLE);
  const uid = await userOf(req);
  if (!uid) return reply({ code: 'session_expired' }, HTTP_UNAUTHORIZED);
  const body: CallRequest = await req.json().catch(() => ({}));

  if (body.action === 'start') {
    const state = await sealState({ u: uid, exp: Date.now() + STATE_TTL_MS, ret: safeReturn(body.returnTo) });
    const q = new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: CALLBACK, response_type: 'code', scope: SCOPES,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    });
    return reply({ url: `${GOOGLE_AUTH}?${q}` });
  }
  if (body.action === 'status') {
    const row = await tokenRow(uid);
    return reply({ connected: !!row, email: row?.email ?? null });
  }
  if (body.action === 'disconnect') {
    const row = await tokenRow(uid);
    if (row) {
      await fetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(row.refresh_token)}`, { method: 'POST' }).catch(() => null);
      await db(`gcal_tokens?user_id=eq.${uid}`, { method: 'DELETE' });
    }
    cache.delete(uid);
    return reply({ connected: false });
  }
  if (body.action === 'call') {
    try {
      return reply(await callTool(uid, String(body.tool), body.args ?? {}, body.tz || 'Asia/Riyadh'));
    } catch (e) {
      if (e instanceof ToolError) return reply({ error: { code: e.code, message: e.message } }, HTTP_OK);
      return reply({ error: { code: 'server_unavailable', message: String(e).slice(0, MESSAGE_MAX) } }, HTTP_OK);
    }
  }
  return reply({ code: 'bad_request' }, HTTP_FORBIDDEN);
});
