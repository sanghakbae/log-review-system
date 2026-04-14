drop policy if exists "Service names manageable by authenticated users" on public.lr_service_names;
drop policy if exists "Service names manageable by admin" on public.lr_service_names;

create policy "Service names manageable by admin"
on public.lr_service_names
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
