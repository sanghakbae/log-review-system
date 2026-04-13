insert into storage.buckets (id, name, public)
values ('review-uploads', 'review-uploads', false)
on conflict (id) do nothing;

drop policy if exists "authenticated upload review uploads" on storage.objects;
create policy "authenticated upload review uploads"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'review-uploads'
  and auth.uid()::text = (storage.foldername(name))[1]
);

drop policy if exists "authenticated read review uploads" on storage.objects;
create policy "authenticated read review uploads"
on storage.objects
for select
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
