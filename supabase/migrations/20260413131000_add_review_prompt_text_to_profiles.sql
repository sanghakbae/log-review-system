alter table public.lr_profiles
add column if not exists review_prompt_text text;
