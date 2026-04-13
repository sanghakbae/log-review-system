drop policy if exists "policy owners can delete documents" on public.policy_documents;
create policy "policy owners can delete documents"
  on public.policy_documents
  for delete
  using (owner_user_id = auth.uid());
drop policy if exists "policy owners can delete sections" on public.policy_document_sections;
create policy "policy owners can delete sections"
  on public.policy_document_sections
  for delete
  using (
    exists (
      select 1
      from public.policy_document_versions dv
      join public.policy_documents d on d.id = dv.document_id
      where dv.id = policy_document_sections.document_version_id
        and d.owner_user_id = auth.uid()
    )
  );
drop policy if exists "policy owners can update versions" on public.policy_document_versions;
create policy "policy owners can update versions"
  on public.policy_document_versions
  for update
  using (
    exists (
      select 1
      from public.policy_documents d
      where d.id = policy_document_versions.document_id
        and d.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.policy_documents d
      where d.id = policy_document_versions.document_id
        and d.owner_user_id = auth.uid()
    )
  );
