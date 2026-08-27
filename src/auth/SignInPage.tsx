/**
 * The signed-out entry point: sign in with an existing account, or register
 * a new one. Anyone can register (see the module doc on `AuthGate`), so the
 * sign-up path exists purely to collect an email/password pair — it grants
 * no access. The copy after a successful sign-up has to say so plainly, or
 * a new user has no way to know the app isn't broken while they wait.
 */
import { useState } from 'react';
import { Section } from '@astryxdesign/core/Section';
import { VStack } from '@astryxdesign/core/VStack';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { supabase } from './client';

type Mode = 'sign-in' | 'sign-up';

type Status =
  | { kind: 'idle' }
  | { kind: 'error'; message: string }
  | { kind: 'sign-up-complete' };

/** Sets both expectations a new registrant needs, or the wait that follows
 * reads as a failure: the account isn't usable yet for two independent
 * reasons — an unconfirmed address, and an owner who hasn't approved it. */
const SIGN_UP_COPY =
  'Check your email to confirm your address. Once confirmed, an owner needs to approve your ' +
  'account before you can sign in.';

export function SignInPage() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const isSignUp = mode === 'sign-up';

  const toggleMode = (): void => {
    setMode(isSignUp ? 'sign-in' : 'sign-up');
    setStatus({ kind: 'idle' });
  };

  const handleSubmit = async (): Promise<void> => {
    setStatus({ kind: 'idle' });

    try {
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) {
          setStatus({ kind: 'error', message: error.message });
          return;
        }
        setPassword('');
        setMode('sign-in');
        setStatus({ kind: 'sign-up-complete' });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          setStatus({ kind: 'error', message: error.message });
          return;
        }
        // On success `useSession`'s `onAuthStateChange` subscription picks
        // up the new session on its own — nothing else to do here.
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong. Try again.';
      setStatus({ kind: 'error', message });
    }
  };

  return (
    <Section variant="section">
      <VStack align="center" gap={8}>
        <Card width={420} padding={6}>
          <VStack gap={4}>
            <Heading level={1}>{isSignUp ? 'Create an account' : 'Sign in'}</Heading>

            {status.kind === 'sign-up-complete' && (
              <Banner status="success" title={SIGN_UP_COPY} collapsible={false} />
            )}
            {status.kind === 'error' && (
              <Banner status="error" title={status.message} collapsible={false} />
            )}

            <FormLayout>
              <TextInput
                type="email"
                label="Email"
                value={email}
                onChange={setEmail}
                isRequired
                hasAutoFocus
              />
              <TextInput
                type="password"
                label="Password"
                value={password}
                onChange={setPassword}
                isRequired
                onEnter={() => {
                  void handleSubmit();
                }}
              />
            </FormLayout>

            <Button
              label={isSignUp ? 'Create account' : 'Sign in'}
              variant="primary"
              clickAction={handleSubmit}
            />
            <Button
              label={
                isSignUp ? 'Already have an account? Sign in' : 'Need an account? Create one'
              }
              variant="ghost"
              onClick={toggleMode}
            />
          </VStack>
        </Card>
      </VStack>
    </Section>
  );
}
