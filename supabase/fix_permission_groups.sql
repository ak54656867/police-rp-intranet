-- Fix permission-group persistence for an existing Supabase database.
-- Run this file in Supabase SQL Editor after deploying the matching frontend.
begin;

alter table public.shared_records
  drop constraint if exists shared_records_module_check;
alter table public.shared_records
  add constraint shared_records_module_check
  check (module in (
    'personnel','attendance','incidents','wanted','dispatch','leave','assets',
    'notices','documents','audit','fines','departments','positions','orgPermissions',
    'permissionSets'
  ));

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
    when public.current_role() in ('chief','department_head','hr_manager') then true
    else false
  end;
$$;

commit;
