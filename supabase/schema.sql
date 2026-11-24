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
