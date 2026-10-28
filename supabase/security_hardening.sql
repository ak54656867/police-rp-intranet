-- Security hardening for the existing Police RP Intranet Supabase project.
-- Run this file once in Supabase SQL Editor after reviewing it.
begin;

-- The frontend onboarding flow expects these profile fields. Keep new users pending
-- and prevent users from approving themselves or granting themselves a privileged role.
alter table public.profiles
  add column if not exists status text not null default 'pending',
  add column if not exists roblox_username text,
  add column if not exists requested_rank text,
  add column if not exists requested_department text,
  add column if not exists application_submitted boolean not null default false,
  add column if not exists permissions jsonb not null default '[]'::jsonb;

alter table public.profiles
  drop constraint if exists profiles_status_check;
alter table public.profiles
  add constraint profiles_status_check check (status in ('pending','approved','rejected','suspended','dismissed'));

-- Allow rejected applicants to resubmit through the existing application form.
create or replace function public.reopen_rejected_application()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status='rejected'
     and old.role='officer'
     and new.application_submitted=true
     and auth.uid()=old.id then
    new.status='pending';
    new.active=true;
  end if;
  return new;
end;
$$;

drop trigger if exists reopen_rejected_application_trigger on public.profiles;
create trigger reopen_rejected_application_trigger
  before update on public.profiles
  for each row execute function public.reopen_rejected_application();

drop policy if exists "applicant update own pending profile" on public.profiles;
drop policy if exists "profile self update application" on public.profiles;
create policy "profile self update application"
  on public.profiles for update to authenticated
  using (
    id=auth.uid()
    and role='officer'
    and status in ('pending','rejected')
  )
  with check (
    id=auth.uid()
    and role='officer'
    and status='pending'
    and active in (true,false)
  );

-- Enforce basic data invariants at the database layer, not only in forms.
alter table public.profiles
  drop constraint if exists profiles_permissions_array_check;
alter table public.profiles
  add constraint profiles_permissions_array_check
  check (jsonb_typeof(permissions)='array');

alter table public.leave_requests
  drop constraint if exists leave_dates_order_check;
alter table public.leave_requests
  add constraint leave_dates_order_check
  check (end_date >= start_date);

alter table public.attendance
  drop constraint if exists attendance_checkout_after_checkin;
alter table public.attendance
  add constraint attendance_checkout_after_checkin
  check (check_out is null or check_out >= check_in);

-- The frontend sync list contains modules omitted from the original database constraint.
alter table public.shared_records
  drop constraint if exists shared_records_module_check;
alter table public.shared_records
  add constraint shared_records_module_check
  check (module in (
    'personnel','attendance','incidents','wanted','dispatch','leave','assets',
    'notices','documents','audit','fines','departments','positions','orgPermissions'
  ));

create or replace function public.can_access_intranet()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.active = true
      and (p.status = 'approved' or p.role = 'admin')
  );
$$;

drop policy if exists "profile read own or managers" on public.profiles;
create policy "profile read own or approved managers"
  on public.profiles for select to authenticated
  using (
    id=auth.uid()
    or (public.can_access_intranet() and public.is_staff_manager())
  );

