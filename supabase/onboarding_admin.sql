-- Run this migration once in Supabase SQL Editor after the existing schema.sql.
-- Discord user ID 285388357272600578 is the fixed RP super administrator.
alter table public.profiles
  add column if not exists status text not null default 'pending',
  add column if not exists roblox_username text,
  add column if not exists requested_rank text,
  add column if not exists requested_department text,
  add column if not exists application_submitted boolean not null default false;

-- Keep existing approved staff profiles usable; only new users default to pending.
update public.profiles
set status = case when active = true and role <> 'officer' then 'approved' else coalesce(status, 'pending') end
where status is null;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  discord_id text;
  display text;
begin
  discord_id := coalesce(new.raw_user_meta_data->>'provider_id', new.raw_user_meta_data->>'sub', '');
  display := coalesce(new.raw_user_meta_data->>'global_name', new.raw_user_meta_data->>'full_name',
                      new.raw_user_meta_data->>'name', new.email, '신규 이용자');
  if discord_id = '285388357272600578' then
    insert into public.profiles(id, display_name, role, department, rank, active, status, application_submitted)
    values(new.id, '생활안전교통국장', 'admin', '생활안전교통국', '생활안전교통국장', true, 'approved', true)
    on conflict(id) do update set display_name='생활안전교통국장', role='admin',
      department='생활안전교통국', rank='생활안전교통국장', active=true, status='approved', application_submitted=true;
  else
    insert into public.profiles(id, display_name, role, department, rank, active, status)
    values(new.id, display, 'officer', '미배정', '순경', false, 'pending')
    on conflict(id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute procedure public.handle_new_auth_user();

-- If the administrator has already logged in, promote that existing account too.
update public.profiles p
set display_name='생활안전교통국장', role='admin', department='생활안전교통국',
    rank='생활안전교통국장', active=true, status='approved', application_submitted=true
from auth.users u
where p.id=u.id
  and coalesce(u.raw_user_meta_data->>'provider_id', u.raw_user_meta_data->>'sub', '')='285388357272600578';

-- Applicants may edit only their own pending application, and cannot grant themselves access.
drop policy if exists "applicant update own pending profile" on public.profiles;
create policy "applicant update own pending profile" on public.profiles
for update to authenticated
using (id=auth.uid() and role='officer' and status in ('pending','rejected'))
with check (id=auth.uid() and role='officer' and status in ('pending','rejected') and active=false);

grant select, update on public.profiles to authenticated;
