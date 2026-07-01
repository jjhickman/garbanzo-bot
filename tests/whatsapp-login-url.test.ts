process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  isLoopbackHost,
  isNetworkExposedHost,
  isWildcardHost,
  resolveLoginHosts,
} from '../src/platforms/whatsapp/login-url.js';

function iface(partial: Partial<NetworkInterfaceInfo>): NetworkInterfaceInfo {
  return {
    address: '0.0.0.0',
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: null,
    ...partial,
  } as NetworkInterfaceInfo;
}

describe('login url host resolution', () => {
  it('returns the bind host unchanged for a concrete address', () => {
    expect(resolveLoginHosts('127.0.0.1', {})).toEqual(['127.0.0.1']);
    expect(resolveLoginHosts('192.168.1.10', {})).toEqual(['192.168.1.10']);
  });

  it('surfaces non-internal IPv4 LAN addresses for a wildcard bind', () => {
    const interfaces = {
      lo: [iface({ address: '127.0.0.1', internal: true })],
      eth0: [
        iface({ address: '192.168.1.50', internal: false }),
        iface({ address: 'fe80::1', family: 'IPv6', internal: false }),
      ],
    };
    expect(resolveLoginHosts('0.0.0.0', interfaces)).toEqual(['192.168.1.50']);
  });

  it('falls back to the bind host when no external address exists', () => {
    const interfaces = { lo: [iface({ address: '127.0.0.1', internal: true })] };
    expect(resolveLoginHosts('0.0.0.0', interfaces)).toEqual(['0.0.0.0']);
  });

  it('surfaces bracketed IPv6 addresses for an IPv6 wildcard bind', () => {
    const interfaces = {
      eth0: [
        iface({ address: '192.168.1.50', internal: false }),
        iface({ address: '2001:db8::5', family: 'IPv6', internal: false }),
      ],
    };
    expect(resolveLoginHosts('::', interfaces)).toEqual(['192.168.1.50', '[2001:db8::5]']);
  });

  it('classifies wildcard, loopback, and exposed hosts', () => {
    expect(isWildcardHost('0.0.0.0')).toBe(true);
    expect(isWildcardHost('::')).toBe(true);
    expect(isWildcardHost('127.0.0.1')).toBe(false);

    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);

    // Exposed = anything reachable off the loopback interface.
    expect(isNetworkExposedHost('127.0.0.1')).toBe(false);
    expect(isNetworkExposedHost('localhost')).toBe(false);
    expect(isNetworkExposedHost('0.0.0.0')).toBe(true);
    expect(isNetworkExposedHost('192.168.1.10')).toBe(true);
  });
});
