import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PeopleTree } from './PeopleTree';
import type { Person } from '../../domain/types';

const manager: Person = { id: 'mgr-1', name: 'Grace Hopper', role: 'MANAGER', managerId: null };

describe('PeopleTree.handleSave', () => {
  it('adds a manager with no managerId', async () => {
    const onAdd = vi.fn();
    render(<PeopleTree people={[]} hasHours={() => false} onAdd={onAdd} onDelete={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /add manager/i }));
    await userEvent.type(screen.getByLabelText(/name/i), 'Grace Hopper');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const added = onAdd.mock.calls[0]?.[0] as Person;
    expect(added.name).toBe('Grace Hopper');
    expect(added.role).toBe('MANAGER');
    expect(added.managerId).toBeNull();
    expect(typeof added.id).toBe('string');
  });

  // Spec §3.2: "reports can only be created under a manager", enforced
  // entirely by `managerId: dialogRole === 'REPORT' ? manager?.id : null`.
  it('adds a report under the existing manager, assigning the manager\'s id', async () => {
    const onAdd = vi.fn();
    render(<PeopleTree people={[manager]} hasHours={() => false} onAdd={onAdd} onDelete={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /add report/i }));
    await userEvent.type(screen.getByLabelText(/name/i), 'Ada Lovelace');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const added = onAdd.mock.calls[0]?.[0] as Person;
    expect(added.name).toBe('Ada Lovelace');
    expect(added.role).toBe('REPORT');
    expect(added.managerId).toBe('mgr-1');
  });

  it('refuses to save a blank (or whitespace-only) name', async () => {
    const onAdd = vi.fn();
    render(<PeopleTree people={[]} hasHours={() => false} onAdd={onAdd} onDelete={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /add manager/i }));
    await userEvent.type(screen.getByLabelText(/name/i), '   ');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(onAdd).not.toHaveBeenCalled();
  });
});
