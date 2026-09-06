import { describe, expect, it } from 'vitest';
import { TenantMismatchError, createUserTenantContext, SystemRole } from '@moka/core';
import { assertBelongsToTenant, detectTenantOverrides, stripTenantKeys } from './index.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const contextA = createUserTenantContext({
  organizationId: ORG_A,
  userId: '33333333-3333-4333-8333-333333333333',
  role: SystemRole.ADMIN,
});

describe('detectTenantOverrides', () => {
  it('finds a conflicting organization id in the body', () => {
    const found = detectTenantOverrides({ body: { organizationId: ORG_B, name: 'x' } }, ORG_A);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ location: 'body', conflicting: true });
  });

  /*
   * A matching value is still a violation. Accepting it would let an attacker
   * enumerate valid organization ids by observing which are rejected.
   */
  it('reports a MATCHING organization id as a violation too', () => {
    const found = detectTenantOverrides({ body: { organizationId: ORG_A } }, ORG_A);
    expect(found).toHaveLength(1);
    expect(found[0]?.conflicting).toBe(false);
  });

  it('detects every naming variant', () => {
    for (const key of [
      'organizationId',
      'organization_id',
      'orgId',
      'org_id',
      'tenantId',
      'tenant_id',
      'organization',
      'tenant',
    ]) {
      expect(detectTenantOverrides({ body: { [key]: ORG_B } }, ORG_A), key).toHaveLength(1);
    }
  });

  it('scans query, headers and params as well as body', () => {
    expect(detectTenantOverrides({ query: { org_id: ORG_B } }, ORG_A)).toHaveLength(1);
    expect(detectTenantOverrides({ headers: { 'tenant-id': ORG_B } }, ORG_A)).toHaveLength(1);
    expect(detectTenantOverrides({ params: { organizationId: ORG_B } }, ORG_A)).toHaveLength(1);
  });

  it('reports each location separately when several are used', () => {
    const found = detectTenantOverrides(
      { body: { organizationId: ORG_B }, query: { tenant_id: ORG_B } },
      ORG_A,
    );
    expect(found).toHaveLength(2);
    expect(found.map((v) => v.location).sort()).toEqual(['body', 'query']);
  });

  it('ignores ordinary payloads', () => {
    expect(detectTenantOverrides({ body: { name: 'Alpha', slug: 'alpha' } }, ORG_A)).toHaveLength(0);
    expect(detectTenantOverrides({}, ORG_A)).toHaveLength(0);
    expect(detectTenantOverrides({ body: null, query: undefined }, ORG_A)).toHaveLength(0);
  });

  it('does not treat arrays or primitives as objects to scan', () => {
    expect(detectTenantOverrides({ body: [1, 2, 3] }, ORG_A)).toHaveLength(0);
    expect(detectTenantOverrides({ body: 'organizationId' }, ORG_A)).toHaveLength(0);
  });
});

describe('stripTenantKeys', () => {
  it('removes tenant keys and keeps the rest', () => {
    expect(stripTenantKeys({ name: 'Alpha', organizationId: ORG_B, slug: 'a' })).toEqual({
      name: 'Alpha',
      slug: 'a',
    });
  });

  it('removes every naming variant', () => {
    expect(stripTenantKeys({ org_id: 'x', tenantId: 'y', TENANT_ID: 'z', keep: 1 })).toEqual({
      keep: 1,
    });
  });

  it('leaves clean payloads untouched', () => {
    expect(stripTenantKeys({ name: 'Alpha' })).toEqual({ name: 'Alpha' });
  });
});

describe('assertBelongsToTenant', () => {
  it('accepts a record from the bound organization', () => {
    expect(() => assertBelongsToTenant({ organizationId: ORG_A }, contextA, 'project')).not.toThrow();
  });

  it('tolerates a null record', () => {
    expect(() => assertBelongsToTenant(null, contextA, 'project')).not.toThrow();
  });

  /*
   * This should be unreachable while RLS is intact. It exists so that a
   * missing policy fails loudly instead of leaking silently.
   */
  it('throws when a foreign record becomes reachable', () => {
    expect(() => assertBelongsToTenant({ organizationId: ORG_B }, contextA, 'project')).toThrow(
      TenantMismatchError,
    );
  });
});
