/**
 * Shown when the app has a valid session but could not reach the database at
 * all — `useSession`'s `databaseUnreachable` (see `AuthGate`).
 *
 * ## Why this screen exists at all
 *
 * This app runs on a free Supabase project, which is paused after about a week
 * idle. `.github/workflows/keepwarm.yml` exists to prevent that, but a cron job
 * is a thing that can fail. `store.ts` already says exactly the right thing
 * about that (`UNREACHABLE_LOAD_NOTICE`) — and the store lives BEHIND the gate,
 * so on a sleeping project it never mounts. What every user met instead was
 * "Waiting for approval": wrong for an admin, and actively trapping for the
 * OWNER, who was told to wait for an approval only they can give, from behind
 * the gate that hides the Admin tab they would give it from.
 *
 * ## The copy
 *
 * Same three facts as `UNREACHABLE_LOAD_NOTICE`, in the same voice (DESIGN.md
 * §4: name the situation, no apology, no exclamation marks) — the project is
 * most likely asleep, waking it takes about a minute so this will not clear
 * straight away, and the action is to wait and reload. Its fourth sentence
 * ("nothing you change here will be saved") is deliberately NOT repeated:
 * there is nothing on this screen to change.
 *
 * There is no sign-out button, unlike `PendingApproval`. Signing out would
 * clear the session and land the user on a sign-in form that cannot sign
 * anyone in until the same database wakes up — an action that only makes the
 * situation worse. Reloading is the whole of the way out.
 */
import { Section } from '@astryxdesign/core/Section';
import { VStack } from '@astryxdesign/core/VStack';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';

export function DatabaseAsleep() {
  return (
    <Section variant="section">
      <VStack align="center" gap={8}>
        <Card width={420} padding={6}>
          <VStack gap={4}>
            <Heading level={1}>Could not reach the database</Heading>
            <Text type="body">
              It has most likely gone to sleep — that happens when the project sits unused,
              and waking it takes about a minute, so this will not clear straight away. Wait
              a minute, then reload this page; if it still fails, check your connection.
            </Text>
            <Text type="supporting">
              This is not about your account: nothing was refused, the database simply did not
              answer.
            </Text>
          </VStack>
        </Card>
      </VStack>
    </Section>
  );
}
