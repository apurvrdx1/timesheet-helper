-- Tell "never decided on" apart from "approved, then revoked".
--
-- `approved = false` carried two different facts and no way to separate them.
-- A revoked account looks exactly like a brand-new one: not approved, address
-- confirmed. So the Admin tab's pending badge (`src/auth/usePendingCount.ts`,
-- amendment A16) counted a revoked account as waiting, forever, and the only
-- in-app action that could clear the badge was re-approving the person the
-- owner had just deliberately revoked. The alternative was deleting the user
-- from the Supabase dashboard, which destroys their data (supabase/README.md).
-- A badge that no correct action can clear is this project's named recurring
-- failure mode, so the fact the badge needs has to exist in the schema.
--
-- `revoked_at`, not `was_approved`: a timestamp answers "when", a boolean does
-- not, and the Admin page will eventually want to say it. Null means "no
-- approval has ever been withdrawn from this account", which is true both of an
-- account awaiting its first decision and of one that is approved right now.
alter table profiles add column revoked_at timestamptz;

-- Existing rows are left null on purpose. This migration cannot know which of
-- today's unapproved accounts were once approved -- nothing recorded it -- and
-- null is the safe guess in both directions: a wrongly-null revoked account
-- shows up in the badge once more and is cleared by the next revoke, whereas a
-- wrongly-stamped new account would be silently hidden from the only screen
-- that could approve it. Show too much, never too little.

-- `revoked_at` is written by the database, never by a client.
--
-- The owner's UPDATE policy (`profiles_owner_updates`, 0003_rls.sql) carries no
-- column restriction, so without this trigger `revoked_at` would be just
-- another column a client could PATCH -- and the badge would be trusting the
-- caller to tell the truth about the caller. Instead the trigger recomputes it
-- from the transition itself on EVERY update and overwrites whatever was sent:
--
--   * approved becomes/stays true -> null. Approving is what ends a revocation,
--     and the same account can be approved and revoked repeatedly.
--   * true -> false               -> now(). This is the revocation.
--   * false -> false              -> unchanged. An unrelated update (an email
--     mirror from 0004, say) must not invent a revocation that never happened,
--     and must not erase one that did.
--
-- No `when` clause for the same reason: a client that PATCHes `revoked_at`
-- alone changes nothing else, and the trigger has to run to undo it.
--
-- Not SECURITY DEFINER, unlike 0002's and 0004's triggers: this one writes only
-- to the NEW record of the row already being updated, so it needs no privilege
-- its caller does not already hold. `set search_path = ''` regardless -- it
-- references no objects at all, and an empty path is what Supabase's own
-- `function_search_path_mutable` lint asks for.
create function set_revoked_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.approved then
    new.revoked_at := null;
  elsif old.approved then
    new.revoked_at := now();
  else
    new.revoked_at := old.revoked_at;
  end if;
  return new;
end;
$$;

create trigger profiles_track_revocation
  before update on profiles
  for each row execute function set_revoked_at();
