/**
 * Shown for a session the app cannot yet let in: the account exists and has
 * a valid session, but its `profiles` row is either not approved or not
 * there to read yet (see `AuthGate`). Per DESIGN.md §4 this names the
 * situation plainly — no apology, no exclamation marks, sentence case.
 */
import { Section } from '@astryxdesign/core/Section';
import { VStack } from '@astryxdesign/core/VStack';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';

export interface PendingApprovalProps {
  /** The signed-in address, shown so the user can confirm they registered
   * the account they think they did. */
  email: string;
  onSignOut: () => Promise<void>;
}

export function PendingApproval({ email, onSignOut }: PendingApprovalProps) {
  return (
    <Section variant="section">
      <VStack align="center" gap={8}>
        <Card width={420} padding={6}>
          <VStack gap={4}>
            <Heading level={1}>Waiting for approval</Heading>
            <Text type="body">
              Your account is registered and waiting for an owner to approve it. You will get
              access to Timesheet Helper once that happens.
            </Text>
            {email.length > 0 && <Text type="supporting">Signed in as {email}.</Text>}
            <Button label="Sign out" variant="secondary" clickAction={() => onSignOut()} />
          </VStack>
        </Card>
      </VStack>
    </Section>
  );
}
