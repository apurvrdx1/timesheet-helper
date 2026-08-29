-- Multi-admin Timesheet Helper: surface email verification on profiles.
--
-- Spec §10 requires email verification before the owner approves an account,
-- but verification lives in `auth.users.email_confirmed_at`, a column the
-- client cannot read (RLS on `profiles` is the client's only window into
-- another account, and `auth.users` itself is never exposed via PostgREST).
-- Without this migration the owner has no way to tell a verified account
-- from an unverified one, so the requirement is unenforceable -- not merely
-- unenforced. This migration closes that gap by mirroring the timestamp onto
-- `profiles`, where `profiles_owner_reads_all` (0003_rls.sql) already lets
-- the owner read it.
--
-- `email_confirmed_at` is nullable: null means not yet confirmed, a
-- timestamp is the moment confirmation happened. Mirrored verbatim rather
-- than collapsed to a boolean, so a future screen could show *when* without
-- another migration.

alter table profiles add column email_confirmed_at timestamptz;

-- Backfill existing rows (including the owner's own, bootstrapped by hand)
-- so the column is correct immediately, not only for accounts created after
-- this migration runs.
update profiles p
set email_confirmed_at = u.email_confirmed_at
from auth.users u
where u.id = p.id;

-- Keeps `profiles.email_confirmed_at` in sync with `auth.users` going
-- forward. `auth.users.email_confirmed_at` only ever transitions null ->
-- timestamp (Supabase does not un-confirm an address), but the trigger
-- copies the value unconditionally on every update rather than assuming
-- that, so it can never drift from the source of truth it mirrors.
--
-- SECURITY DEFINER is required for the same reason as `handle_new_user()`
-- (0002_profiles.sql): this function writes to `public.profiles` from a
-- trigger on `auth.users`, a table the signed-in user cannot write to
-- directly. `set search_path = public` is not optional -- omitting it on a
-- SECURITY DEFINER function is a known privilege-escalation vector, since a
-- caller who can manipulate the search path could get this elevated
-- function to resolve to their own objects instead of the intended ones.
create function handle_user_email_confirmed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
  set email_confirmed_at = new.email_confirmed_at
  where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_confirmed
  after update on auth.users
  for each row execute function handle_user_email_confirmed();
