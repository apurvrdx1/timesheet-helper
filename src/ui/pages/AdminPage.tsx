/**
 * The owner-only page for approving new accounts and revoking approved
 * ones. Every account (including the owner's own) comes from `profiles`,
 * readable in full only by the owner (`profiles_owner_reads_all`,
 * `supabase/migrations/0003_rls.sql`) — an admin cannot see this page's
 * data at all, let alone act on it, because `profiles_owner_updates`
 * refuses writes from anyone whose `is_owner` is not true.
 *
 * Approve is disabled until `email_confirmed_at` is non-null (spec §10),
 * which `supabase/migrations/0004_email_verified.sql` mirrors onto
 * `profiles` from `auth.users` for exactly this reason: verification state
 * would otherwise be invisible to this page. A disabled button with no
 * explanation is a puzzle, not a safeguard, so the reason is always shown
 * as visible text next to it, not only as a hover tooltip.
 *
 * Revoke sits behind an `AlertDialog` because it removes someone's access.
 * Its copy states what revocation does and does not do: access stops
 * immediately, the account's data is kept, and re-approving restores it
 * exactly — `profiles_owner_updates` only ever flips `approved`, so no
 * table this account owns is touched by revocation (proven end to end by
 * Task 4's isolation suite: approve -> create data -> revoke -> data still
 * there on re-approval).
 *
 * The owner's own row shows no revoke control at all. The database also
 * refuses it — `profiles_owner_updates` carries `id <> auth.uid()` in both
 * `using` and `with check` — so this is the UI agreeing with the schema
 * rather than being the only guard against an owner locking themselves out.
 */
import { useCallback, useEffect, useState } from 'react';
import { Section } from '@astryxdesign/core/Section';
import { VStack } from '@astryxdesign/core/VStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Banner } from '@astryxdesign/core/Banner';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from '@astryxdesign/core/Table';
import { supabase } from '../../auth/client';
import { useSession } from '../../auth/useSession';

// The raw shape of a `profiles` row as PostgREST returns it — snake_case,
// matching `supabase/migrations/0004_email_verified.sql`. Mapped to
// `AdminProfile` explicitly rather than through an automatic case
// converter, which would silently mangle a field the day someone adds one
// (same convention as `useSession.ts`'s `ProfileRow` / `toProfile`).
interface ProfileRow {
  id: string;
  email: string;
  approved: boolean;
  is_owner: boolean;
  created_at: string;
  email_confirmed_at: string | null;
  /** Written by 0007_revoked_at.sql's trigger, never by a client. Non-null
   *  means this account was approved once and then revoked, which is a
   *  different state from "has never been decided on". */
  revoked_at: string | null;
}

interface AdminProfile {
  id: string;
  email: string;
  approved: boolean;
  isOwner: boolean;
  createdAt: string;
  emailConfirmedAt: string | null;
  revokedAt: string | null;
}

const SELECT_COLUMNS =
  'id, email, approved, is_owner, created_at, email_confirmed_at, revoked_at';

