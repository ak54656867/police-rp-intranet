-- Police RP Intranet schema (PostgreSQL / Supabase)
-- Run in Supabase SQL Editor. Use fictional RP data only.
create extension if not exists pgcrypto;
create table if not exists public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null default '신규 이용자',
 role text not null default 'officer' check (role in ('admin','chief','department_head','hr_manager','dispatcher','officer')),
 department text not null default '미배정',
 rank text not null default '순경',
 active boolean not null default true,
 created_at timestamptz not null default now()
);
create table if not exists public.personnel (
 id uuid primary key default gen_random_uuid(), name text not null, rank text not null default '순경',
 department text not null default '미배정', position text, phone_ext text,
 status text not null default '재직', created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.attendance (
 id uuid primary key default gen_random_uuid(), personnel_name text not null, department text,
 duty_type text not null default '일반 근무', check_in timestamptz not null default now(), check_out timestamptz,
 status text not null default '근무 중', notes text, user_id uuid references auth.users(id), created_at timestamptz not null default now()
);
create table if not exists public.incidents (
 id uuid primary key default gen_random_uuid(), case_number text unique not null, title text not null, category text not null default '일반',
 priority text not null default '보통', status text not null default '접수', assigned_to text, description text,
 created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.wanted_persons (
 id uuid primary key default gen_random_uuid(), display_name text not null, case_number text, reason text not null,
 level text not null default '보통', status text not null default '수배 중', notes text,
 created_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create table if not exists public.dispatches (
 id uuid primary key default gen_random_uuid(), call_number text unique not null, title text not null, location_text text,
 unit_name text, priority text not null default '보통', status text not null default '접수', notes text,
 created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.leave_requests (
 id uuid primary key default gen_random_uuid(), applicant_name text not null, leave_type text not null default '연가',
 start_date date not null, end_date date not null, reason text, status text not null default '신청',
 reviewer_id uuid references auth.users(id), created_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create table if not exists public.assets (
 id uuid primary key default gen_random_uuid(), asset_type text not null default '기타', name text not null, asset_code text unique,
 status text not null default '사용 가능', assigned_to text, notes text, created_at timestamptz not null default now()
);
create table if not exists public.notices (
 id uuid primary key default gen_random_uuid(), title text not null, category text not null default '공지', body text not null default '',
 is_pinned boolean not null default false, created_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create table if not exists public.audit_logs (
 id uuid primary key default gen_random_uuid(), actor_id uuid references auth.users(id), action text not null,
 entity_type text not null, details text, created_at timestamptz not null default now()
);
create table if not exists public.org_units (
 id uuid primary key default gen_random_uuid(), name text unique not null, parent_id uuid references public.org_units(id),
 leader_id uuid references public.personnel(id), sort_order int not null default 0, created_at timestamptz not null default now()
);
create table if not exists public.documents (
 id uuid primary key default gen_random_uuid(), document_number text unique, title text not null, category text not null default '일반',
 body text not null default '', status text not null default '작성 중', author_id uuid references auth.users(id), created_at timestamptz not null default now()
);
create or replace function public.current_role() returns text language sql stable security definer set search_path=public as $$
 select role from public.profiles where id=auth.uid() and active=true limit 1;
$$;
create or replace function public.is_staff_manager() returns boolean language sql stable security definer set search_path=public as $$
 select coalesce(public.current_role() in ('admin','chief','department_head','hr_manager'),false);
$$;
alter table public.profiles enable row level security;
alter table public.personnel enable row level security;
alter table public.attendance enable row level security;
alter table public.incidents enable row level security;
alter table public.wanted_persons enable row level security;
alter table public.dispatches enable row level security;
alter table public.leave_requests enable row level security;
alter table public.assets enable row level security;
alter table public.notices enable row level security;
alter table public.audit_logs enable row level security;
alter table public.org_units enable row level security;
alter table public.documents enable row level security;
-- Profiles: users can read own profile; managers can read organization profiles. Self-update is limited to non-role columns by table grants below.
create policy "profile read own or managers" on public.profiles for select to authenticated using (id=auth.uid() or public.is_staff_manager());
create policy "manager profile insert" on public.profiles for insert to authenticated with check (public.current_role()='admin');
create policy "admin profile update" on public.profiles for update to authenticated using (public.current_role()='admin') with check (public.current_role()='admin');
-- Staff data is visible to authenticated RP members; writes require the appropriate role.
create policy "personnel read" on public.personnel for select to authenticated using (true);
create policy "personnel manage" on public.personnel for all to authenticated using (public.is_staff_manager() or public.current_role()='admin') with check (public.is_staff_manager() or public.current_role()='admin');
create policy "attendance read" on public.attendance for select to authenticated using (true);
create policy "attendance insert" on public.attendance for insert to authenticated with check (user_id=auth.uid() or public.is_staff_manager() or public.current_role()='admin');
create policy "attendance update" on public.attendance for update to authenticated using (user_id=auth.uid() or public.is_staff_manager() or public.current_role()='admin') with check (user_id=auth.uid() or public.is_staff_manager() or public.current_role()='admin');
create policy "incident read" on public.incidents for select to authenticated using (true);
create policy "incident manage" on public.incidents for all to authenticated using (public.current_role() in ('admin','chief','department_head','dispatcher','officer')) with check (public.current_role() in ('admin','chief','department_head','dispatcher','officer'));
create policy "wanted read" on public.wanted_persons for select to authenticated using (true);
create policy "wanted manage" on public.wanted_persons for all to authenticated using (public.current_role() in ('admin','chief','department_head','officer')) with check (public.current_role() in ('admin','chief','department_head','officer'));
create policy "dispatch read" on public.dispatches for select to authenticated using (true);
create policy "dispatch manage" on public.dispatches for all to authenticated using (public.current_role() in ('admin','chief','department_head','dispatcher','officer')) with check (public.current_role() in ('admin','chief','department_head','dispatcher','officer'));
create policy "leave read own or managers" on public.leave_requests for select to authenticated using (created_by=auth.uid() or public.is_staff_manager() or public.current_role()='admin');
create policy "leave create own" on public.leave_requests for insert to authenticated with check (created_by=auth.uid());
create policy "leave review" on public.leave_requests for update to authenticated using (public.is_staff_manager() or public.current_role()='admin') with check (public.is_staff_manager() or public.current_role()='admin');
create policy "assets read" on public.assets for select to authenticated using (true);
create policy "assets manage" on public.assets for all to authenticated using (public.is_staff_manager() or public.current_role()='admin') with check (public.is_staff_manager() or public.current_role()='admin');
create policy "notices read" on public.notices for select to authenticated using (true);
create policy "notices manage" on public.notices for all to authenticated using (public.is_staff_manager() or public.current_role()='admin') with check (public.is_staff_manager() or public.current_role()='admin');
create policy "audit read managers" on public.audit_logs for select to authenticated using (public.is_staff_manager() or public.current_role()='admin');
create policy "audit insert staff" on public.audit_logs for insert to authenticated with check (actor_id=auth.uid());
create policy "org read" on public.org_units for select to authenticated using (true);
create policy "org manage" on public.org_units for all to authenticated using (public.is_staff_manager() or public.current_role()='admin') with check (public.is_staff_manager() or public.current_role()='admin');
create policy "documents read" on public.documents for select to authenticated using (true);
create policy "documents manage" on public.documents for all to authenticated using (public.is_staff_manager() or public.current_role()='admin') with check (public.is_staff_manager() or public.current_role()='admin');
grant usage on schema public to authenticated;
grant select,insert,update,delete on public.profiles,public.personnel,public.attendance,public.incidents,public.wanted_persons,public.dispatches,public.leave_requests,public.assets,public.notices,public.audit_logs,public.org_units,public.documents to authenticated;
-- IMPORTANT: create the first user in Supabase Authentication, then insert a matching profiles row.
-- Example (replace UUID):
-- insert into public.profiles(id,display_name,role,department,rank) values ('USER-UUID','시스템 관리자','admin','경찰청','치안총감');


-- Shared live workspace used by the static GitHub Pages frontend.
-- Each row is one record, so concurrent users can update different records without
-- overwriting the entire workspace snapshot.
create table if not exists public.shared_records (
  module text not null check (module in ('personnel','attendance','incidents','wanted','dispatch','leave','assets','notices','documents','audit','fines','departments','positions','orgPermissions','permissionSets')),
  record_id text not null,
  payload jsonb not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (module, record_id)
);
alter table public.shared_records enable row level security;
drop policy if exists "shared records read authenticated" on public.shared_records;
drop policy if exists "shared records insert authenticated" on public.shared_records;
drop policy if exists "shared records update authenticated" on public.shared_records;
drop policy if exists "shared records delete authenticated" on public.shared_records;
create policy "shared records read authenticated" on public.shared_records
  for select to authenticated using (auth.uid() is not null);
create policy "shared records insert authenticated" on public.shared_records
  for insert to authenticated with check (auth.uid() is not null and (updated_by is null or updated_by=auth.uid()));
create policy "shared records update authenticated" on public.shared_records
  for update to authenticated using (auth.uid() is not null)
  with check (auth.uid() is not null and (updated_by is null or updated_by=auth.uid()));
create policy "shared records delete authenticated" on public.shared_records
  for delete to authenticated using (auth.uid() is not null);
grant select, insert, update, delete on public.shared_records to authenticated;

-- Create a basic officer profile automatically for new Discord/OAuth users.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, role, department, rank, active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', new.email, '신규 이용자'),
    'officer', '미배정', '순경', true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

-- Ensure authenticated users can create only their own default officer profile if
-- the trigger was not installed when their account was created.
drop policy if exists "profile self insert officer" on public.profiles;
create policy "profile self insert officer" on public.profiles
  for insert to authenticated
  with check (id=auth.uid() and role='officer');

-- Enable Realtime for the shared records table. Safe to run repeatedly.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='shared_records'
  ) then
    alter publication supabase_realtime add table public.shared_records;
  end if;
exception when undefined_object then
  raise notice 'supabase_realtime publication was not found; enable Realtime for shared_records in Supabase Dashboard.';
end;
$$;


-- Security hardening appended for current frontend expectations.

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

-- A user may edit only their own pending application. The WITH CHECK prevents
-- changing role, active, or status to bypass approval.
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
-- Prevent applicants from changing role, approval, rank, department, or permissions
-- through the broad row-level UPDATE permission on their own profile.
create or replace function public.protect_self_profile_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() = old.id and old.role <> 'admin' then
    new.id := old.id;
    new.role := old.role;
    new.status := old.status;
    new.active := old.active;
    new.rank := old.rank;
    new.department := old.department;
    new.permissions := old.permissions;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_protect_self_update on public.profiles;
create trigger profiles_protect_self_update
  before update on public.profiles
  for each row execute function public.protect_self_profile_update();

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

-- Align the database's allowed modules with the frontend's actual shared data list.
alter table public.shared_records
  drop constraint if exists shared_records_module_check;
alter table public.shared_records
  add constraint shared_records_module_check
  check (module in (
    'personnel','attendance','incidents','wanted','dispatch','leave','assets',
    'notices','documents','audit','fines','departments','positions','orgPermissions'
  ));

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

-- Make this schema's hardening section safely re-runnable by removing its own policies first.
drop policy if exists "profile read own or approved managers" on public.profiles;
drop policy if exists "shared records read approved members" on public.shared_records;
drop policy if exists "shared records insert by role" on public.shared_records;
drop policy if exists "shared records update by role" on public.shared_records;
drop policy if exists "shared records delete by role" on public.shared_records;
drop policy if exists "personnel read approved" on public.personnel;
drop policy if exists "personnel manage by role" on public.personnel;
drop policy if exists "attendance read approved" on public.attendance;
drop policy if exists "attendance insert approved" on public.attendance;
drop policy if exists "attendance update approved" on public.attendance;
drop policy if exists "incident read approved" on public.incidents;
drop policy if exists "incident write approved" on public.incidents;
drop policy if exists "incident update approved" on public.incidents;
drop policy if exists "incident delete managers" on public.incidents;
drop policy if exists "incident manage approved" on public.incidents;
drop policy if exists "wanted read approved" on public.wanted_persons;
drop policy if exists "wanted write approved" on public.wanted_persons;
drop policy if exists "wanted update approved" on public.wanted_persons;
drop policy if exists "wanted delete managers" on public.wanted_persons;
drop policy if exists "wanted manage approved" on public.wanted_persons;
drop policy if exists "dispatch read approved" on public.dispatches;
drop policy if exists "dispatch write approved" on public.dispatches;
drop policy if exists "dispatch update approved" on public.dispatches;
drop policy if exists "dispatch delete managers" on public.dispatches;
drop policy if exists "dispatch manage approved" on public.dispatches;
drop policy if exists "leave read approved own or managers" on public.leave_requests;
drop policy if exists "leave create approved own" on public.leave_requests;
drop policy if exists "leave review approved" on public.leave_requests;
drop policy if exists "assets read approved" on public.assets;
drop policy if exists "assets manage by role" on public.assets;
drop policy if exists "notices read approved" on public.notices;
drop policy if exists "notices manage by role" on public.notices;
drop policy if exists "audit read approved managers" on public.audit_logs;
drop policy if exists "audit insert approved staff" on public.audit_logs;
drop policy if exists "org read approved" on public.org_units;
drop policy if exists "org manage by role" on public.org_units;
drop policy if exists "documents read approved" on public.documents;
drop policy if exists "documents manage by role" on public.documents;
drop policy if exists "profile self insert officer" on public.profiles;

drop policy if exists "profile read own or managers" on public.profiles;
create policy "profile read own or approved managers"
  on public.profiles for select to authenticated
  using (
    id=auth.uid()
    or (public.can_access_intranet() and public.is_staff_manager())
  );

create or replace function public.can_insert_shared_module(p_module text)
returns boolean language sql stable security definer set search_path=public as $$
  select case
    when public.current_role()='admin' then true
    when p_module in ('departments','positions','orgPermissions') then false
    when public.current_role() in ('chief','department_head','hr_manager') then true
    when public.current_role()='officer' then p_module in ('attendance','incidents','wanted','dispatch','leave','fines','audit')
    when public.current_role()='dispatcher' then p_module in ('attendance','incidents','dispatch','leave','audit')
    else false end;
$$;
create or replace function public.can_update_shared_module(p_module text)
returns boolean language sql stable security definer set search_path=public as $$
  select case
    when public.current_role()='admin' then true
    when p_module in ('audit','departments','positions','orgPermissions') then false
    when public.current_role() in ('chief','department_head','hr_manager') then true
    when public.current_role()='officer' then p_module in ('attendance','incidents','wanted','dispatch','leave','fines')
    when public.current_role()='dispatcher' then p_module in ('attendance','incidents','dispatch','leave')
    else false end;
$$;
create or replace function public.can_delete_shared_module(p_module text)
returns boolean language sql stable security definer set search_path=public as $$
  select case
    when public.current_role()='admin' then true
    when p_module in ('audit','departments','positions','orgPermissions') then false
    when public.current_role() in ('chief','department_head','hr_manager') then true
    else false end;
$$;
revoke all on function public.can_access_intranet() from public;
revoke all on function public.can_insert_shared_module(text) from public;
revoke all on function public.can_update_shared_module(text) from public;
revoke all on function public.can_delete_shared_module(text) from public;
grant execute on function public.can_access_intranet() to authenticated;
grant execute on function public.can_insert_shared_module(text) to authenticated;
grant execute on function public.can_update_shared_module(text) to authenticated;
grant execute on function public.can_delete_shared_module(text) to authenticated;

-- Replace the unsafe policies that allowed every authenticated account to read,
-- overwrite, or delete every shared record, including privileged organization data.
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



-- Included for new projects: latest onboarding, review attribution, and permission-group update.
-- Police RP intranet onboarding, review attribution, and fine-grained permission groups.
-- Run once in Supabase SQL Editor after the current schema/security_hardening setup.
alter table public.profiles
  add column if not exists discord_username text,
  add column if not exists position text,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_by_discord text,
  add column if not exists reviewed_at timestamptz;

-- Organization lists and permission groups are stored as shared_records list rows.
alter table public.shared_records
  drop constraint if exists shared_records_module_check;
alter table public.shared_records
  add constraint shared_records_module_check
  check (module in ('personnel','attendance','incidents','wanted','dispatch','leave','assets','notices','documents','audit','fines','departments','positions','orgPermissions','permissionSets'));

-- Applicants may update their own application identity and requested placement, but
-- cannot change their assigned rank, department, position, role, approval, or access.
create or replace function public.protect_self_profile_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() = old.id and old.role <> 'admin' then
    new.id := old.id;
    new.role := old.role;
    new.status := old.status;
    new.active := old.active;
    new.rank := old.rank;
    new.department := old.department;
    new.position := old.position;
    new.permissions := old.permissions;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

-- Permission groups live in shared_records under module=permissionSets and
-- record_id=__list__. A profile's permissions array stores assigned group IDs.
create or replace function public.has_assigned_permission_set()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    cross join lateral jsonb_array_elements_text(coalesce(p.permissions, '[]'::jsonb)) assigned(group_id)
    join public.shared_records r
      on r.module = 'permissionSets'
     and r.record_id = '__list__'
    cross join lateral jsonb_array_elements(coalesce(r.payload, '[]'::jsonb)) permission_group
    where p.id = auth.uid()
      and permission_group->>'id' = assigned.group_id
  );
$$;

create or replace function public.has_org_module_permission(p_module text, p_action text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    cross join lateral jsonb_array_elements_text(coalesce(p.permissions, '[]'::jsonb)) assigned(group_id)
    join public.shared_records r
      on r.module = 'permissionSets'
     and r.record_id = '__list__'
    cross join lateral jsonb_array_elements(coalesce(r.payload, '[]'::jsonb)) permission_group
    cross join lateral jsonb_array_elements_text(coalesce(permission_group->'permissions', '[]'::jsonb)) granted(permission_code)
    where p.id = auth.uid()
      and permission_group->>'id' = assigned.group_id
      and granted.permission_code = p_module || ':' || p_action
  );
$$;

create or replace function public.can_insert_shared_module(p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.current_role() = 'admin' then true
    when p_module in ('departments','positions','orgPermissions','permissionSets') then false
    when public.has_assigned_permission_set() then public.has_org_module_permission(p_module, 'create')
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
    when p_module in ('audit','departments','positions','orgPermissions','permissionSets') then false
    when public.has_assigned_permission_set() then (public.has_org_module_permission(p_module, 'update') or public.has_org_module_permission(p_module, 'approve'))
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
    when p_module in ('audit','departments','positions','orgPermissions','permissionSets') then false
    when public.has_assigned_permission_set() then public.has_org_module_permission(p_module, 'delete')
    when public.current_role() in ('chief','department_head','hr_manager') then true
    else false
  end;
$$;

revoke all on function public.has_assigned_permission_set() from public;
revoke all on function public.has_org_module_permission(text,text) from public;
grant execute on function public.has_assigned_permission_set() to authenticated;
grant execute on function public.has_org_module_permission(text,text) to authenticated;

drop policy if exists "shared records read approved members" on public.shared_records;
create policy "shared records read approved members"
  on public.shared_records for select to authenticated
  using (
    public.can_access_intranet()
    and (
      not public.has_assigned_permission_set()
      or public.current_role() in ('admin','chief','department_head','hr_manager')
      or public.has_org_module_permission(module, 'read')
      or public.has_org_module_permission(module, 'approve')
    )
  );

