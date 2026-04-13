create policy "Profiles insert by self"
on public.lr_profiles
for insert
to authenticated
with check (
  auth.uid() = id
  or exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);
