-- دفتر المهام: جداول البيانات (تُلصق كما هي في SQL Editor ثم Run)
create table public.items (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index items_sync on public.items (user_id, updated_at);
alter table public.items enable row level security;
create policy "own items" on public.items for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.meta (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  key text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.meta enable row level security;
create policy "own meta" on public.meta for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create trigger items_touch before update on public.items
  for each row execute function public.touch_updated_at();
create trigger meta_touch before update on public.meta
  for each row execute function public.touch_updated_at();

-- ---------- المرحلة 3: مفتاح تجديد تقويم Google ----------
-- يقرؤه ويكتبه الخادم وحده (دالة gcal بمفتاح الخدمة). القواعد مفعّلة بلا أي سياسة، فلا يصل إليه الجوال ولا أي مستخدم.
create table if not exists public.gcal_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  email text,
  updated_at timestamptz not null default now()
);
alter table public.gcal_tokens enable row level security;
revoke all on public.gcal_tokens from anon, authenticated;

-- ---------- ودجت الآيفون: رمز للقراءة فقط ----------
-- الدفتر يحفظ بصمة الرمز (لا الرمز نفسه)، والودجت يرسل الرمز فيعود له صف meta «widget» وحده.
create table if not exists public.widget_keys (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  key_hash text not null unique,
  created_at timestamptz not null default now()
);
alter table public.widget_keys enable row level security;
create policy "own widget key" on public.widget_keys for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.widget_feed(k text) returns jsonb
language sql stable security definer set search_path = public as $$
  select m.data from public.widget_keys w
  join public.meta m on m.user_id = w.user_id and m.key = 'widget'
  where length(k) >= 32 and w.key_hash = encode(sha256(convert_to(k, 'UTF8')), 'hex')
  limit 1;
$$;
revoke all on function public.widget_feed(text) from public;
grant execute on function public.widget_feed(text) to anon, authenticated;
