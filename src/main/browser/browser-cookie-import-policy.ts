import type { Cookie, Cookies } from 'electron'

const GOOGLE_SOURCE_BOUND_COOKIE_NAMES = new Set([
  'SIDCC',
  '__Secure-1PSIDCC',
  '__Secure-3PSIDCC',
  '__Secure-STRP',
  'AEC'
])

export type CookieImportMode = 'merge' | 'replace-imported-domains'

export function normalizeCookieDomain(domain: string): string | null {
  const candidate = domain.trim().replace(/^\.+/, '')
  if (!candidate) {
    return null
  }
  try {
    return new URL(`https://${candidate}/`).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function isGoogleSourceBoundCookie(name: string, domain: string): boolean {
  if (!GOOGLE_SOURCE_BOUND_COOKIE_NAMES.has(name)) {
    return false
  }
  const normalized = normalizeCookieDomain(domain)
  return normalized === 'google.com' || normalized?.endsWith('.google.com') === true
}

function domainSuffixes(domain: string): string[] {
  const labels = domain.split('.')
  return labels.map((_, index) => labels.slice(index).join('.'))
}

function importedDomainScopes(domains: readonly string[]): {
  exact: Set<string>
  ancestors: Set<string>
} {
  const exact = new Set<string>()
  const ancestors = new Set<string>()
  for (const domain of domains) {
    const normalized = normalizeCookieDomain(domain)
    if (!normalized || exact.has(normalized)) {
      continue
    }
    exact.add(normalized)
    for (const suffix of domainSuffixes(normalized)) {
      ancestors.add(suffix)
    }
  }
  return { exact, ancestors }
}

function overlapsImportedDomain(
  domain: string,
  scopes: ReturnType<typeof importedDomainScopes>
): boolean {
  if (scopes.ancestors.has(domain)) {
    return true
  }
  return domainSuffixes(domain).some((suffix) => scopes.exact.has(suffix))
}

function cookieRemovalUrl(cookie: Cookie, domain: string): string | null {
  try {
    const url = new URL(`${cookie.secure ? 'https' : 'http'}://${domain}/`)
    url.pathname = cookie.path?.startsWith('/') ? cookie.path : '/'
    return url.toString()
  } catch {
    return null
  }
}

export async function replaceCookiesForImportedDomains(
  store: Pick<Cookies, 'get' | 'remove'>,
  importedDomains: readonly string[]
): Promise<number> {
  const scopes = importedDomainScopes(importedDomains)
  if (scopes.exact.size === 0) {
    return 0
  }

  const existingCookies = await store.get({})
  let removed = 0
  for (const cookie of existingCookies) {
    const domain = cookie.domain ? normalizeCookieDomain(cookie.domain) : null
    if (!domain || !overlapsImportedDomain(domain, scopes)) {
      continue
    }
    const url = cookieRemovalUrl(cookie, domain)
    if (!url) {
      continue
    }
    await store.remove(url, cookie.name)
    removed++
  }
  return removed
}
