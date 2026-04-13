alter table public.revision_decisions
  add column model_name text,
  add column request_purpose text,
  add column output_used_in_recommendation boolean not null default false;
