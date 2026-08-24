# @teincfood/core

TeincFood shared offline-first core — single source of truth for mobile (`TeincFoodBusiness`) and desktop (`TeincFoodDesktop`).

## What lives here (v0.1.0 backbone)

- `types/api/*` — snake_case API contracts matching backend
- `utils/*` — currency, error, format, uuid, order-number (async), etc.
- `sync/*` — engine, command-queue, transports, routing-policy, pending-orders
- `db/*` — migrations + operations (driver-agnostic, takes a `SqliteDriver`)
- `reference/*` — versioned reference-data cache
- `repositories/*` — order/pos repositories
- `adapters/*` — platform seams (KV, SQLite, HTTP, etc.)

## Adapters

Apps supply platform adapters via `createTeincCore({ storage, db, http, ... })`:

- `KVStorage` — async `getItem/setItem/removeItem` (MMKV-wrapped on mobile, `plugin-store` on desktop)
- `SqliteDriver` — `execAsync/runAsync/getFirstAsync/getAllAsync/withTransactionAsync`
- `HttpClient` — axios instance with auth interceptors (token plumbing stays app-side)
- `LanTransport` — `{ isAvailable(), execute(command) }`

## Usage

```ts
import { createTeincCore } from "@teincfood/core";
const core = createTeincCore({ storage, db, http });
```

Apps re-export types via `export * from "@teincfood/core"` barrels to avoid churn.

## Publishing

```bash
yarn build
npm publish --access public
```

## Roadmap

- v0.2 services/stores/hooks
- v0.3 LAN protocol + orchestrator + restart/diagnostics
- v0.4 phoenix/events
