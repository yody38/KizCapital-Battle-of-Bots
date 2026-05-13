-- =====================================================================
-- Kiz Capital LLC · Battle of Bots — Supabase schema
-- Run this in: Supabase Dashboard → SQL Editor → New query → paste → Run
-- Idempotent: re-runs are safe.
-- =====================================================================

-- 1. Whitelist of emails allowed to sign in
create table if not exists public.allowed_emails (
  email      text primary key,
  added_at   timestamptz not null default now(),
  added_by   text,
  note       text
);

alter table public.allowed_emails enable row level security;

-- Only authenticated users can read their own whitelist row (used by guards)
drop policy if exists "users can read their own whitelist row" on public.allowed_emails;
create policy "users can read their own whitelist row"
  on public.allowed_emails for select
  to authenticated
  using (lower(email) = lower((auth.jwt() ->> 'email')));

-- =====================================================================
-- 2. Block signups for non-whitelisted emails (gating at the auth layer)
--    auth.users INSERT trigger that raises if email not in allowed_emails.
-- =====================================================================
create or replace function public.enforce_email_whitelist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.allowed_emails ae
    where lower(ae.email) = lower(new.email)
  ) then
    raise exception 'email_not_whitelisted'
      using errcode = 'P0001',
            hint = 'Contact Kiz Capital to be added to the access list.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_email_whitelist on auth.users;
create trigger trg_enforce_email_whitelist
  before insert on auth.users
  for each row execute function public.enforce_email_whitelist();

-- =====================================================================
-- 3. Storage bucket for dashboard JSON data
--    Private (objects require an authenticated session + whitelist).
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('dashboard-data', 'dashboard-data', false)
on conflict (id) do nothing;

-- Allow whitelisted authenticated users to read everything in the bucket
drop policy if exists "whitelisted users can read dashboard-data"
  on storage.objects;
create policy "whitelisted users can read dashboard-data"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'dashboard-data'
    and exists (
      select 1 from public.allowed_emails ae
      where lower(ae.email) = lower((auth.jwt() ->> 'email'))
    )
  );

-- Note: uploads happen via the service_role key from the Mac uploader.
-- Service role bypasses RLS, so no insert/update/delete policies needed.

-- =====================================================================
-- 4. Seed the whitelist with the project owner
--    Add additional emails by inserting more rows.
-- =====================================================================
insert into public.allowed_emails (email, note)
values ('yoderiznaga21@gmail.com', 'project owner')
on conflict (email) do nothing;

-- =====================================================================
-- DONE. Verify with:
--   select * from public.allowed_emails;
--   select id, name, public from storage.buckets where id = 'dashboard-data';
-- =====================================================================
