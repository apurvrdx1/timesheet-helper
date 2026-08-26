import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupPage } from './SetupPage';
import type { Model } from '../../domain/types';

// jsdom (this project's `src/test-setup.ts`, which this file must not edit
// per the task's storage-isolation constraint) does not implement
// `window.matchMedia`, which Astryx's DateInput reads for coarse-pointer
// detection. Without this, every test that renders the stat-holiday
// section's DateInput fails before any assertion runs.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

const empty: Model = {
  otls: [], people: [], statHolidays: [], allocations: [], leave: [], overrides: [],
};

describe('SetupPage', () => {
  it('adds an OTL with all five fields', async () => {
    const update = vi.fn();
    render(<SetupPage model={empty} update={update} />);
    await userEvent.click(screen.getByRole('button', { name: /add otl/i }));
    await userEvent.type(screen.getByLabelText(/project code/i), 'P-1001');
    await userEvent.type(screen.getByLabelText(/task code/i), 'T1');
    await userEvent.type(screen.getByLabelText(/expenditure type/i), 'E1');
    await userEvent.type(screen.getByLabelText(/time reporting/i), 'R1');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(update).toHaveBeenCalled();
  });

  it('rejects a duplicate project code, since it is the primary key', async () => {
    const model: Model = { ...empty, otls: [{
      projectCode: 'P-1001', taskCode: 'T1', expenditureTypeCode: 'E1',
      timeReportingCode: 'R1', category: 'CAPEX', leaveSubtype: null,
      isDefaultOpex: false, colorIndex: 1, active: true,
    }] };
    render(<SetupPage model={model} update={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /add otl/i }));
    await userEvent.type(screen.getByLabelText(/project code/i), 'P-1001');
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it('requires a leave subtype when the category is Leave', async () => {
    render(<SetupPage model={empty} update={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /add otl/i }));
    // Astryx's Selector only exposes its option-role children while open, and
    // is not a native <select> — `selectOptions` (which requires one) does not
    // apply. A real user opens the combobox trigger, then clicks the option;
    // that is what we drive here rather than forcing the popup open via a
    // test-only prop (see SetupPage.tsx category Selector for the rationale).
    await userEvent.click(screen.getByLabelText(/category/i));
    await userEvent.click(await screen.findByRole('option', { name: /^leave$/i }));
    // `getByLabelText` would also match the (closed, but still DOM-present)
    // subtype listbox — Astryx pre-mounts a Selector's popup content off the
    // accessibility tree rather than removing it from the DOM. `getByRole`
    // respects that: a role query only sees what's actually exposed, so it
    // resolves to the one combobox trigger.
    expect(screen.getByRole('combobox', { name: /subtype/i })).toBeInTheDocument();
  });

  it('only offers to add a report under a manager', async () => {
    render(<SetupPage model={empty} update={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /add report/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add manager/i })).toBeInTheDocument();
  });

  it('allows only one manager', async () => {
    const model: Model = { ...empty, people: [
      { id: 'm', name: 'Manager', role: 'MANAGER', managerId: null },
    ] };
    render(<SetupPage model={model} update={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /add manager/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add report/i })).toBeInTheDocument();
  });
});