create or replace function public.can_insert_shared_module(p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.current_role() = 'admin' then true
    when p_module in ('departments','positions','orgPermissions') then false
    when public.current_role() in ('chief','department_head','hr_manager') then true
    when public.current_role() = 'officer'
      then p_module in ('attendance','incidents','wanted','dispatch','leave','fines','audit')
    when public.current_role() = 'dispatcher'
      then p_module in ('attendance','incidents','dispatch','leave','audit')
    else false
  end;
$$;

create or replace function public.can_update_shared_module(p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.current_role() = 'admin' then true
    when p_module in ('audit','departments','positions','orgPermissions') then false
    when public.current_role() in ('chief','department_head','hr_manager') then true
    when public.current_role() = 'officer'
      then p_module in ('attendance','incidents','wanted','dispatch','leave','fines')
    when public.current_role() = 'dispatcher'
      then p_module in ('attendance','incidents','dispatch','leave')
    else false
  end;
$$;

create or replace function public.can_delete_shared_module(p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.current_role() = 'admin' then true
    when p_module in ('audit','departments','positions','orgPermissions') then false
    when public.current_role() in ('chief','department_head','hr_manager') then true
    else false
  end;
$$;

revoke all on function public.can_access_intranet() from public;
revoke all on function public.can_insert_shared_module(text) from public;
revoke all on function public.can_update_shared_module(text) from public;
revoke all on function public.can_delete_shared_module(text) from public;
grant execute on function public.can_access_intranet() to authenticated;
grant execute on function public.can_insert_shared_module(text) to authenticated;
grant execute on function public.can_update_shared_module(text) to authenticated;
grant execute on function public.can_delete_shared_module(text) to authenticated;

-- Replace broad policies that previously allowed every authenticated account to
-- read, overwrite, and delete all shared records, including privileged org data.
drop policy if exists "shared records read authenticated" on public.shared_records;
drop policy if exists "shared records insert authenticated" on public.shared_records;
drop policy if exists "shared records update authenticated" on public.shared_records;
drop policy if exists "shared records delete authenticated" on public.shared_records;

create policy "shared records read approved members"
  on public.shared_records for select to authenticated
  using (public.can_access_intranet());

create policy "shared records insert by role"
  on public.shared_records for insert to authenticated
  with check (
    public.can_access_intranet()
    and updated_by=auth.uid()
    and public.can_insert_shared_module(module)
    and (module <> 'audit' or payload->>'userId'=auth.uid()::text)
    and (
      module not in ('attendance','leave')
      or public.current_role() in ('admin','chief','department_head','hr_manager')
      or (module='attendance' and payload->>'userId'=auth.uid()::text and payload->>'out' is null)
      or (module='leave' and payload->>'userId'=auth.uid()::text and payload->>'status'='신청')
    )
  );

create policy "shared records update by role"
  on public.shared_records for update to authenticated
  using (
    public.can_access_intranet()
    and public.can_update_shared_module(module)
    and (
      module not in ('attendance','leave')
      or public.current_role() in ('admin','chief','department_head','hr_manager')
      or (module='attendance' and payload->>'userId'=auth.uid()::text)
      or (module='leave' and payload->>'userId'=auth.uid()::text and payload->>'status'='신청')
    )
  )
  with check (
    public.can_access_intranet()
    and updated_by=auth.uid()
    and public.can_update_shared_module(module)
    and (
      module not in ('attendance','leave')
      or public.current_role() in ('admin','chief','department_head','hr_manager')
      or (module='attendance' and payload->>'userId'=auth.uid()::text)
      or (module='leave' and payload->>'userId'=auth.uid()::text and payload->>'status'='신청')
    )
  );

create policy "shared records delete by role"
  on public.shared_records for delete to authenticated
  using (public.can_access_intranet() and public.can_delete_shared_module(module));


-- Apply the same approval gate to the legacy normalized tables as well.
drop policy if exists "personnel read" on public.personnel;
create policy "personnel read approved" on public.personnel
  for select to authenticated using (public.can_access_intranet());
drop policy if exists "personnel manage" on public.personnel;
create policy "personnel manage by role" on public.personnel
  for all to authenticated
  using (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'))
  with check (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'));

drop policy if exists "attendance read" on public.attendance;
create policy "attendance read approved" on public.attendance
  for select to authenticated using (public.can_access_intranet());
drop policy if exists "attendance insert" on public.attendance;
create policy "attendance insert approved" on public.attendance
  for insert to authenticated
  with check (public.can_access_intranet() and (user_id=auth.uid() or public.current_role() in ('admin','chief','department_head','hr_manager')));
drop policy if exists "attendance update" on public.attendance;
create policy "attendance update approved" on public.attendance
  for update to authenticated
  using (public.can_access_intranet() and (user_id=auth.uid() or public.current_role() in ('admin','chief','department_head','hr_manager')))
  with check (public.can_access_intranet() and (user_id=auth.uid() or public.current_role() in ('admin','chief','department_head','hr_manager')));

drop policy if exists "incident read" on public.incidents;
create policy "incident read approved" on public.incidents
  for select to authenticated using (public.can_access_intranet());
drop policy if exists "incident manage" on public.incidents;
drop policy if exists "incident manage approved" on public.incidents;
drop policy if exists "incident write approved" on public.incidents;
drop policy if exists "incident update approved" on public.incidents;
drop policy if exists "incident delete managers" on public.incidents;
create policy "incident write approved" on public.incidents
  for insert to authenticated
  with check (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','dispatcher','officer'));
create policy "incident update approved" on public.incidents
  for update to authenticated
  using (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','dispatcher','officer'))
  with check (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','dispatcher','officer'));
create policy "incident delete managers" on public.incidents
  for delete to authenticated
  using (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'));
-- Removed legacy broad policy: incident manage approved.


drop policy if exists "wanted read" on public.wanted_persons;
create policy "wanted read approved" on public.wanted_persons
  for select to authenticated using (public.can_access_intranet());
drop policy if exists "wanted manage" on public.wanted_persons;
drop policy if exists "wanted manage approved" on public.wanted_persons;
drop policy if exists "wanted write approved" on public.wanted_persons;
drop policy if exists "wanted update approved" on public.wanted_persons;
drop policy if exists "wanted delete managers" on public.wanted_persons;
create policy "wanted write approved" on public.wanted_persons
  for insert to authenticated
  with check (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','officer'));
create policy "wanted update approved" on public.wanted_persons
  for update to authenticated
  using (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','officer'))
  with check (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','officer'));
create policy "wanted delete managers" on public.wanted_persons
  for delete to authenticated
  using (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'));
-- Removed legacy broad policy: wanted manage approved.


drop policy if exists "dispatch read" on public.dispatches;
create policy "dispatch read approved" on public.dispatches
  for select to authenticated using (public.can_access_intranet());
drop policy if exists "dispatch manage" on public.dispatches;
drop policy if exists "dispatch manage approved" on public.dispatches;
drop policy if exists "dispatch write approved" on public.dispatches;
drop policy if exists "dispatch update approved" on public.dispatches;
drop policy if exists "dispatch delete managers" on public.dispatches;
create policy "dispatch write approved" on public.dispatches
  for insert to authenticated
  with check (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','dispatcher','officer'));
create policy "dispatch update approved" on public.dispatches
  for update to authenticated
  using (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','dispatcher','officer'))
  with check (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','dispatcher','officer'));
create policy "dispatch delete managers" on public.dispatches
  for delete to authenticated
  using (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'));
-- Removed legacy broad policy: dispatch manage approved.


drop policy if exists "leave read own or managers" on public.leave_requests;
create policy "leave read approved own or managers" on public.leave_requests
  for select to authenticated
  using (public.can_access_intranet() and (created_by=auth.uid() or public.current_role() in ('admin','chief','department_head','hr_manager')));
drop policy if exists "leave create own" on public.leave_requests;
create policy "leave create approved own" on public.leave_requests
  for insert to authenticated
  with check (public.can_access_intranet() and created_by=auth.uid() and status='신청' and reviewer_id is null);
drop policy if exists "leave review" on public.leave_requests;
create policy "leave review approved" on public.leave_requests
  for update to authenticated
  using (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'))
  with check (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'));

drop policy if exists "assets read" on public.assets;
create policy "assets read approved" on public.assets
  for select to authenticated using (public.can_access_intranet());
drop policy if exists "assets manage" on public.assets;
create policy "assets manage by role" on public.assets
  for all to authenticated
  using (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'))
  with check (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'));

drop policy if exists "notices read" on public.notices;
create policy "notices read approved" on public.notices
  for select to authenticated using (public.can_access_intranet());
drop policy if exists "notices manage" on public.notices;
create policy "notices manage by role" on public.notices
  for all to authenticated
  using (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'))
  with check (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'));

drop policy if exists "audit read managers" on public.audit_logs;
create policy "audit read approved managers" on public.audit_logs
  for select to authenticated
  using (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'));
drop policy if exists "audit insert staff" on public.audit_logs;
create policy "audit insert approved staff" on public.audit_logs
  for insert to authenticated
  with check (public.can_access_intranet() and actor_id=auth.uid());

drop policy if exists "org read" on public.org_units;
create policy "org read approved" on public.org_units
  for select to authenticated using (public.can_access_intranet());
drop policy if exists "org manage" on public.org_units;
create policy "org manage by role" on public.org_units
  for all to authenticated
  using (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'))
  with check (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'));

drop policy if exists "documents read" on public.documents;
create policy "documents read approved" on public.documents
  for select to authenticated using (public.can_access_intranet());
drop policy if exists "documents manage" on public.documents;
create policy "documents manage by role" on public.documents
  for all to authenticated
  using (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'))
  with check (public.can_access_intranet() and public.current_role() in ('admin','chief','department_head','hr_manager'));

-- A user-created fallback profile must never be able to self-approve.
drop policy if exists "profile self insert officer" on public.profiles;
create policy "profile self insert officer"
  on public.profiles for insert to authenticated
  with check (
    id=auth.uid()
    and role='officer'
    and status='pending'
    and active=true
  );

-- Never grant privileged roles based on user-editable auth metadata.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles
    (id, display_name, role, department, rank, active, status, application_submitted, permissions)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'global_name',
             new.raw_user_meta_data->>'full_name',
             new.raw_user_meta_data->>'name',
             new.email,
             '신규 이용자'),
    'officer', '미배정', '순경', false, 'pending', false, '[]'::jsonb
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
commit;
