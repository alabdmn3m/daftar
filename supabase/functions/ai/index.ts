// دفتر المهام — دالة الفهم الذكي: تمرّر طلب الدفتر إلى Claude (Anthropic) ومفتاح الـAPI محفوظ هنا في الخادم لا في الجوال.
// الطلب: POST { prompt, json?, tier?: 'quick'|'default', stream?, maxTokens? } مع جلسة المستخدم في Authorization.
// الأسرار: ANTHROPIC_API_KEY (إلزامي)، AI_MODEL_QUICK و AI_MODEL_DEFAULT (اختياريان لتغيير النموذج دون تعديل التطبيق).

const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SB_ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const MODEL_QUICK = Deno.env.get('AI_MODEL_QUICK') || 'claude-haiku-5-5';
const MODEL_DEFAULT = Deno.env.get('AI_MODEL_DEFAULT') || 'claude-sonnet-5-5';
const ANTHROPIC = Deno.env.get('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_ALLOWED = 405;
const HTTP_TOO_MANY = 429;
const HTTP_BAD_GATEWAY = 502;
const HTTP_UNAVAILABLE = 503;
const HTTP_OVERLOADED = 529;
const HTTP = {
  ok: HTTP_OK, badRequest: HTTP_BAD_REQUEST, unauthorized: HTTP_UNAUTHORIZED, notAllowed: HTTP_NOT_ALLOWED,
  tooMany: HTTP_TOO_MANY, badGateway: HTTP_BAD_GATEWAY, unavailable: HTTP_UNAVAILABLE,
} as const;
const PROMPT_MAX_CHARS = 60000;
const JSON_TOKENS = 4000;
const TEXT_TOKENS = 2500;
const MIN_TOKENS = 256;
const MAX_TOKENS = 8000;
const LIMITS = { promptChars: PROMPT_MAX_CHARS, jsonTokens: JSON_TOKENS, textTokens: TEXT_TOKENS, minTokens: MIN_TOKENS, maxTokens: MAX_TOKENS } as const;
// حالات Anthropic التي تعني زحمة أو حدًّا، والتي تعني أن المفتاح غير صالح
const BUSY_STATUSES = new Set([HTTP_TOO_MANY, HTTP_OVERLOADED]);
const KEY_STATUSES = new Set([HTTP_UNAUTHORIZED, HTTP_FORBIDDEN]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (o: unknown, status: number = HTTP.ok) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

interface AiRequest { prompt?: unknown; json?: unknown; tier?: unknown; stream?: unknown; maxTokens?: unknown }
interface ContentBlock { type: string; text?: string }
interface AnthropicMessage { content?: ContentBlock[]; stop_reason?: string }

// يتحقق من جلسة الدخول عند Supabase نفسها، فلا يستعمل الدالة إلا صاحب حساب في الدفتر
async function userOf(req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { Authorization: auth, apikey: SB_ANON } }).catch(() => null);
  if (!r || !r.ok) return null;
  const u: { id?: string } | null = await r.json().catch(() => null);
  return u?.id ?? null;
}

function upstreamCode(status: number): string {
  if (BUSY_STATUSES.has(status)) return 'rate_limited';
  if (KEY_STATUSES.has(status)) return 'not_configured';
  return 'unavailable';
}

const JSON_RULE = 'أجب بكائن JSON صالح فقط، دون أي نص قبله أو بعده ودون علامات ```.';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ code: 'bad_request' }, HTTP.notAllowed);
  if (!KEY) return reply({ code: 'not_configured' }, HTTP.unavailable);
  if (!(await userOf(req))) return reply({ code: 'session_expired' }, HTTP.unauthorized);

  const body: AiRequest | null = await req.json().catch(() => null);
  const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
  if (!body || !prompt || prompt.length > LIMITS.promptChars) return reply({ code: 'bad_request' }, HTTP.badRequest);
  const wantJson = body.json === true;
  const stream = body.stream === true && !wantJson;
  const asked = Number(body.maxTokens) || (wantJson ? LIMITS.jsonTokens : LIMITS.textTokens);
  const payload: Record<string, unknown> = {
    model: body.tier === 'quick' ? MODEL_QUICK : MODEL_DEFAULT,
    max_tokens: Math.min(Math.max(asked, LIMITS.minTokens), LIMITS.maxTokens),
    messages: [{ role: 'user', content: prompt }],
    stream,
  };
  if (wantJson) payload.system = JSON_RULE;

  const r = await fetch(`${ANTHROPIC}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!r) return reply({ code: 'unavailable' }, HTTP.badGateway);
  if (!r.ok) {
    const status = r.status === HTTP.tooMany ? HTTP.tooMany : HTTP.badGateway;
    return reply({ code: upstreamCode(r.status) }, status);
  }
  // البث: تمرّر أحداث Anthropic كما هي ليكتب الدفتر المسودة وهي تُكتب
  if (stream) return new Response(r.body, { headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });

  const m: AnthropicMessage | null = await r.json().catch(() => null);
  if (!m) return reply({ code: 'unavailable' }, HTTP.badGateway);
  if (m.stop_reason === 'refusal') return reply({ code: 'refused' });
  const text = (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  return reply({ text, truncated: m.stop_reason === 'max_tokens' });
});
