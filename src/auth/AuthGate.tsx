/**
 * The gate every screen in this app renders behind. `useSession` resolves
 * to one of five situations, and only the last one reaches `children`:
 *
 * 1. Still resolving the initial auth state — `loading`.
 * 2. No session — the visitor has never signed in, or signed out.
 * 3. A session whose profile fetch never reached the database.
 * 4. A session whose profile is missing or not approved.
 * 5. A session with an approved profile.
 *
 * Cases 3 and 4 were one case until pre-merge review H1. Both arrive as
 * `profile === null`, but for two causes that call for opposite messages:
 *
 * * The `handle_new_user` trigger racing the first read after sign-up leaves
 *   a genuinely pending account, and the waiting screen is true for it.
 * * A failed fetch means nothing was asked, let alone refused. Telling that
 *   user to wait for an approval is false, and for the OWNER it is a lockout:
 *   the only person who can approve anyone is told to wait for approval, by an
 *   app whose Admin tab is behind this very gate. A paused Supabase project —
 *   this project's most likely failure, which `keepwarm.yml` exists to prevent
 *   and can itself fail — produces exactly that.
 *
 * `useSession.databaseUnreachable` separates them, by HTTP status and never by
 * message, and case 3 is checked FIRST: an unreachable database also has no
 * profile to be approved, so the more specific truth has to win.
 *
 * Neither case reaches `children`. Every RLS policy except `profiles_self_read`
 * requires `approved = true` (`supabase/migrations/0003_rls.sql`), so a `null`
 * profile handed to `children` would render a planner that fails every query it
 * makes, instead of a clear message explaining why.
 */
import type { ReactNode } from 'react';
import { Section } from '@astryxdesign/core/Section';
import { VStack } from '@astryxdesign/core/VStack';
import { Spinner } from '@astryxdesign/core/Spinner';
import { useSession } from './useSession';
import { SignInPage } from './SignInPage';
import { PendingApproval } from './PendingApproval';
import { DatabaseAsleep } from './DatabaseAsleep';

export interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const { session, profile, loading, databaseUnreachable, signOut } = useSession();

  if (loading) {
    // DESIGN.md §4 bans spinners for this app's own (local, millisecond)
    // computation, but resolving the initial auth session is a real network
    // round trip with nothing yet on screen to show instead — the one case
    // Astryx's Spinner is for.
    return (
      <Section variant="section">
        <VStack align="center" justify="center" gap={4}>
          <Spinner aria-label="Loading" size="lg" />
        </VStack>
      </Section>
    );
  }

  if (session === null) {
    return <SignInPage />;
  }

  if (databaseUnreachable) {
    return <DatabaseAsleep />;
  }

  if (profile === null || !profile.approved) {
    const email = profile?.email ?? session.user.email ?? '';
    return <PendingApproval email={email} onSignOut={signOut} />;
  }

  return <>{children}</>;
}
