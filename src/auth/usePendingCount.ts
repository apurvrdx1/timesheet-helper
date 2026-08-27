/**
 * How many accounts are waiting on the owner right now.
 *
 * This is amendment A16's replacement for the spec's owner-notification
 * email. The email was dropped as scope creep — mail infrastructure for a
 * handful of admins — but the problem it solved is real: without any signal,
 * approval depends on the owner spontaneously opening a page they have no
 * reason to open. A count on the Admin tab is the smallest thing that puts
 * "someone is waiting" in front of them.
 *
 * ## What counts as waiting
 *
 * Not approved, AND email already confirmed. The second half matters because
 * `AdminPage` disables Approve until `email_confirmed_at` is set (spec §10),
 * so an unconfirmed registration is not something the owner can act on. A
 * badge counting rows nobody can approve would be a nag that no action clears
 * — this project's named recurring failure mode, in miniature.
 *
 * ## Why it is safe to call this at all
 *
 * `profiles_owner_reads_all` (`supabase/migrations/0003_rls.sql`) is what
 * makes a full count possible; for anyone else the same query counts only
 * their own row. `enabled` is therefore about not making a pointless request,
 * not about hiding anything — the database is the guard.
 */
import { useEffect, useState } from 'react';
import { supabase } from './client';

/**
 * @param enabled Whether to ask at all. False for a non-owner.
 * @param refreshKey Re-counts whenever this changes. The caller passes the
 * active tab, so leaving the Admin page after approving someone brings the
 * badge back in step without a poll or a shared store.
 */
export function usePendingCount(enabled: boolean, refreshKey: unknown): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setCount(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      const { count: pending, error } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('approved', false)
        .not('email_confirmed_at', 'is', null);

      if (cancelled) return;
      if (error) {
        // A badge is an affordance, not a statement of record: a failed count
        // shows nothing rather than a wrong number or an error banner over
        // the whole planner. The Admin page itself reports its own failures.
        // eslint-disable-next-line no-console
        console.warn('Failed to count pending accounts:', error.message);
        setCount(null);
        return;
      }
      setCount(pending ?? null);
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  return count;
}
