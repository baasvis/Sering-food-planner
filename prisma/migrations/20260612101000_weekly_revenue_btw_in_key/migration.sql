-- Hub Phase 3 follow-up: btw_rate joins weekly_revenue's unique key. A
-- catering invoice routinely splits one Type across 9% and 21% rows (food vs
-- alcohol/rental — xlsx Revenue-input §5.6 convention), which the old key
-- couldn't hold. REGULAR rows keep one rate per type, so this is a pure
-- widening. Table is Hub-recomputed, so no data backfill is needed.

DROP INDEX "weekly_revenue_org_year_week_type_regtype_key";
CREATE UNIQUE INDEX "weekly_revenue_org_year_week_type_regtype_btw_rate_key"
    ON "weekly_revenue"("org", "year", "week", "type", "regtype", "btw_rate");
