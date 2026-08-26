import { describe, it, expect } from 'vitest';
import { microsoftAdapter } from './microsoft';

const config = {
  backend: 'microsoft' as const,
  location: 'https://contoso-my.sharepoint.com/personal/x/Doc.aspx?sourcedoc=1',
  clientId: '11111111-2222-3333-4444-555555555555',
  authority: 'consumers',
};

describe('microsoftAdapter.validate', () => {
  it('accepts a complete config', () => {
    expect(microsoftAdapter.validate(config)).toEqual([]);
  });

  it('requires a client id', () => {
    expect(microsoftAdapter.validate({ ...config, clientId: '' })).toHaveLength(1);
  });

  it('rejects a client id that is not a GUID', () => {
    expect(microsoftAdapter.validate({ ...config, clientId: 'not-a-guid' }))
      .toHaveLength(1);
  });

  it('requires a workbook link', () => {
    expect(microsoftAdapter.validate({ ...config, location: '' })).toHaveLength(1);
  });

  it('defaults the authority when it is absent', () => {
    expect(microsoftAdapter.validate({ ...config, authority: undefined })).toEqual([]);
  });

  it('never asks for a shared secret', () => {
    const problems = microsoftAdapter.validate({ ...config, secret: undefined });
    expect(problems.join(' ')).not.toMatch(/secret/i);
  });
});
