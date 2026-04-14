alter table public.lr_profiles
drop column if exists review_prompt_text,
drop column if exists review_prompt_slots,
drop column if exists review_prompt_selected_slot;
