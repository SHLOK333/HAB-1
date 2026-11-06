# Friction: what got in our way

1. **The docs site is two pages deep.** The landing page links only to "Introduction"
   and "Store your first entity". Querying, ordering, paging, batching (`executeBatch`)
   and expiry options we found only by reading the SDK's README and source in
   `node_modules`. A reference page for the query builder and for `executeBatch`
   would have saved us about an hour.
2. **The access key's role was unclear at first.** The landing page links to "Get
   Access Key" but does not say what it does. The first-entity guide explains it
   (rate limits on the public RPC, the key goes into the RPC URL). Saying that on
   the landing page, next to the RPC URL, would help.
3. **A Node warning on every run.** With Node 25.2.1, both our scripts print
   `Warning: --localstorage-file was provided without a valid path` on start. We did
   not pass that flag. Expected: no warning. Reproduce: any script that imports
   `@arkiv-network/sdk` 1.0.0 with `viem` 2.57.14 under Node 25. We have not found
   which package touches `localStorage`.
4. **No explorer link format in the docs.** We wanted each point on our map to link
   to its entity on the explorer, but could not find the URL pattern, so the map shows
   the entity key as text.

5. **`str` values are limited to 128 bytes.** A one-line session note of 143 bytes
   failed. The SDK's error was excellent: it gave the size, the limit and the fix ("store
   the long form in a bytes column"). Saying the limit in the schema docs would have
   caught it before the first write.
6. **Intermittent `executeBatch` failures with no reason.** Three times in about 30
   batches (4 Nov 2026), a batch failed with "Execution error without revert data" or
   "The contract function "execute" returned no data ("0x")"; the same batch went
   through on retry. Once, a batch reported as failed had in fact landed, so retrying
   wrote 7 packets twice (session `three-receivers-20261104`, wallet `0xE060...F0E6`).
   Expected: a reason, and a failure only when nothing was written. Reproduce: write
   batches of 7 to 20 entities from two or three wallets at the same time.
7. **Range filters are not in the docs we found.** `gte`, `lte` and `and` on indexed
   `dec` fields work (our map's box query), but we found them in the SDK's type
   definitions, not in the docs.

What worked well: the schema API (typed values, `defineSchema`, compile-time checks
on `where`) and `executeBatch` writing 6 or 7 entities in one transaction.
