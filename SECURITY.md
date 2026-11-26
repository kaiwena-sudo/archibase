# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting for this repository. Maintainers should enable that feature before making the repository public.

Include the affected URL or file, steps to reproduce the issue, and its likely impact. Do not include credentials or other people's personal data. We don't run a bug bounty.

## Scope

In scope: the API at `api.archibase.dev`, the website at `archibase.dev`, and the code in this repository.

Out of scope: denial-of-service or load testing against the live service, social engineering, and anything that needs access to another person's account or API key.

## What we already protect

- Floor-plan data is held in a private database. Anonymous access is blocked and row-level security is on.
- API keys are stored only as SHA-256 hashes.
- Payments are checked against the server's own terms before any data is returned.
