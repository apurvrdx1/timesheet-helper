import { describe, it, expect, beforeEach } from 'vitest';
import { localOnlyAdapter } from './localOnly';

const config = { backend: 'local' as const, location: '' };

beforeEach(() => { localStorage.clear(); });

describe('localOnlyAdapter', () => {
  it('needs no configuration', () => {
    expect(localOnlyAdapter.validate(config)).toEqual([]);
  });

  it('round-trips a payload', async () => {
    const payload = { OTLs: [['projectCode'], ['P-1001']] } as never;
    await localOnlyAdapter.write(config, payload);
    expect(await localOnlyAdapter.read(config)).toEqual(payload);
  });

  it('returns an empty payload before anything is written', async () => {
    expect(await localOnlyAdapter.read(config)).toEqual({});
  });

  it('survives a throwing storage accessor', async () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    await expect(localOnlyAdapter.read(config)).resolves.toEqual({});
    Storage.prototype.getItem = original;
  });
});

describe('localOnlyAdapter.write: tabs the caller omits', () => {
  it('leaves an omitted tab exactly as it was instead of dropping it', async () => {
    await localOnlyAdapter.write(config, {
      OTLs: [['projectCode'], ['P-1001']],
      People: [['id', 'name', 'Role', 'managerId'], ['p1', 'Alex', 'MANAGER', '']],
    } as never);

    // A later push that could not read People must not cost the user those
    // rows — the same contract both cloud writers keep by not touching the
    // tab at all.
    await localOnlyAdapter.write(config, { OTLs: [['projectCode'], ['P-2002']] } as never);

    expect(await localOnlyAdapter.read(config)).toEqual({
      OTLs: [['projectCode'], ['P-2002']],
      People: [['id', 'name', 'Role', 'managerId'], ['p1', 'Alex', 'MANAGER', '']],
    });
  });
});
