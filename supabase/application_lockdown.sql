-- 경찰 RP 인트라넷 가입 신청 잠금 및 중복 가입 방지
-- Supabase SQL Editor에서 한 번 실행하세요.
begin;

-- Discord OAuth identity는 Discord provider ID를 기준으로 전역 1개 계정만 연결되도록 보장합니다.
-- Supabase의 기존 auth identity 데이터와 충돌하면 이 인덱스 생성 단계에서 중단됩니다.
create unique index if not exists auth_discord_identity_one_account
  on auth.identities (provider_id)
  where provider = 'discord';

-- 동일 Roblox 계정명으로 여러 인트라넷 계정을 만드는 것도 차단합니다.
-- 기존 중복값이 있다면 아래 인덱스 생성 전에 중복 계정을 정리해야 합니다.
create unique index if not exists profiles_roblox_username_unique_ci
  on public.profiles (lower(btrim(roblox_username)))
  where roblox_username is not null and btrim(roblox_username) <> '';

-- 신청이 접수된 pending 계정은 관리자 승인/반려 전까지 본인도 수정할 수 없습니다.
-- 승인/반려 등 관리자의 수정은 auth.uid()와 대상 profile id가 다르므로 정상 처리됩니다.
create or replace function public.protect_self_profile_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() = old.id and old.role <> 'admin' then
    if old.status = 'pending' and old.application_submitted = true then
      raise exception '가입 신청이 접수되어 관리자 검토 전까지 수정할 수 없습니다.'
        using errcode = '42501';
    end if;

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

commit;
