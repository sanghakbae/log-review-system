drop policy if exists "Profiles readable by self or admin" on public.lr_profiles;
drop policy if exists "Profiles readable by authenticated users" on public.lr_profiles;

create policy "Profiles readable by authenticated users"
on public.lr_profiles
for select
to authenticated
using (auth.role() = 'authenticated');
