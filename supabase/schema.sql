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
  module text not null check (module in ('personnel','attendance','incidents','wanted','dispatch','leave','assets','notices','documents','audit')),
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