function toAdminProfile(row: ProfileRow): AdminProfile {
  return {
    id: row.id,
    email: row.email,
    approved: row.approved,
    isOwner: row.is_owner,
    createdAt: row.created_at,
    emailConfirmedAt: row.email_confirmed_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Three states, not two (review finding L10).
 *
 * `approved === false` covers two different people: someone who has never been
 * decided on, and someone who was approved and then revoked. Calling the second
 * "Pending approval" reads as though the revoke failed, and invites the owner to
 * approve them again to make the label go away — the one action that undoes what
 * they just did. `revoked_at` is what tells them apart, and the database writes
 * it, so the label cannot disagree with the row.
 */
function statusOf(profile: AdminProfile): { variant: 'success' | 'warning' | 'neutral'; label: string } {
  if (profile.approved) return { variant: 'success', label: 'Approved' };
  if (profile.revokedAt !== null) return { variant: 'neutral', label: 'Revoked' };
  return { variant: 'warning', label: 'Pending approval' };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** DESIGN.md §4's short date form ("Mon 1 Sep"), with a year appended since
 * a registration date can be anything from today back to the app's launch. */
function formatRegisteredAt(iso: string): string {
  const date = new Date(iso);
  const weekday = WEEKDAYS[date.getDay()] ?? '';
  const month = MONTHS[date.getMonth()] ?? '';
  return `${weekday} ${date.getDate()} ${month} ${date.getFullYear()}`;
}

const REVOKE_DESCRIPTION =
  'They lose access immediately. Their data is kept — approving them again restores it exactly.';

const NOT_VERIFIED_REASON = 'Waiting on email confirmation.';

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Something went wrong. Try again.';
}

export function AdminPage() {
  const { session } = useSession();
  const currentUserId = session?.user.id ?? null;

  const [profiles, setProfiles] = useState<AdminProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AdminProfile | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setLoadError(null);
    try {
      // `approved` ascending sorts pending (false) before approved (true) —
      // Postgres orders booleans false-before-true — with registration date
      // as the tie-breaker within each group.
      const { data, error } = await supabase
        .from('profiles')
        .select<typeof SELECT_COLUMNS, ProfileRow>(SELECT_COLUMNS)
        .order('approved', { ascending: true })
        .order('created_at', { ascending: true });

      if (error) {
        setLoadError(error.message);
        setProfiles([]);
      } else {
        setProfiles((data ?? []).map(toAdminProfile));
      }
    } catch (error: unknown) {
      setLoadError(errorMessage(error));
      setProfiles([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = async (profile: AdminProfile): Promise<void> => {
    setActionError(null);
    setPendingActionId(profile.id);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ approved: true })
        .eq('id', profile.id);

      if (error) {
        setActionError(`Could not approve ${profile.email}: ${error.message}`);
        return;
      }

      setProfiles((current) =>
        current.map((existing) => (existing.id === profile.id ? { ...existing, approved: true } : existing)),
      );
    } catch (error: unknown) {
      setActionError(`Could not approve ${profile.email}: ${errorMessage(error)}`);
    } finally {
      setPendingActionId(null);
    }
  };

  const confirmRevoke = async (): Promise<void> => {
    const target = revokeTarget;
    if (target === null) {
      return;
    }

    setActionError(null);
    setPendingActionId(target.id);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ approved: false })
        .eq('id', target.id);

      if (error) {
        setActionError(`Could not revoke ${target.email}: ${error.message}`);
        return;
      }

      // `revoked_at` is set server-side by 0007's trigger and is not read back
      // here, so this mirrors the transition locally to keep the row's label
      // honest until the next load. Only its NULL-ness is ever read
      // (`statusOf`); the client's clock is not presented as the real revocation
      // time anywhere.
      setProfiles((current) =>
        current.map((existing) =>
          existing.id === target.id
            ? { ...existing, approved: false, revokedAt: new Date().toISOString() }
            : existing,
        ),
      );
      setRevokeTarget(null);
    } catch (error: unknown) {
      setActionError(`Could not revoke ${target.email}: ${errorMessage(error)}`);
    } finally {
      setPendingActionId(null);
    }
  };

  // Must agree with `usePendingCount`'s badge, which counts accounts awaiting
  // a FIRST decision — a revoked account is not waiting for anything.
  const pendingCount = profiles.filter(
    (profile) => !profile.approved && profile.revokedAt === null,
  ).length;

  return (
    <Section variant="section">
      <VStack gap={4}>
        <Heading level={1}>Accounts</Heading>

        {loadError !== null && (
          <Banner status="error" title={`Could not load accounts: ${loadError}`} collapsible={false} />
        )}
        {actionError !== null && (
          <Banner status="error" title={actionError} collapsible={false} />
        )}

        {!isLoading && loadError === null && pendingCount === 0 && (
          <Text type="body">Nobody is waiting for approval.</Text>
        )}

        {!isLoading && loadError === null && (
          <Table<Record<string, unknown>>>
            <TableHeader>
              <TableRow>
                <TableHeaderCell scope="col">Email</TableHeaderCell>
                <TableHeaderCell scope="col">Registered</TableHeaderCell>
                <TableHeaderCell scope="col">Email verified</TableHeaderCell>
                <TableHeaderCell scope="col">Status</TableHeaderCell>
                <TableHeaderCell scope="col">Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((profile) => {
                const isSelf = profile.id === currentUserId;
                const isEmailVerified = profile.emailConfirmedAt !== null;
                const isBusy = pendingActionId === profile.id;

                return (
                  <TableRow key={profile.id}>
                    <TableCell>
                      <Text type="body">{profile.email}</Text>
                    </TableCell>
                    <TableCell>
                      <Text type="body">{formatRegisteredAt(profile.createdAt)}</Text>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={isEmailVerified ? 'success' : 'neutral'}
                        label={isEmailVerified ? 'Verified' : 'Not verified'}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={statusOf(profile).variant}
                        label={statusOf(profile).label}
                      />
                    </TableCell>
                    <TableCell>
                      {!profile.approved && (
                        <VStack gap={1}>
                          <Button
                            label={`Approve ${profile.email}`}
                            variant="primary"
                            isDisabled={!isEmailVerified || isBusy}
                            tooltip={isEmailVerified ? undefined : NOT_VERIFIED_REASON}
                            clickAction={() => approve(profile)}
                          >
                            Approve
                          </Button>
                          {!isEmailVerified && (
                            <Text type="supporting" color="secondary">
                              {NOT_VERIFIED_REASON}
                            </Text>
                          )}
                        </VStack>
                      )}
                      {profile.approved && !isSelf && (
                        <Button
                          label={`Revoke ${profile.email}`}
                          variant="secondary"
                          isDisabled={isBusy}
                          onClick={() => setRevokeTarget(profile)}
                        >
                          Revoke
                        </Button>
                      )}
                      {profile.approved && isSelf && (
                        <Text type="supporting" color="secondary">
                          This is you
                        </Text>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <AlertDialog
          isOpen={revokeTarget !== null}
          onOpenChange={(open) => {
            if (!open) {
              setRevokeTarget(null);
            }
          }}
          title={revokeTarget ? `Revoke access for ${revokeTarget.email}?` : ''}
          description={REVOKE_DESCRIPTION}
          actionLabel="Revoke access"
          isActionLoading={revokeTarget !== null && pendingActionId === revokeTarget.id}
          onAction={confirmRevoke}
        />
      </VStack>
    </Section>
  );
}
