-- Discord slash-command identity mapping for the intranet.
-- Run once in Supabase SQL Editor before deploying the Discord Edge Function.
begin;

alter table public.profiles
  add column if not exists discord_id text;

-- Backfill accounts that already authenticated with Discord.
update public.profiles p
set discord_id = i.provider_id
from auth.identities i
where i.user_id = p.id
  and i.provider = 'discord'
  and i.provider_id is not null
  and (p.discord_id is null or p.discord_id = '');

create unique index if not exists profiles_discord_id_unique_idx
  on public.profiles(discord_id)
  where discord_id is not null;

create or replace function public.sync_discord_identity_to_profile()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if new.provider = 'discord' and new.provider_id is not null then
    update public.profiles
       set discord_id = new.provider_id
     where id = new.user_id
       and (discord_id is null or discord_id = new.provider_id);
  end if;
  return new;
end;
$$;

drop trigger if exists sync_discord_identity_to_profile_trigger on auth.identities;
create trigger sync_discord_identity_to_profile_trigger
  after insert or update of provider_id, provider on auth.identities
  for each row execute function public.sync_discord_identity_to_profile();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  linked_discord_id text;
begin
  select i.provider_id into linked_discord_id
  from auth.identities i
  where i.user_id = new.id and i.provider = 'discord'
  limit 1;

  insert into public.profiles (id, display_name, role, department, rank, active, discord_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'global_name', new.raw_user_meta_data->>'full_name',
             new.raw_user_meta_data->>'name', new.email, '신규 이용자'),
    'officer', '미배정', '순경', true, linked_discord_id
  )
  on conflict (id) do update
    set discord_id = coalesce(public.profiles.discord_id, excluded.discord_id);

  return new;
end;
$$;

commit;
