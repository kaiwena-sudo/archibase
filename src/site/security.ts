/**
 * Security headers for every response (SEC-04). The explorer signs payments in the browser, so it must
 * not be framed (clickjacking) and must not run injected script. The one inline script (the footer's tab
 * switcher) is allowed by hash; a test recomputes the hash from the page so the two cannot drift.
 */
export const FOOTER_SCRIPT_SHA256 = "4XrEG1oF22VhgFjSBZrsVmLWCSA/cMRrd+9oSYrWwxE=";

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    // Cloudflare injects its analytics beacon on archibase.dev pages.
    `script-src 'self' 'sha256-${FOOTER_SCRIPT_SHA256}' https://static.cloudflareinsights.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    // The explorer calls the paid API on its own subdomains, and the beacon reports to cloudflareinsights.
    "connect-src 'self' https://api.archibase.dev https://testnet.archibase.dev https://cloudflareinsights.com",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
