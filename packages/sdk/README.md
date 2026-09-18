# @aabxtract/programmable-sdk

TypeScript SDK for the [Programmable Market](https://programmable.market) API,
defaulting to Robinhood Chain (chainId 4663).

```bash
npm install @aabxtract/programmable-sdk
```

```typescript
import { createClient } from "@aabxtract/programmable-sdk";

const client = createClient();

const feed = await client.launches.listPage({ limit: 10 });
console.log(feed.status, feed.items.length);
```

Zero runtime dependencies. Node ≥ 20.6.

## Three origins, not one

The platform spans three hosts, and the client knows all of them:

| Origin | Host | Auth |
|---|---|---|
| Discovery | `programmable.market` | none |
| Public read API (v2) | `developers.programmable.family` | none |
| Custom launch API (v4) | `api.programmable.market` | Bearer key |

`createClientFromManifest()` reads the well-known manifest and configures these from
whatever the platform currently publishes, which is what the manifest exists for.

## Two things that will bite you

**The feed is often `degraded`.** Absence is not authoritative — an empty result does
not mean a token doesn't exist. Check `feed.status` before concluding anything.

**Stock-paired launches are not available.** They're explicitly excluded from the v2
Developer API. `getStockPaired()` throws `ProgrammableUnsupportedError` rather than
returning a misleading `[]`.

Full docs: see `BUILD_GUIDE.md` in the repository.
