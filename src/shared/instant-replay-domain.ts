/**
 * Instant Replay domain allowlist: normalize host patterns and match tab URLs.
 *
 * Patterns are hostnames only (no protocol/path). Optional leading `*.` means
 * the apex and any subdomain (e.g. `*.example.com` matches `example.com` and
 * `app.example.com`, not `evil-example.com`).
 */

export const INSTANT_REPLAY_ALLOWED_DOMAINS_MAX = 50;

/**
 * Strip protocol, path, port noise into a hostname or `*.hostname` pattern.
 * Returns null when the input cannot yield a usable host.
 */
export function normalizeInstantReplayDomainPattern(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  let value = raw.trim().toLowerCase();
  if (!value) {
    return null;
  }
  // Users often paste full URLs.
  value = value.replace(/^\*:\/\//, "");
  value = value.replace(/^https?:\/\//, "");
  value = value.replace(/^\/\//, "");
  // Drop path / query / fragment.
  value = value.split("/")[0] ?? value;
  value = value.split("?")[0] ?? value;
  value = value.split("#")[0] ?? value;
  // Drop credentials.
  const at = value.lastIndexOf("@");
  if (at >= 0) {
    value = value.slice(at + 1);
  }

  let wildcard = false;
  if (value.startsWith("*.")) {
    wildcard = true;
    value = value.slice(2);
  } else if (value.startsWith("*") && value.length > 1 && value[1] !== ".") {
    // Reject bare `*foo.com` — require `*.` form.
    return null;
  }

  // Strip port after host.
  if (value.includes(":") && !value.startsWith("[")) {
    value = value.split(":")[0] ?? value;
  }

  value = value.replace(/^\.+/, "").replace(/\.+$/, "");
  if (!value || value.includes("*") || value.includes(" ")) {
    return null;
  }
  // localhost and numeric hosts allowed; no empty labels.
  if (value.split(".").some((part) => part.length === 0)) {
    return null;
  }

  return wildcard ? `*.${value}` : value;
}

/**
 * Dedupe + clamp a list of domain patterns from settings / UI.
 */
export function normalizeInstantReplayAllowedDomains(
  raw: unknown,
  max: number = INSTANT_REPLAY_ALLOWED_DOMAINS_MAX,
): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const pattern = normalizeInstantReplayDomainPattern(item);
    if (!pattern || seen.has(pattern)) {
      continue;
    }
    seen.add(pattern);
    out.push(pattern);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

/**
 * Hostname from a tab URL. Null for chrome://, about:, extension pages, etc.
 */
export function hostnameFromTabUrl(url: string | undefined | null): string | null {
  if (!url || typeof url !== "string") {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Whether `hostname` is covered by a single allowlist pattern.
 */
export function hostnameMatchesDomainPattern(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const pat = pattern.toLowerCase();
  if (pat.startsWith("*.")) {
    const base = pat.slice(2);
    if (!base) {
      return false;
    }
    return host === base || host.endsWith(`.${base}`);
  }
  return host === pat;
}

/**
 * True when hostname matches any pattern in the allowlist.
 * Empty allowlist matches nothing (safe default — no CDP until user adds sites).
 */
export function hostnameMatchesInstantReplayAllowlist(
  hostname: string | null | undefined,
  allowlist: readonly string[],
): boolean {
  if (!hostname || allowlist.length === 0) {
    return false;
  }
  return allowlist.some((pattern) => hostnameMatchesDomainPattern(hostname, pattern));
}

export function tabUrlMatchesInstantReplayAllowlist(
  url: string | undefined | null,
  allowlist: readonly string[],
): boolean {
  return hostnameMatchesInstantReplayAllowlist(hostnameFromTabUrl(url), allowlist);
}
