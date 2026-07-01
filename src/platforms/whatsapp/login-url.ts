import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** True when the bind host means "listen on every interface". */
export function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host);
}

/** True when the bind host is loopback-only (not reachable off the machine). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** True when the login routes would be reachable from other machines. */
export function isNetworkExposedHost(host: string): boolean {
  return !isLoopbackHost(host);
}

/**
 * Resolve the hostnames a remote browser can actually connect to.
 *
 * A concrete bind host is returned unchanged. For a wildcard bind (`0.0.0.0` /
 * `::`) the process listens on every interface, so `0.0.0.0` itself is not a
 * connectable target — instead we surface the machine's non-internal LAN
 * addresses. IPv6 addresses are bracketed for URL use, and are only included
 * for an IPv6 wildcard bind. Falls back to the bind host when no external
 * address can be found.
 */
export function resolveLoginHosts(
  bindHost: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  if (!isWildcardHost(bindHost)) return [bindHost];

  const includeIpv6 = bindHost === '::' || bindHost === '[::]';
  const hosts: string[] = [];

  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      if (info.family === 'IPv4') hosts.push(info.address);
      else if (info.family === 'IPv6' && includeIpv6) hosts.push(`[${info.address}]`);
    }
  }

  return hosts.length > 0 ? hosts : [bindHost];
}
