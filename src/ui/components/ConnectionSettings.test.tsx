import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectionSettings } from './ConnectionSettings';

const google = { backend: 'google' as const, location: '', secret: '' };

describe('ConnectionSettings', () => {
  it('offers all three backends', async () => {
    render(<ConnectionSettings config={google} onChange={vi.fn()} onConnect={vi.fn()} />);
    // Astryx's Selector only exposes its option-role children while open, and
    // is not a native <select> — a real user opens the combobox trigger, then
    // sees the options; that is what we drive here rather than forcing the
    // popup open via a test-only prop. `getByRole('combobox', ...)` is used
    // (not `getByLabelText`) because a closed Selector still pre-mounts its
    // listbox off the accessibility tree but still in the DOM, which makes
    // `getByLabelText` resolve ambiguously.
    await userEvent.click(screen.getByRole('combobox', { name: /backend/i }));
    expect(await screen.findByRole('option', { name: /google/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /microsoft/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /this browser/i })).toBeInTheDocument();
  });

  it('switches backends when a different option is chosen', async () => {
    const onChange = vi.fn();
    render(<ConnectionSettings config={google} onChange={onChange} onConnect={vi.fn()} />);
    await userEvent.click(screen.getByRole('combobox', { name: /backend/i }));
    await userEvent.click(await screen.findByRole('option', { name: /microsoft/i }));
    expect(onChange).toHaveBeenCalledWith({ ...google, backend: 'microsoft' });
  });

  it('asks for a script url and secret for Google', () => {
    render(<ConnectionSettings config={google} onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(screen.getByLabelText(/script url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/shared secret/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/client id/i)).not.toBeInTheDocument();
  });

  it('asks for a client id and workbook link for Microsoft', () => {
    render(<ConnectionSettings
      config={{ backend: 'microsoft', location: '' }}
      onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(screen.getByLabelText(/client id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/workbook link/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/shared secret/i)).not.toBeInTheDocument();
  });

  it('asks for nothing at all for local-only', () => {
    render(<ConnectionSettings
      config={{ backend: 'local', location: '' }}
      onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('surfaces validation problems and blocks connecting', async () => {
    const onConnect = vi.fn();
    render(<ConnectionSettings config={google} onChange={vi.fn()} onConnect={onConnect} />);
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(onConnect).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('warns that a work account may need admin approval', async () => {
    render(<ConnectionSettings
      config={{ backend: 'microsoft', location: '' }}
      onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(screen.getByText(/administrator/i)).toBeInTheDocument();
  });

  it('never renders the secret in a readable field', () => {
    render(<ConnectionSettings
      config={{ ...google, secret: 'hunter2' }}
      onChange={vi.fn()} onConnect={vi.fn()} />);
    expect(screen.getByLabelText(/shared secret/i)).toHaveAttribute('type', 'password');
  });
});
