create table if not exists public.lr_review_prompt_settings (
  id text primary key default 'default',
  review_prompt_text text not null default '',
  review_prompt_slots jsonb not null default '[]'::jsonb,
  review_prompt_selected_slot smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lr_review_prompt_settings enable row level security;

drop policy if exists "Review prompt settings readable by authenticated users" on public.lr_review_prompt_settings;
drop policy if exists "Review prompt settings manageable by admin" on public.lr_review_prompt_settings;

create policy "Review prompt settings readable by authenticated users"
on public.lr_review_prompt_settings
for select
to authenticated
using (auth.role() = 'authenticated');

create policy "Review prompt settings manageable by admin"
on public.lr_review_prompt_settings
for all
to authenticated
using (
  exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
)
with check (
  exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

with source as (
  select
    review_prompt_text,
    review_prompt_slots,
    review_prompt_selected_slot
  from public.lr_profiles
  where coalesce(trim(review_prompt_text), '') <> ''
    or review_prompt_slots <> '[]'::jsonb
  order by updated_at desc
  limit 1
)
insert into public.lr_review_prompt_settings (
  id,
  review_prompt_text,
  review_prompt_slots,
  review_prompt_selected_slot,
  updated_at
)
select
  'default',
  coalesce((select review_prompt_text from source), '너는 범용 업무 검토 분석가다.'),
  coalesce(
    (select review_prompt_slots from source),
    jsonb_build_array(coalesce((select review_prompt_text from source), '너는 범용 업무 검토 분석가다.'))
  ),
  coalesce((select review_prompt_selected_slot from source), 0),
  now()
on conflict (id) do update
set review_prompt_text = excluded.review_prompt_text,
    review_prompt_slots = excluded.review_prompt_slots,
    review_prompt_selected_slot = excluded.review_prompt_selected_slot,
    updated_at = excluded.updated_at;
