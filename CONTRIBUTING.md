# Contributing to CronSentinel

Thanks for your interest in improving CronSentinel. This project is licensed under [CC BY-NC 4.0](LICENSE); contributions must be compatible with that license.

## Before you start

- Open an issue for large or ambiguous changes so maintainers can align on direction.
- For bug fixes and small improvements, a pull request with a clear description is usually enough.

## Development setup

**Docker (full stack):**

```bash
docker compose up --build
```

Then open `http://localhost:5173` once the frontend and backend are up.

**Frontend with mock API (no Go/Postgres):**

```bash
node mock-backend.js
cd frontend && npm install && npm run dev
```

**Backend only:** see the “Manual Installation” section in [README.md](README.md).

## Guidelines

- Match existing code style, naming, and patterns in touched files.
- Keep changes focused on the issue or feature; avoid unrelated refactors.
- Run tests where they exist (e.g. `go test ./...` in `backend/`, frontend tests if you change covered code).
- Update user-visible docs in the same PR when behavior or configuration changes.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Commit with messages that explain *what* changed and *why* when it is not obvious.
3. Open a PR describing the change, testing performed, and any follow-ups.

## Documentation

- [docs/README.md](docs/README.md) indexes API, deployment, and screenshot galleries.
- Product images live under [assets/](assets/); prefer linking those paths from markdown rather than duplicating files.
