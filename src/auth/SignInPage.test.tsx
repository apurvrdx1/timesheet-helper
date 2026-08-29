import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthApiError } from '@supabase/supabase-js';

// `client.ts` throws at module scope when the Supabase env vars are absent
// (true under `npx vitest run`, no `.env.local` in CI). This component's
// import graph reaches it directly (it calls `supabase.auth.*`), so it must
// be mocked exactly per A8 / the pattern `useSession.test.ts` established.
vi.mock('./client', () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
    },
  },
}));

import { supabase } from './client';
import { SignInPage } from './SignInPage';

interface MockedSupabase {
  auth: {
    signInWithPassword: Mock<
      (credentials: { email: string; password: string }) => Promise<{
        error: { message: string } | null;
      }>
    >;
    signUp: Mock<
      (credentials: { email: string; password: string }) => Promise<{
        error: { message: string } | null;
      }>
    >;
  };
}

const mockedSupabase = supabase as unknown as MockedSupabase;

function makeAuthApiError(message: string): AuthApiError {
  return new AuthApiError(message, 400, 'user_already_exists');
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('SignInPage', () => {
  it('defaults to sign-in mode with an email and a password field', () => {
    render(<SignInPage />);

    expect(screen.getByRole('heading', { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    const password = screen.getByLabelText(/password/i);
    expect(password).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('submits credentials to signInWithPassword', async () => {
    mockedSupabase.auth.signInWithPassword.mockResolvedValue({ error: null });

    render(<SignInPage />);
    await userEvent.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(mockedSupabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'alice@example.com',
      password: 'hunter2',
    });
  });

  it('surfaces a sign-in error instead of failing silently', async () => {
    mockedSupabase.auth.signInWithPassword.mockResolvedValue({
      error: { message: 'Invalid login credentials' },
    });

    render(<SignInPage />);
    await userEvent.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText(/invalid login credentials/i)).toBeInTheDocument();
  });

  it('toggles to sign-up mode and back', async () => {
    render(<SignInPage />);

    await userEvent.click(screen.getByRole('button', { name: /need an account\? create one/i }));
    expect(screen.getByRole('heading', { name: /create an account/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: /already have an account\? sign in/i }),
    );
    expect(screen.getByRole('heading', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('on successful registration, tells the user to verify their email AND that an owner must approve them', async () => {
    mockedSupabase.auth.signUp.mockResolvedValue({ error: null });

    render(<SignInPage />);
    await userEvent.click(screen.getByRole('button', { name: /need an account\? create one/i }));
    await userEvent.type(screen.getByLabelText(/email/i), 'newperson@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    const banner = await screen.findByText(/check your email to confirm your address/i);
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/owner needs to approve your account/i);
  });

  it('surfaces a duplicate-address sign-up error rather than failing silently', async () => {
    mockedSupabase.auth.signUp.mockResolvedValue({
      error: makeAuthApiError('User already registered'),
    });

    render(<SignInPage />);
    await userEvent.click(screen.getByRole('button', { name: /need an account\? create one/i }));
    await userEvent.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/user already registered/i)).toBeInTheDocument();
    // Did not silently switch to the "check your email" success state.
    expect(screen.queryByText(/check your email to confirm/i)).not.toBeInTheDocument();
  });
});
