-- Police RP intranet onboarding, review attribution, and fine-grained permission groups.
-- Run once in Supabase SQL Editor after the current schema/security_hardening setup.
alter table public.profiles
  add column if not exists discord_username text,
  add column if not exists position text,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_by_discord text,
  add column if not exists reviewed_at timestamptz;

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
