create policy "Logs insert by reviewer or admin"
on public.lr_review_logs
for insert
to authenticated
with check (
  exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role in ('reviewer', 'admin')
  )
);
