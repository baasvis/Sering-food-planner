# Unified-batch-inventory deploy sequence

The unified-batch-inventory rewrite (May 2026) ships as **one Prisma
migration** (`add_cols`), **one TypeScript data-movement script**
(data-migrate), **one manual psql step** (drop_cols), and **one
post-deploy reconciliation migration** (hand-rolled with
`prisma migrate diff` + `IF EXISTS` guards). Apply them in this exact
order.

> **Why drop_cols is NOT a Prisma migration file**: Railway auto-deploys
> `prisma migrate deploy` on every push. If drop_cols were committed as
> `prisma/migrations/<ts>_drop_cols/migration.sql`, Railway would apply
> it immediately after `add_cols`, **before** the manual data-migrate
> step runs — destroying legacy data before it could be migrated.
> Keeping drop_cols here as a documented psql snippet means Daan
> controls the order during the deploy window.

## One-time prerequisites

- `pg_dump` AND `psql` on PATH (Postgres 15+ client tools — Railway
  runs Postgres 15).
- Coordinated deploy window with Daan — kitchen runs the app daily
  07:00–22:00. Pick a quiet hour and warn the team.
- **Run the bash commands from Git Bash or WSL**, not PowerShell. The
  `$DATABASE_URL`, `< file` redirect, and `mkdir -p` syntax below are
  bash-only; PowerShell will silently misinterpret them.

## Sequence (executed at the Checkpoint 6 deploy window)

1. **Snapshot** — back up production before any changes.
   ```
   node scripts/snapshot-db.js --db "$DATABASE_URL" --out ./pre-unify-snapshot.sql
   ```
   Verify the resulting `.sql` round-trips into a scratch DB before
   continuing (the script logs a `psql ... < snapshot.sql` recipe).
   Without a verified restore path, this is not a real backup.

2. **Enable maintenance mode** — close the write door before any
   schema or data change touches prod.

   In the Railway dashboard, set the env var:
   ```
   MAINTENANCE_MODE=1
   ```
   Railway will redeploy automatically (~1 minute). Once redeployed,
   every write endpoint returns 503 `{ error: 'maintenance', message: 'Planner is upgrading. Please refresh in a few minutes.' }`.
   Reads, login, telemetry, and SSE keep working — cooks can still see
   the planner, they just can't save anything. Frontend's debounced
   save retries on 5xx with exponential backoff, so once you turn the
   flag off, any saves queued during the window drain naturally.

   This step closes the corruption window where a cook saving during
   the deploy could strand legacy `stock`/`location`/`storage` data
   that the data-migrate script would then skip. With MAINTENANCE_MODE
   on, no writes can land; the script sees clean pre-migration rows.

   **Heads-up to the team in chat before flipping**: "Planner upgrade
   in progress — saves disabled for ~10 minutes. Don't refresh."

3. **Apply add-cols migration** (additive, safe). At this point app
   code on `main` (newly deployed by Railway) is already reading the
   new `inventory`/`shipments` shape — but those columns are empty
   JSONB arrays for every row until step 5 runs. MAINTENANCE_MODE
   from step 2 is the only thing keeping cooks from saving against
   this in-between state.
   ```
   npx prisma migrate deploy
   ```
   Applies `20260511120000_unified_batch_inventory_add_cols`, which adds
   `inventory JSONB DEFAULT '[]'` and `shipments JSONB DEFAULT '[]'` to
   `batches`. Existing rows now have empty arrays; the legacy cols are
   still present and populated.

4. **Dry-run the data migrate** — review the proposed mutations.
   ```
   npm run migrate:data-migrate:dry -- --db "$DATABASE_URL" --allow-prod
   ```
   Inspect the output: family counts, catering rewrites, anomaly block.
   Cycle warnings, big-family notices, and name/type divergences are
   non-blocking but worth a spot-check.

