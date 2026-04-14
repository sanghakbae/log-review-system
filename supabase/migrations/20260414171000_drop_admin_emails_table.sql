drop trigger if exists trg_set_profile_role_from_admin_emails on public.lr_profiles;
drop function if exists public.set_profile_role_from_admin_emails();
drop table if exists public.lr_admin_emails;
