import { describe, expect, it } from 'vitest';
import { BlockReason, classifyIp, isBlockedHostname } from './ip-rules.js';

/**
 * SSRF address classification.
 *
 * The cases below are the standard bypass repertoire. Each one has been used
 * against real filters; a rule that only blocks "127.0.0.1 and 10.x" fails
 * most of them.
 */

describe('loopback', () => {
  for (const address of ['127.0.0.1', '127.0.0.2', '127.1.2.3', '127.255.255.254']) {
    it(`blocks ${address}`, () => {
      expect(classifyIp(address)).toMatchObject({
        allowed: false,
        reason: BlockReason.LOOPBACK,
      });
    });
  }

  it('blocks the whole 127/8 range, not just 127.0.0.1', () => {
    expect(classifyIp('127.99.88.77').allowed).toBe(false);
  });

  it('blocks IPv6 loopback', () => {
    expect(classifyIp('::1')).toMatchObject({ allowed: false, reason: BlockReason.LOOPBACK });
    expect(classifyIp('0:0:0:0:0:0:0:1').allowed).toBe(false);
  });
});

describe('private ranges', () => {
  const cases: Array<[string, BlockReason]> = [
    ['10.0.0.1', BlockReason.PRIVATE],
    ['10.255.255.255', BlockReason.PRIVATE],
    ['172.16.0.1', BlockReason.PRIVATE],
    ['172.31.255.255', BlockReason.PRIVATE],
    ['192.168.0.1', BlockReason.PRIVATE],
    ['192.168.255.255', BlockReason.PRIVATE],
    ['100.64.0.1', BlockReason.CARRIER_NAT],
    ['0.0.0.0', BlockReason.UNSPECIFIED],
  ];

  for (const [address, reason] of cases) {
    it(`blocks ${address}`, () => {
      expect(classifyIp(address)).toMatchObject({ allowed: false, reason });
    });
  }

  // 172.15 and 172.32 are OUTSIDE 172.16/12 and must stay reachable — an
  // over-broad rule breaks legitimate destinations.
  it('does not over-block adjacent public ranges', () => {
    expect(classifyIp('172.15.255.255').allowed).toBe(true);
    expect(classifyIp('172.32.0.0').allowed).toBe(true);
    expect(classifyIp('11.0.0.1').allowed).toBe(true);
    expect(classifyIp('192.167.255.255').allowed).toBe(true);
    expect(classifyIp('100.63.255.255').allowed).toBe(true);
  });
});

describe('cloud metadata', () => {
  it('blocks the canonical metadata address distinctly', () => {
    expect(classifyIp('169.254.169.254')).toMatchObject({
      allowed: false,
      reason: BlockReason.CLOUD_METADATA,
    });
  });

  for (const address of ['169.254.170.2', '100.100.100.200', '192.0.0.192']) {
    it(`blocks provider metadata ${address}`, () => {
      expect(classifyIp(address).allowed).toBe(false);
    });
  }

  it('blocks the whole link-local range, not only the metadata IP', () => {
    expect(classifyIp('169.254.1.1')).toMatchObject({
      allowed: false,
      reason: BlockReason.LINK_LOCAL,
    });
  });
});

/**
 * The single most common SSRF filter bypass: wrap a blocked IPv4 address in
 * IPv6 notation so IPv4 rules never see it.
 */
describe('IPv4-mapped IPv6 bypass', () => {
  const cases = [
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.1',
    '0:0:0:0:0:ffff:127.0.0.1',
  ];

  for (const address of cases) {
    it(`unwraps and blocks ${address}`, () => {
      const verdict = classifyIp(address);
      expect(verdict.allowed, `${address} must be blocked`).toBe(false);
      // Reported in its unwrapped IPv4 form so logs are readable.
      expect(verdict.normalised).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    });
  }

  it('also handles the hex-encoded mapped form', () => {
    // ::ffff:7f00:1 is 127.0.0.1
    expect(classifyIp('::ffff:7f00:1').allowed).toBe(false);
  });

  it('still allows a mapped PUBLIC address', () => {
    expect(classifyIp('::ffff:93.184.216.34').allowed).toBe(true);
  });
});

describe('IPv6 internal ranges', () => {
  const cases: Array<[string, BlockReason]> = [
    ['fc00::1', BlockReason.UNIQUE_LOCAL],
    ['fd00::1', BlockReason.UNIQUE_LOCAL],
    ['fd00:ec2::254', BlockReason.UNIQUE_LOCAL],
    ['fe80::1', BlockReason.LINK_LOCAL],
    ['ff02::1', BlockReason.MULTICAST],
    ['::', BlockReason.UNSPECIFIED],
    ['2001:db8::1', BlockReason.RESERVED],
    ['64:ff9b::7f00:1', BlockReason.RESERVED],
  ];

  for (const [address, reason] of cases) {
    it(`blocks ${address}`, () => {
      expect(classifyIp(address)).toMatchObject({ allowed: false, reason });
    });
  }

  it('ignores a zone index when classifying', () => {
    expect(classifyIp('fe80::1%eth0').allowed).toBe(false);
  });

  it('allows ordinary public IPv6', () => {
    expect(classifyIp('2606:4700:4700::1111').allowed).toBe(true);
  });
});

/**
 * Alternative encodings of 127.0.0.1. Different resolvers accept different
 * forms; rather than trying to normalise every one, anything node:net does
 * not recognise as a canonical IP is refused outright.
 */
describe('alternative encodings are refused, never guessed', () => {
  const encodings = [
    '2130706433', // decimal
    '0x7f000001', // hex
    '0177.0.0.1', // octal
    '127.1', // short form
    '127.0.1', // short form
    '010.0.0.1', // leading zero
    '①②⑦.0.0.1', // unicode digits
    '127.0.0.1.', // trailing dot
    '',
    'not-an-ip',
  ];

  for (const value of encodings) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      expect(classifyIp(value).allowed).toBe(false);
    });
  }
});

describe('multicast and reserved', () => {
  it('blocks multicast and broadcast', () => {
    expect(classifyIp('224.0.0.1').allowed).toBe(false);
    expect(classifyIp('239.255.255.255').allowed).toBe(false);
    expect(classifyIp('255.255.255.255').allowed).toBe(false);
  });

  it('blocks documentation and benchmark ranges', () => {
    expect(classifyIp('192.0.2.1').allowed).toBe(false);
    expect(classifyIp('198.18.0.1').allowed).toBe(false);
    expect(classifyIp('203.0.113.1').allowed).toBe(false);
  });
});

describe('public addresses remain reachable', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '52.94.236.248']) {
    it(`allows ${address}`, () => {
      expect(classifyIp(address).allowed).toBe(true);
    });
  }
});

describe('hostname rules', () => {
  const blocked = [
    'localhost',
    'LOCALHOST',
    'localhost.',
    'metadata.google.internal',
    'metadata',
    'instance-data',
    'db.internal',
    'printer.local',
    'app.corp',
    'host.lan',
    'foo.localhost',
  ];

  for (const host of blocked) {
    it(`blocks ${host}`, () => {
      expect(isBlockedHostname(host)).toBe(true);
    });
  }

  const allowed = ['api.anthropic.com', 'api.openai.com', 'example.com', 'localhost-app.com'];
  for (const host of allowed) {
    it(`allows ${host}`, () => {
      expect(isBlockedHostname(host)).toBe(false);
    });
  }
});
