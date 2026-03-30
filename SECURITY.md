# Security

## Reporting a vulnerability

If you believe you have found a security issue in CronSentinel, please report it responsibly:

- **Preferred:** Open a private security advisory on the repository if GitHub’s “Security” tab and advisories are enabled for the project.
- **Otherwise:** Contact the maintainers through the contact method listed on the repository profile or in published project documentation, and avoid posting exploit details in public issues until they have been addressed.

Include:

- A short description of the issue and its impact
- Steps to reproduce (or a proof-of-concept) if safe to share
- Affected versions or commit range if known

## Scope notes

CronSentinel is intended to be self-hosted. Deployment choices (network exposure, authentication in front of the UI, database credentials, and secrets in environment variables) materially affect risk. Review [DEPLOYMENT.md](DEPLOYMENT.md) for production-oriented settings.

## Supported versions

Security fixes are applied on the active development branch (typically `main`). Use the latest release or commit when deploying to production.
