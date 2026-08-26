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
