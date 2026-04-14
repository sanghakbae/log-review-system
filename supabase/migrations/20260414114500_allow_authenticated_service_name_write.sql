drop policy if exists "Service names manageable by admin" on public.lr_service_names;
drop policy if exists "Service names manageable by authenticated users" on public.lr_service_names;

create policy "Service names manageable by authenticated users"
on public.lr_service_names
for all
to authenticated
using (auth.role() = 'authenticated')
with check (auth.role() = 'authenticated');
