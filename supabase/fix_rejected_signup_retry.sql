-- Fix rejected signup retries for accounts whose stored role drifted.
-- Safe to run repeatedly. Does not touch Discord OAuth or login configuration.

create or replace function public.reopen_rejected_application()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.status='rejected'
     and old.role <> 'admin'
     and new.application_submitted=true
     and auth.uid()=old.id then
    new.role='officer';
    new.status='pending';
    new.active=true;
    new.rank='순경';
    new.department='미배정';
    new.permissions='[]'::jsonb;
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
  using (
    id=auth.uid()
    and role <> 'admin'
    and status in ('pending','rejected')
  )
  with check (
    id=auth.uid()
    and role='officer'
    and status='pending'
    and active=true
  );
