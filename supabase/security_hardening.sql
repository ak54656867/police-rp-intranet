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
  add column if not exists application_submitted boolean not null default false;

alter table public.profiles
  drop constraint if exists profiles_status_check;
alter table public.profiles
  add constraint profiles_status_check check (status in ('pending','approved','rejected'));

drop policy if exists "profile self update application" on public.profiles;
create policy "profile self update application"
  on public.profiles for update to authenticated
  using (id = auth.uid() and role = 'officer' and status = 'pending' and active = true)
  with check (id = auth.uid() and role = 'officer' and status = 'pending' and active = true);

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

create or replace function public.can_write_shared_module(p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.current_role() = 'admin' then true
    when public.current_role() in ('chief','department_head','hr_manager') then true
    when public.current_role() = 'officer'
      then p_module in ('attendance','incidents','wanted','dispatch','leave','fines','audit')
    when public.current_role() = 'dispatcher'
      then p_module in ('attendance','incidents','dispatch','leave','audit')
    else false
  end;
$$;

revoke all on function public.can_access_intranet() from public;
revoke all on function public.can_write_shared_module(text) from public;
grant execute on function public.can_access_intranet() to authenticated;
grant execute on function public.can_write_shared_module(text) to authenticated;

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
    and updated_by = auth.uid()
    and public.can_write_shared_module(module)
  );

create policy "shared records update by role"
  on public.shared_records for update to authenticated
  using (public.can_access_intranet() and public.can_write_shared_module(module))
  with check (
    public.can_access_intranet()
    and updated_by = auth.uid()
    and public.can_write_shared_module(module)
  );

create policy "shared records delete by role"
  on public.shared_records for delete to authenticated
  using (public.can_access_intranet() and public.can_write_shared_module(module));

commit;