5. **Run the data migrate** — populates `inventory` + `shipments`,
   deletes collapsed children, rewrites + dedups catering refs (audit
   S6 fix), writes one activity-log row.
   ```
   npm run migrate:data-migrate -- --db "$DATABASE_URL" --allow-prod
   ```
   > Note: `--allow-prod` is intentional here — it bypasses the
   > staging-only safety guard for the actual prod migration. The guard
   > exists so the script refuses to run against prod by accident from
   > a developer machine.

   Single transaction with a 60s timeout — partial-state crash is
   impossible. Idempotent — a re-run after success is a no-op
   (per-batch guard skips already-migrated rows).

6. **Apply drop-cols via psql** (destructive — NOT a Prisma migration
   file; see explanation at the top).

   > ⚠️ STOP — must run AFTER data-migrate (step 5) succeeds.

   The SQL lives at `prisma/migrations/drop-cols.sql` (top level of
   `prisma/migrations/`, NOT under a `<ts>_*/` directory — that's why
   Prisma's migration loader skips it). Apply it directly:
   ```
   psql "$DATABASE_URL" < prisma/migrations/drop-cols.sql
   ```
   By this point, app code on `main` already reads inventory/shipments
   only (Task 3A stripped the legacy fields from `prisma/schema.prisma`
   and rewrote `lib/ai-analyzer.ts` + `routes/recipes.ts:642`). The
   running app won't notice the columns disappearing.

   The SQL is fully `IF EXISTS`-guarded, so re-running step 6 against
   an already-migrated DB is a no-op.

7. **Smoke test under maintenance** — with MAINTENANCE_MODE still on,
   open the app yourself, navigate the planner / dishes / orders
   screens. You won't be able to save anything (503), but you'll see
   whether reads render the migrated data correctly. Watch the
   activity log for the `system / migration / unified-batch-collapse`
   entry confirming the data move ran.

8. **Disable maintenance mode**. In the Railway dashboard, unset
   `MAINTENANCE_MODE` (delete the env var, or set it to `0`). Railway
   redeploys (~1 minute). Once it's back up, do one real cook-flow
   action (mark something cooked, send to Centraal, mark arrived) to
   confirm writes flow end-to-end. Cooks' queued saves from the
   maintenance window will retry automatically as the backoff timer
   fires.

9. **Reconcile Prisma migration history** — record that the schema is
   already in its post-drop state.

   > ⚠️ DO NOT RUN `npx prisma migrate dev` ON PROD.
   >
   > `migrate dev` builds a shadow DB by replaying ALL migrations in
   > `prisma/migrations/`, then diffs the shadow against prod. Because
   > step 6's SQL is OUTSIDE Prisma's migration history, the shadow DB
   > would contain the FULL legacy schema (stock/location/storage/
   > parentId/etc.) while prod has those cols dropped. Prisma detects
   > drift and offers `migrate reset` — which **WIPES THE DATABASE**.
   >
   > Use the four sub-steps below instead. They're production-safe
   > because they generate the reconciliation SQL *locally* via
   > `prisma migrate diff` (no DB writes from Daan's machine), then
   > Railway's normal `prisma migrate deploy` applies the resulting
   > migration file (which is `IF EXISTS`-guarded so it's a no-op
   > against the already-dropped prod DB).

   **9a.** Generate the reconciliation SQL locally (does NOT touch any DB):
   ```
   npx prisma migrate diff \
     --from-migrations prisma/migrations \
     --to-schema-datamodel prisma/schema.prisma \
     --script > /tmp/post-unify-cleanup.sql
   ```
   Expected output: ~11 DDL statements — 1 `ALTER TABLE ... DROP
   CONSTRAINT` (parent_id_fkey), 2 `DROP INDEX` (parent_id_idx,
   location_idx), and 8 `ALTER TABLE ... DROP COLUMN` (parent_id,
   location, stock, storage, in_transit, recipe_sheet_id,
   recipe_volume, recipe_ingredients). Same shape as step 6's
   drop-cols.sql, generated fresh by Prisma off the schema/migrations
   pair so it stays in sync if anything's added since.

   **9b.** Hand-edit `/tmp/post-unify-cleanup.sql` to add `IF EXISTS`
   guards to every `DROP` statement. Prisma's `--script` output omits
   them by default, which would cause `column "stock" does not exist`
   errors on apply (since step 6 already dropped them). Concrete:
   - `ALTER TABLE "batches" DROP CONSTRAINT "batches_parent_id_fkey";`
     → `ALTER TABLE "batches" DROP CONSTRAINT IF EXISTS "batches_parent_id_fkey";`
   - `DROP INDEX "batches_parent_id_idx";` → `DROP INDEX IF EXISTS "batches_parent_id_idx";`
   - `ALTER TABLE "batches" DROP COLUMN "stock";` → `ALTER TABLE "batches" DROP COLUMN IF EXISTS "stock";`
   - …and the same edit for the remaining 7 DROP statements.

   **9c.** Move the file into a new migration directory:
   ```
   TS=$(date -u +%Y%m%d%H%M%S)
   mkdir -p "prisma/migrations/${TS}_post_unify_cleanup"
   mv /tmp/post-unify-cleanup.sql "prisma/migrations/${TS}_post_unify_cleanup/migration.sql"
   ```
   Use any timestamp lex-greater than the add_cols migration
   (`20260511120000`) so Prisma applies them in the right order. UTC
   `date +%Y%m%d%H%M%S` is the convention.

   **9d.** Commit the new migration directory. On the next push:
   - Railway auto-deploys → `prisma migrate deploy` applies it.
   - Every DROP has `IF EXISTS` → no-op against the post-drop DB.
   - `_prisma_migrations` table records it as applied.
   - Future fresh-DB setups (staging clones, PR review DBs) replay
     the full sequence correctly.

   **Alternative — `prisma migrate resolve --applied`**: skip 9b's hand-edit
   and instead mark the migration as already-applied on prod:
   ```
   railway run npx prisma migrate resolve --applied "${TS}_post_unify_cleanup"
   ```
   Pros: no `IF EXISTS` edit needed. Cons: requires Railway CLI
   shell-into-prod access at deploy time. **Default to 9a–9d** — the
   `IF EXISTS` guards are declarative and don't require interactive
   prod access. Use the alternative only if Daan is comfortable with
   Railway CLI.

## Rollback

If something goes wrong **before step 6** (drop-cols psql), the legacy
columns are still present. Roll back by reverting the deploy (revert
the schema-stripping commit + redeploy old code). Leave MAINTENANCE_MODE
on through the revert so no half-state writes land. The legacy data is
still in `stock`/`location`/`storage`/etc.; the old app reads it
unchanged.

If something goes wrong **after step 6**, restore from the snapshot
taken in step 1 — the legacy columns are gone and there's no in-place
undo. Keep MAINTENANCE_MODE on through the restore.

## Why this 4-piece shape (not one big migration)

- **Add-cols (Prisma migration #1)** is purely additive and safe to
  apply ahead of any code rollout. Sits in migration history as
  `20260511120000_unified_batch_inventory_add_cols`.
- **Data-migrate (TypeScript script)** runs between the migrations —
  family-walk + cycle-detection + catering-rewrite logic is too
  involved for a SQL CTE, and running it as a manual step lets us
  `--dry-run` against staging without committing. Prisma's
  `migrate deploy` doesn't support TS migration files anyway.
- **Drop-cols (manual psql step, NOT a Prisma file)** is irreversible
  and MUST NEVER run before data-migrate has populated the new
  columns. Committing it as a Prisma migration would let Railway
  auto-apply it out of order. The SQL is `IF EXISTS`-guarded so
  re-running it against an already-dropped DB is a no-op.
- **post_unify_cleanup (Prisma migration #2, hand-rolled via
  `migrate diff`)** reconciles Prisma's view with the now-dropped
  state. Hand-rolling it (rather than `migrate dev`) avoids the
  shadow-DB drift trap that would offer `migrate reset` (which
  wipes the database). The migration file is `IF EXISTS`-guarded so
  it's a no-op against post-drop prod, and replays the drop_cols DDL
  for fresh-DB setups (staging clones, PR review DBs).
