import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './client';
import { isUnreachableStatus } from '../storage/modelAdapter';

export interface Profile {
  id: string;
  email: string;
  approved: boolean;
  isOwner: boolean;
}

// The raw shape of a `profiles` row as PostgREST returns it — snake_case,
// matching `supabase/migrations/0002_profiles.sql`. Mapped to `Profile`
// explicitly below rather than through an automatic case converter, which
// would silently mangle a field the day someone adds one.
interface ProfileRow {
  id: string;
  email: string;
  approved: boolean;
  is_owner: boolean;
}

function toProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    email: row.email,
    approved: row.approved,
    isOwner: row.is_owner,
  };
}

export interface UseSessionResult {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /**
   * True when the last profile fetch did not reach the database at all —
   * a paused Supabase project, a refused connection, an offline client.
   *
   * The distinction `profile: null` cannot make on its own, and the reason
   * this field exists: a `null` profile means EITHER "the row is not there
   * yet" (the `handle_new_user` race, genuinely pending) OR "we could not
   * ask" (nothing in Postgres ran). Collapsing the two told the owner to wait
   * for an approval only they can give, from behind a gate only they can pass
   * — pre-merge review H1. `AuthGate` shows a different screen for each.
   *
   * Judged by HTTP status, never by message, using the same
   * `isUnreachableStatus` vocabulary `store.ts` uses for the equivalent
   * notice behind the gate.
   */
  databaseUnreachable: boolean;
  signOut: () => Promise<void>;
}

/**
 * Tracks the current Supabase auth session and the signed-in user's
 * `profiles` row.
 *
 * `@supabase/auth-js` 2.112.4 deprecates the async `onAuthStateChange`
 * overload: an async callback can deadlock when it triggers a nested
 * refresh from a `TOKEN_REFRESHED` event. This hook only ever passes the
 * SYNCHRONOUS overload — it just calls `setSession`, nothing awaited inside
 * it — and fetches the profile from a separate effect keyed on the user id
 * instead. Subscribing also fires an immediate `INITIAL_SESSION` event with
 * whatever session is already persisted, so there is no need to additionally
 * call `getSession()` on mount.
 */
export function useSession(): UseSessionResult {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sessionKnown, setSessionKnown] = useState(false);
  const [databaseUnreachable, setDatabaseUnreachable] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setSessionKnown(true);
    });

    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  const userId = session?.user.id ?? null;

  useEffect(() => {
    // Wait for the first onAuthStateChange callback so the "no session"
    // branch below does not fire — and flip `loading` false — before the
    // real, possibly-persisted session has had a chance to arrive.
    if (!sessionKnown) {
      return;
    }

    if (userId === null) {
      setProfile(null);
      setDatabaseUnreachable(false);
      return;
    }

    let cancelled = false;
    setProfileLoading(true);

    supabase
      .from('profiles')
      .select<'id, email, approved, is_owner', ProfileRow>('id, email, approved, is_owner')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error, status }) => {
        if (cancelled) {
          return;
        }
        if (error) {
          // `handle_new_user()` races the first client read after sign-up,
          // so a missing row is expected and handled below via
          // `.maybeSingle()` returning `data: null, error: null` — this
          // branch is a real failure (network, RLS, etc.), not that race.
          //
          // `status` comes off the RESPONSE ENVELOPE, not off the error, for
          // the reason `src/storage/supabase.ts` reads it the same way: a
          // database that is not there has no SQLSTATE, because nothing in
          // Postgres ever ran. That case gets its own screen; every other
          // failure keeps the original behaviour of falling through to the
          // waiting screen, which must never show the app.
          // eslint-disable-next-line no-console
          console.warn('Failed to load profile:', error.message);
          setProfile(null);
          setDatabaseUnreachable(isUnreachableStatus(status));
        } else {
          setProfile(data === null ? null : toProfile(data));
          setDatabaseUnreachable(false);
        }
        setProfileLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionKnown, userId]);

  const signOut = useCallback(async (): Promise<void> => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('Sign-out request failed; clearing local session anyway:', error.message);
    }
    setSession(null);
    setProfile(null);
    setDatabaseUnreachable(false);
  }, []);

  const loading = !sessionKnown || profileLoading;

  return { session, profile, loading, databaseUnreachable, signOut };
}
