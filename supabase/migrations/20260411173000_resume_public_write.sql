drop policy if exists "authenticated users can create their own resume workspace" on public.resume_workspaces;
drop policy if exists "authenticated editor can update resume workspace" on public.resume_workspaces;
drop policy if exists "authenticated upload resume assets" on storage.objects;
drop policy if exists "authenticated update resume assets" on storage.objects;
create policy "public create resume workspace"
on public.resume_workspaces
for insert
to public
with check (true);
create policy "public update resume workspace"
on public.resume_workspaces
for update
to public
using (true)
with check (true);
create policy "public upload resume assets"
on storage.objects
for insert
to public
with check (bucket_id = 'resume-assets');
create policy "public update resume assets"
on storage.objects
for update
to public
using (bucket_id = 'resume-assets')
with check (bucket_id = 'resume-assets');
