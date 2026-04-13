alter table public.lr_profiles
add column if not exists review_prompt_slots jsonb not null default '[]'::jsonb;

alter table public.lr_profiles
add column if not exists review_prompt_selected_slot smallint not null default 0;

alter table public.lr_profiles
drop constraint if exists lr_profiles_review_prompt_selected_slot_check;

alter table public.lr_profiles
add constraint lr_profiles_review_prompt_selected_slot_check
check (review_prompt_selected_slot between 0 and 9);
