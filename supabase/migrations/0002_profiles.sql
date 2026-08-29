-- Multi-admin Timesheet Helper: profiles, approval, and the owner bootstrap.
--
-- Registration is open to anyone, but a new account gets nothing until the
-- owner approves it. `approved` defaults to false: that default IS the
-- security model. If it defaulted true, open sign-up would mean open access
-- to a fresh, empty instance for anyone on the internet.
--
-- `is_owner` marks the single account that can approve/revoke others. The
-- partial unique index below makes a second owner impossible at the
-- database level -- not discouraged, not validated in application code,
-- impossible. There is deliberately no in-app path that sets is_owner: the
-- first owner is set by hand, once, in the SQL editor (see
-- supabase/README.md). An app that can mint its own owner can be tricked
-- into minting someone else's.
--
-- This migration does NOT enable RLS or write policies on `profiles` --
-- that is Task 3, deliberately separate so the isolation model gets its own
-- review. Until then, this table is readable/writable by anyone holding a
-- valid session, same as the eight domain tables from 0001_schema.sql. Do
-- not point the app at this schema until RLS is applied.

create table profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  approved   boolean not null default false,
  is_owner   boolean not null default false,
  created_at timestamptz not null default now()
);

-- Exactly one owner, enforced by the database rather than by convention.
-- A partial unique index over rows where is_owner is true means a second
-- `is_owner = true` row violates a uniqueness constraint -- Postgres
-- refuses the write outright.
create unique index one_owner_only on profiles (is_owner) where is_owner;

-- Creates a profiles row whenever someone signs up, so app code never has
-- to (and never could -- the user isn't authenticated yet when this fires).
--
-- SECURITY DEFINER is required: this function inserts into public.profiles
-- from a trigger on auth.users, a table the signing-up user cannot touch
-- directly. `set search_path = public` is not optional -- omitting it on a
-- SECURITY DEFINER function is a known privilege-escalation vector, since a
-- caller who can manipulate the search path could get this elevated
-- function to resolve to their own objects instead of the intended ones.
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
