create table if not exists public.lr_review_prompt_scripts (
  slot_index smallint primary key,
  title text not null,
  prompt_script text not null default '',
  is_selected boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lr_review_prompt_scripts enable row level security;

drop policy if exists "Review prompt scripts readable by authenticated users" on public.lr_review_prompt_scripts;
drop policy if exists "Review prompt scripts manageable by admin" on public.lr_review_prompt_scripts;

create policy "Review prompt scripts readable by authenticated users"
on public.lr_review_prompt_scripts
for select
to authenticated
using (auth.role() = 'authenticated');

create policy "Review prompt scripts manageable by admin"
on public.lr_review_prompt_scripts
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

with prompt_source as (
  select
    review_prompt_slots,
    review_prompt_selected_slot
  from public.lr_review_prompt_settings
  where id = 'default'
),
expanded as (
  select
    ordinality - 1 as slot_index,
    value::text as prompt_script,
    (ordinality - 1) = coalesce((select review_prompt_selected_slot from prompt_source), 0) as is_selected
  from prompt_source,
  jsonb_array_elements_text(coalesce((select review_prompt_slots from prompt_source), '[]'::jsonb)) with ordinality
)
insert into public.lr_review_prompt_scripts (
  slot_index,
  title,
  prompt_script,
  is_selected,
  updated_at
)
select
  slot_index,
  concat('프롬프트 ', slot_index + 1),
  prompt_script,
  is_selected,
  now()
from expanded
on conflict (slot_index) do update
set title = excluded.title,
    prompt_script = excluded.prompt_script,
    is_selected = excluded.is_selected,
    updated_at = excluded.updated_at;
