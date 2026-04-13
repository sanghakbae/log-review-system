do $$
begin
  if to_regclass('public.review_requests') is not null and to_regclass('public.lr_review_requests') is null then
    execute 'alter table public.review_requests rename to lr_review_requests';
  end if;

  if to_regclass('public.review_attachments') is not null and to_regclass('public.lr_review_attachments') is null then
    execute 'alter table public.review_attachments rename to lr_review_attachments';
  end if;

  if to_regclass('public.review_results') is not null and to_regclass('public.lr_review_results') is null then
    execute 'alter table public.review_results rename to lr_review_results';
  end if;

  if to_regclass('public.review_logs') is not null and to_regclass('public.lr_review_logs') is null then
    execute 'alter table public.review_logs rename to lr_review_logs';
  end if;

  if to_regclass('public.profiles') is not null and to_regclass('public.lr_profiles') is null then
    execute 'alter table public.profiles rename to lr_profiles';
  end if;
end;
$$;
