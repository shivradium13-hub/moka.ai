import { isIP } from 'node:net';

/**
 * IP address classification for SSRF defence (docs/security.md §5).
 *
 * This module is pure and exhaustively tested. It is the part of the SSRF
 * guard that is easiest to get subtly wrong, so it is separated from the
 * networking code entirely.
 *
 * The rule is DENY BY DEFAULT for anything that is not a normal public
 * address. Blocklisting only "localhost and 10.x" is the classic mistake:
 * it misses IPv4-mapped IPv6, CGNAT, link-local, NAT64 and the many
 * alternative spellings of 127.0.0.1.
 */

export const BlockReason = {
  LOOPBACK: 'loopback',
  PRIVATE: 'private',
  LINK_LOCAL: 'link_local',
  CLOUD_METADATA: 'cloud_metadata',
  UNSPECIFIED: 'unspecified',
  MULTICAST: 'multicast',
  RESERVED: 'reserved',
  CARRIER_NAT: 'carrier_nat',
  UNIQUE_LOCAL: 'unique_local',
  NOT_AN_IP: 'not_an_ip',
} as const;

export type BlockReason = (typeof BlockReason)[keyof typeof BlockReason];

export interface IpVerdict {
  readonly allowed: boolean;
  readonly reason?: BlockReason;
  /** Normalised form actually classified (IPv4-mapped IPv6 is unwrapped). */
  readonly normalised: string;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    // Reject leading zeros: "010.0.0.1" is octal in some resolvers and
    // decimal in others, which is exactly the kind of ambiguity an attacker
    // uses to slip a blocked address past a naive parser.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;

    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

interface Cidr {
  readonly base: number;
  readonly bits: number;
  readonly reason: BlockReason;
}

function cidr(range: string, reason: BlockReason): Cidr {
  const [address, prefix] = range.split('/');
  const base = ipv4ToInt(address!);
  if (base === null) throw new Error(`Invalid CIDR in blocklist: ${range}`);
  return { base, bits: Number(prefix), reason };
}

/**
 * IPv4 ranges that must never be reachable from a tenant-triggered request.
 * 169.254.0.0/16 covers the cloud metadata endpoint (169.254.169.254) that is
 * the single highest-value SSRF target on any cloud host.
 */
const BLOCKED_V4: readonly Cidr[] = [
  cidr('0.0.0.0/8', BlockReason.UNSPECIFIED),
  cidr('10.0.0.0/8', BlockReason.PRIVATE),
  cidr('100.64.0.0/10', BlockReason.CARRIER_NAT),
  cidr('127.0.0.0/8', BlockReason.LOOPBACK),
  cidr('169.254.0.0/16', BlockReason.LINK_LOCAL),
  cidr('172.16.0.0/12', BlockReason.PRIVATE),
  cidr('192.0.0.0/24', BlockReason.RESERVED),
  cidr('192.0.2.0/24', BlockReason.RESERVED),
  cidr('192.168.0.0/16', BlockReason.PRIVATE),
  cidr('198.18.0.0/15', BlockReason.RESERVED),
  cidr('198.51.100.0/24', BlockReason.RESERVED),
  cidr('203.0.113.0/24', BlockReason.RESERVED),
  cidr('224.0.0.0/4', BlockReason.MULTICAST),
  cidr('240.0.0.0/4', BlockReason.RESERVED),
];

/** Well-known cloud metadata addresses, reported distinctly for alerting. */
const METADATA_V4: ReadonlySet<string> = new Set([
  '169.254.169.254', // AWS, Azure, GCP, DigitalOcean, OpenStack
  '169.254.170.2', // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud
  '192.0.0.192', // Oracle Cloud
]);

function classifyIpv4(address: string): IpVerdict {
  const value = ipv4ToInt(address);
  if (value === null) {
    return { allowed: false, reason: BlockReason.NOT_AN_IP, normalised: address };
  }

  if (METADATA_V4.has(address)) {
    return { allowed: false, reason: BlockReason.CLOUD_METADATA, normalised: address };
  }

  for (const range of BLOCKED_V4) {
    const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
    if ((value & mask) >>> 0 === (range.base & mask) >>> 0) {
      return { allowed: false, reason: range.reason, normalised: address };
    }
  }

  if (value === 0xffffffff) {
    return { allowed: false, reason: BlockReason.RESERVED, normalised: address };
  }

  return { allowed: true, normalised: address };
}

/** Expand an IPv6 address to its eight 16-bit groups. */
function expandIpv6(address: string): number[] | null {
  let work = address.toLowerCase();

  // Strip a zone index ("fe80::1%eth0"): it does not affect classification.
  const zone = work.indexOf('%');
  if (zone !== -1) work = work.slice(0, zone);

  const doubleColon = work.split('::');
  if (doubleColon.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment === '') return [];
    const parts = segment.split(':');
    const groups: number[] = [];

    for (const [index, part] of parts.entries()) {
      /*
       * A dotted-quad tail ("::ffff:127.0.0.1") is legal IPv6 and is THE
       * common SSRF bypass. It must be decoded into two 16-bit groups rather
       * than rejected: rejecting it happens to block the address, but only by
       * accident, and it wrongly blocks mapped PUBLIC addresses too.
       */
      if (part.includes('.')) {
        if (index !== parts.length - 1) return null;
        const value = ipv4ToInt(part);
        if (value === null) return null;
        groups.push((value >>> 16) & 0xffff, value & 0xffff);
        continue;
      }

      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = parseGroups(doubleColon[0] ?? '');
  const tail = doubleColon.length === 2 ? parseGroups(doubleColon[1] ?? '') : [];
  if (head === null || tail === null) return null;

  if (doubleColon.length === 1) {
    return head.length === 8 ? head : null;
  }

  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

/**
 * IPv4-mapped and IPv4-compatible IPv6 addresses.
 *
 * `::ffff:127.0.0.1` reaches loopback but is not matched by any IPv4 rule
 * unless it is unwrapped first. This is one of the most common SSRF filter
 * bypasses, so the mapped address is extracted and re-classified as IPv4.
 */
function mappedIpv4(groups: number[]): string | null {
  const isMapped =
    groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0);
  if (!isMapped) return null;

  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  // ::0 and ::1 are the unspecified and loopback addresses, not mapped IPv4.
  if (groups[5] === 0 && high === 0 && low <= 1) return null;

  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function classifyIpv6(address: string): IpVerdict {
  const groups = expandIpv6(address);
  if (!groups) {
    return { allowed: false, reason: BlockReason.NOT_AN_IP, normalised: address };
  }

  const mapped = mappedIpv4(groups);
  if (mapped) {
    const verdict = classifyIpv4(mapped);
    return { ...verdict, normalised: mapped };
  }

  const allZero = groups.every((g) => g === 0);
  if (allZero) {
    return { allowed: false, reason: BlockReason.UNSPECIFIED, normalised: '::' };
  }

  const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  if (isLoopback) {
    return { allowed: false, reason: BlockReason.LOOPBACK, normalised: '::1' };
  }

  const first = groups[0] ?? 0;

  // fc00::/7 — unique local addresses.
  if ((first & 0xfe00) === 0xfc00) {
    return { allowed: false, reason: BlockReason.UNIQUE_LOCAL, normalised: address };
  }
  // fe80::/10 — link-local. Includes the IPv6 metadata address fd00:ec2::254
  // only via ULA above; this covers the rest.
  if ((first & 0xffc0) === 0xfe80) {
    return { allowed: false, reason: BlockReason.LINK_LOCAL, normalised: address };
  }
  // ff00::/8 — multicast.
  if ((first & 0xff00) === 0xff00) {
    return { allowed: false, reason: BlockReason.MULTICAST, normalised: address };
  }
  // 2001:db8::/32 — documentation range.
  if (first === 0x2001 && groups[1] === 0x0db8) {
    return { allowed: false, reason: BlockReason.RESERVED, normalised: address };
  }
  // 64:ff9b::/96 — NAT64, which translates to arbitrary IPv4 including private.
  if (first === 0x0064 && groups[1] === 0xff9b) {
    return { allowed: false, reason: BlockReason.RESERVED, normalised: address };
  }

  return { allowed: true, normalised: address };
}

/**
 * Classify a literal IP address.
 *
 * Anything that is not a well-formed public address is rejected, including
 * strings that are not IPs at all — a caller must never be able to smuggle a
 * hostname through this function and have it pass.
 */
export function classifyIp(address: string): IpVerdict {
  const family = isIP(address);
  if (family === 4) return classifyIpv4(address);
  if (family === 6) return classifyIpv6(address);

  // node:net rejected it, but it may still be a form a resolver would accept
  // (e.g. "0177.0.0.1" or "2130706433"). Refuse rather than guess.
  return { allowed: false, reason: BlockReason.NOT_AN_IP, normalised: address };
}

/** Hostnames that must never resolve, regardless of what DNS says. */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  // Cloud metadata service names.
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/** Suffixes that indicate an internal-only namespace. */
const BLOCKED_SUFFIXES: readonly string[] = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.private',
  '.corp',
  '.home',
  '.lan',
];

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
