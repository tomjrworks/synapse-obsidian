-- Taproot Stage 1 — Storage bucket + RLS for vault-blobs
-- Private bucket; one folder per workspace; ciphertext blobs only.
-- Helper writes via service role (bypasses these policies). These policies guard
-- the dashboard's signed-URL fetches in Stage 3.

insert into storage.buckets (id, name, public)
values ('vault-blobs', 'vault-blobs', false)
on conflict (id) do nothing;

create policy "vault_blobs_read"
  on storage.objects for select
  using (
    bucket_id = 'vault-blobs'
    and (storage.foldername(name))[1]::uuid in (
      select workspace_id from workspace_members where user_id = auth.uid()
    )
  );

create policy "vault_blobs_write"
  on storage.objects for insert
  with check (
    bucket_id = 'vault-blobs'
    and (storage.foldername(name))[1]::uuid in (
      select workspace_id from workspace_members where user_id = auth.uid()
    )
  );

create policy "vault_blobs_update"
  on storage.objects for update
  using (
    bucket_id = 'vault-blobs'
    and (storage.foldername(name))[1]::uuid in (
      select workspace_id from workspace_members where user_id = auth.uid()
    )
  );

create policy "vault_blobs_delete"
  on storage.objects for delete
  using (
    bucket_id = 'vault-blobs'
    and (storage.foldername(name))[1]::uuid in (
      select workspace_id from workspace_members where user_id = auth.uid()
    )
  );
