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

-- Resolve effective permissions from the logged-in profile's assigned group IDs.
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
      and granted.permission_code in (p_module || ':' || p_action, p_module || ':*', '*:*)
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


drop policy if exists "shared records read by module permission" on public.shared_records;
drop policy if exists "shared records read approved members" on public.shared_records;
create or replace function public.can_read_shared_module(p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not public.can_access_intranet() then false
    when public.current_role() = 'admin' then true
    when p_module = 'audit'
      then public.current_role() in ('chief','department_head','hr_manager')
        or public.has_org_module_permission(p_module, 'read')
        or public.has_org_module_permission(p_module, 'approve')
    when p_module = 'personnel'
      then public.current_role() in ('chief','department_head','hr_manager')
        or public.has_org_module_permission(p_module, 'read')
        or public.has_org_module_permission(p_module, 'approve')
    when p_module in ('departments','positions','orgPermissions','permissionSets') then true
    when public.has_assigned_permission_set()
      then public.has_org_module_permission(p_module, 'read')
        or public.has_org_module_permission(p_module, 'approve')
    when public.current_role() in ('chief','department_head','hr_manager') then true
    when public.current_role() = 'officer'
      then p_module in ('attendance','incidents','wanted','dispatch','leave','assets','notices','documents','fines')
    when public.current_role() = 'dispatcher'
      then p_module in ('attendance','incidents','dispatch','leave','notices')
    else false
  end;
$$;
create policy "shared records read by module permission"
  on public.shared_records for select to authenticated
  using (public.can_read_shared_module(module));

commit;
