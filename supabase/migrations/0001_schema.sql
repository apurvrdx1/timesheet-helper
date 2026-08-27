-- Multi-admin Timesheet Helper: domain schema.
--
-- One table per Model collection (src/domain/types.ts), plus `schedule` for
-- ScheduleEntry and `meta` for calculation bookkeeping. Every table carries
-- `owner_id` and is keyed (owner_id, <natural key>) so two admins can reuse
-- the same project code, person id, etc. without collision.
--
-- This migration does NOT enable RLS or write policies — that is a
-- deliberately separate task/review. Until RLS is added, every row is
-- readable/writable by anyone holding a valid session, scoped only by
-- whatever `owner_id` the caller supplies. Do not point the app at this
-- schema in that state.
--
-- `on delete cascade` on owner_id is the only path that destroys data: it
-- fires when a user row in auth.users is deleted (e.g. from the Supabase
-- dashboard), and it removes every row that user owns across all eight
-- tables. See supabase/README.md.

create type otl_category   as enum ('CAPEX', 'OPEX', 'LEAVE');
create type leave_subtype  as enum ('VACATION', 'STAT', 'PERSONAL', 'SICK');
create type person_role    as enum ('MANAGER', 'REPORT');
create type entry_source   as enum ('CALC', 'OVERRIDE', 'LEAVE');

-- Otl (src/domain/types.ts)
create table otls (
  owner_id               uuid not null references auth.users(id) on delete cascade default auth.uid(),
  project_code           text not null,
  task_code               text not null default '',
  expenditure_type_code  text not null default '',
  time_reporting_code    text not null default '',
  category               otl_category not null,
  leave_subtype          leave_subtype,
  is_default_opex        boolean not null default false,
  color_index            int  not null default 0 check (color_index between 0 and 9),
  active                 boolean not null default true,
  primary key (owner_id, project_code),
  constraint leave_needs_subtype check (category <> 'LEAVE' or leave_subtype is not null),
  constraint only_opex_is_default check (not is_default_opex or category = 'OPEX')
);

-- Person (src/domain/types.ts)
create table people (
  owner_id   uuid not null references auth.users(id) on delete cascade default auth.uid(),
  id         text not null,
  name       text not null check (length(trim(name)) > 0),
  role       person_role not null,
  manager_id text,
  primary key (owner_id, id)
);

-- StatHoliday (src/domain/types.ts)
create table stat_holidays (
  owner_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  date             date not null,
  name             text not null,
  otl_project_code text not null,
  primary key (owner_id, date)
);

-- Allocation (src/domain/types.ts). person_id is nullable BY DESIGN: a null
-- row is the OTL's monthly TOTAL, not an assignment to a person named
-- "null". A plain composite primary key can't include that column directly
-- because Postgres PRIMARY KEY / UNIQUE constraints only accept column
-- names, not expressions — `primary key (..., coalesce(person_id, ''))` is
-- a syntax error. `person_key` is a generated, stored column that exists
-- solely to carry that expression's value so it can sit in a real key;
-- person_id itself stays nullable and is the column the app reads/writes.
create table allocations (
  owner_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  month            text not null check (month ~ '^\d{4}-\d{2}$'),
  otl_project_code text not null,
  person_id        text,                      -- null marks the OTL's monthly TOTAL
  hours            numeric(8,2) not null check (hours >= 0),
  person_key       text generated always as (coalesce(person_id, '')) stored,
  primary key (owner_id, month, otl_project_code, person_key)
);

-- LeaveRange (src/domain/types.ts: Model.leave)
create table leave_ranges (
  owner_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  person_id        text not null,
  start_date       date not null,
  end_date         date not null check (end_date >= start_date),
  otl_project_code text not null,
  primary key (owner_id, person_id, start_date, otl_project_code)
);

-- Override (src/domain/types.ts)
create table overrides (
  owner_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  person_id        text not null,
  date             date not null,
  otl_project_code text not null,
  hours            numeric(8,2) not null check (hours >= 0),
  primary key (owner_id, person_id, date, otl_project_code)
);

-- ScheduleEntry (src/domain/types.ts). blocks is the cell total;
-- override_blocks is how much of it the user pinned by hand and can never
-- exceed blocks — that invariant is `pin_within_cell` below.
create table schedule (
  owner_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  person_id        text not null,
  date             date not null,
  otl_project_code text not null,
  blocks           int not null check (blocks > 0),
  source           entry_source not null,
  override_blocks  int not null default 0 check (override_blocks >= 0),
  primary key (owner_id, person_id, date, otl_project_code),
  constraint pin_within_cell check (override_blocks <= blocks)
);

-- Calculation bookkeeping, not part of Model. One row per owner.
create table meta (
  owner_id            uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  model_hash          text,
  last_calculated_at  timestamptz
);
