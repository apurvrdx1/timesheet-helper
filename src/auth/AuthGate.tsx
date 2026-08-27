/**
 * The gate every screen in this app renders behind. `useSession` resolves
 * to one of four situations, and only the last one reaches `children`:
 *
 * 1. Still resolving the initial auth state — `loading`.
 * 2. No session — the visitor has never signed in, or signed out.
 * 3. A session whose profile is missing or not approved.
 * 4. A session with an approved profile.
 *
 * Case 3 covers two distinct causes of `profile === null`: the
 * `handle_new_user` trigger racing the first read after sign-up, and a
 * failed fetch (see `useSession`'s doc comment). Both are treated as "not
 * approved" rather than distinguished, because the correct action is
 * identical either way — show the same waiting screen, never the app. Every
 * RLS policy except `profiles_self_read` requires `approved = true`
 * (`supabase/migrations/0003_rls.sql`), so a `null` profile handed to
 * `children` would render a planner that fails every query it makes,
 * instead of a clear message explaining why.
 */
import type { ReactNode } from 'react';
import { Section } from '@astryxdesign/core/Section';
import { VStack } from '@astryxdesign/core/VStack';
import { Spinner } from '@astryxdesign/core/Spinner';
import { useSession } from './useSession';
import { SignInPage } from './SignInPage';
import { PendingApproval } from './PendingApproval';

export interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const { session, profile, loading, signOut } = useSession();

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

  if (profile === null || !profile.approved) {
    const email = profile?.email ?? session.user.email ?? '';
    return <PendingApproval email={email} onSignOut={signOut} />;
  }

  return <>{children}</>;
}
