create policy "Requests delete by admin"
on public.lr_review_requests
for delete
to authenticated
using (
  exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

create policy "Results delete by admin"
on public.lr_review_results
for delete
to authenticated
using (
  exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

create policy "Logs delete by admin"
on public.lr_review_logs
for delete
to authenticated
using (
  exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);
