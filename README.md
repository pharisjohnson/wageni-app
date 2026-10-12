# Wageni

Multi-tenant visitor management and staff attendance SaaS for offices,
government agencies, schools, hospitals, factories and residential complexes.

> **Status:** Phase 1 (foundation) of 8. See [docs/status.md](docs/status.md).

## Quick start

```bash
pnpm install
cp .env.example .env.local
pnpm dev            # public site works without credentials
```

For sign-in and organization features, follow [docs/setup.md](docs/setup.md)
(Convex + Clerk, about 10 minutes).

## Scripts

| | |
| --- | --- |
| `pnpm dev` | Next.js dev server |
| `pnpm convex:dev` | Convex dev deployment, live push and codegen |
| `pnpm typecheck` / `pnpm lint` | Static checks |
| `pnpm test` | Unit + Convex tenant-isolation tests (no credentials needed) |
| `pnpm test:e2e` | Playwright smoke tests |
| `pnpm build` | Production build |

## Docs

- [Setup](docs/setup.md)
- [Architecture](docs/architecture.md): tenancy, auth and the permission model
- [Security notes](docs/security.md)
- [Status](docs/status.md)
