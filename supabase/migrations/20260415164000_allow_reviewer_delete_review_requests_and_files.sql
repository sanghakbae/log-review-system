drop policy if exists "Requests delete by admin" on public.lr_review_requests;
create policy "Requests delete by reviewer or admin"
on public.lr_review_requests
for delete
to authenticated
using (
  exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role in ('reviewer', 'admin')
  )
);

drop policy if exists "Results delete by admin" on public.lr_review_results;
create policy "Results delete by reviewer or admin"
on public.lr_review_results
for delete
to authenticated
using (
  exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role in ('reviewer', 'admin')
  )
);

drop policy if exists "Logs delete by admin" on public.lr_review_logs;
create policy "Logs delete by reviewer or admin"
on public.lr_review_logs
for delete
to authenticated
using (
  exists (
    select 1
    from public.lr_profiles p
    where p.id = auth.uid()
      and p.role in ('reviewer', 'admin')
  )
);

drop policy if exists "authenticated delete review uploads" on storage.objects;
create policy "authenticated delete review uploads"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'review-uploads'
  and (
    auth.uid()::text = (storage.foldername(name))[1]
    or exists (
      select 1
      from public.lr_profiles p
      where p.id = auth.uid()
        and p.role in ('reviewer', 'admin')
    )
  )
);
