-- Allow pending applicants to submit their own application while remaining inactive.
-- Existing profile-protection trigger preserves role, status, active, rank, department and permissions.
begin;
drop policy if exists "profile self update application" on public.profiles;
create policy "profile self update application"
  on public.profiles for update to authenticated
  using (
    id=auth.uid()
    and role <> 'admin'
    and status in ('pending','rejected')
  )
  with check (
    id=auth.uid()
    and role='officer'
    and status='pending'
  );
commit;
