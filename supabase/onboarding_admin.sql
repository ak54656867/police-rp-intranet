-- Safe onboarding/profile migration for the Police RP Intranet.
-- This script intentionally does not auto-promote any account from user-editable metadata.
-- Run after schema.sql. Promote the verified administrator manually using the UUID
-- associated with the trusted Discord identity (see the commented queries below).

alter table public.profiles
  add column if not exists status text not null default 'pending',
  add column if not exists roblox_username text,
  add column if not exists requested_rank text,
  add column if not exists requested_department text,
  add column if not exists application_submitted boolean not null default false,
  add column if not exists permissions jsonb not null default '[]'::jsonb;

alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add constraint profiles_status_check
  check (status in ('pending','approved','rejected','suspended','dismissed'));

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


create or replace function public.reopen_rejected_application()
returns trigger language plpgsql set search_path=public as $$
begin
  if old.status='rejected' and old.role='officer'
     and new.application_submitted=true and auth.uid()=old.id then
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

drop policy if exists "profile self update application" on public.profiles;
create policy "profile self update application"
  on public.profiles for update to authenticated
  using (id=auth.uid() and role='officer'
    and (status='pending' or status='rejected')
    and (active=true or status='rejected'))
  with check (id=auth.uid() and role='officer' and status='pending' and active=true);

drop policy if exists "applicant update own pending profile" on public.profiles;
drop policy if exists "profile self insert officer" on public.profiles;
create policy "profile self insert officer"
  on public.profiles for insert to authenticated
  with check (id=auth.uid() and role='officer' and status='pending' and active=true);

grant select, insert, update on public.profiles to authenticated;

-- Verify the provider-returned identity (not raw_user_meta_data) before granting admin:
-- select u.id, i.provider, i.identity_data
-- from auth.users u join auth.identities i on i.user_id=u.id
-- where i.provider='discord';
-- After verifying the Discord ID 285388357272600578 in identity_data, use that UUID:
-- update public.profiles
-- set role='admin', display_name='생활안전교통국장',
--     department='생활안전교통국', rank='생활안전교통국장',
--     active=true, status='approved', application_submitted=true
-- where id='<VERIFIED_AUTH_USERS_UUID>';
