# FraudLens — AI-assisted fraud alert triage

Next.js 16 · Supabase (Postgres + RLS + Auth + Realtime) · AI Pipe / OpenAI-compatible LLM · Vitest

## Phase status
| Phase | Scope | Status |
|---|---|---|
| P0 | Scaffold, schema, RLS, alert state machine, append-only audit, auth, LLM client, security headers | ✅ |
| P1 | Deterministic synthetic data + planted fraud + look-alikes + idempotent seed | ✅ |
| P2 | Deterministic risk engine (features → versioned rules → score) → idempotent alerts, analyst queue, eval | ✅ |
| P3 | AI case summary (PII-masked, cached, template fallback) | ⏳ |
| P4 | Alert detail, decisions, Realtime feed, supervisor metrics, E2E | ⏳ |
| P5 | Hardening, README, deck | ⏳ |

## Setup
1. `npm install` and `cp .env.example .env.local`, then fill the values in.
2. Supabase → SQL Editor: run `supabase/migrations/20260926000000_init.sql`
   (or run `supabase db push` with the CLI).
3. Supabase → Authentication → Providers: **turn off "Allow new users to sign up"**.
   Even with sign-ups left on, new users get `role = NULL` and see no data.
4. Create staff users in Supabase → Authentication → Users, then assign roles:
   ```sql
   update public.profiles set role = 'analyst'    where id = (select id from auth.users where email = 'analyst@bank.test');
   update public.profiles set role = 'supervisor' where id = (select id from auth.users where email = 'lead@bank.test');
   ```
5. Load demo data. Pick one of these:
   - `DATABASE_URL=… npm run seed -- --confirm-demo`
     Runs in one transaction and rolls back fully if anything fails.
   - `npm run seed -- --sql seed.sql`, then paste the file into the SQL editor or run `psql "$DATABASE_URL" -f seed.sql`.
   Optional flags: `--seed <int>`, `--anchor now` (makes the data look fresh), `--manifest manifest.json`.
   Re-running is safe: it only replaces rows tagged `SEED-*`.
6. Run migration `20260926020000_risk_engine.sql`, then score the data. Either:
   - sign in as a supervisor and click **Run detection**, or
   - run `npm run risk -- --confirm-demo` (uses `.env.local` and prints the evaluation).
7. `npm run dev` and open http://localhost:3000

## Tests
`npm run check` runs typecheck, lint, and all tests. The RLS tests run the real migration
on PGlite (Postgres in WASM) with Supabase auth stubs, so no Supabase project is needed.

## Demo data (P1)
- The same seed always produces the same data (seeded random generator, IDs derived from the seed, fixed anchor time).
- 200 customers and 5,000 transactions over 30 days. About 2.3% are planted fraud.
- Pipeline: `scripts/seed/`
  1. Generate customers.
  2. Plant the fraud scenarios and their look-alikes (`scenarios/*`).
  3. Fill the rest with ordinary baseline activity.
  4. Build the manifest.
  5. Emit SQL.

| Pattern | Planted fraud | Innocent look-alike |
|---|---|---|
| VELOCITY_BURST | 6–9 gift-card debits within 5 min, at night | 5 small cab top-ups; a busy MSME day |
| NEW_DEVICE_HIGH_VALUE | First-ever device + ₹60k–5L to a new payee | New phone with normal spend; big payment to a known payee |
| GEO_MISMATCH | Home txn, then card use 800+ km away minutes later | Real traveller (plausible flight speed) |
| MULE_FAN_IN | 6–8 customers pay one external handle within 6h; mule gets 5–7 credits | Payroll credits; MSME sales collections |
| MULE_FAN_OUT | Mule sends money to 4–6 new accounts within ~1h | Supplier payments the next day |
| STRUCTURING | 4–6 debits of ₹45.5k–49.9k within 24h | One payment just under ₹50k; two invoices 26h apart |

Ground truth lives only in `fraud_labels` (supervisor-only), with a `scenario_ref` column.
The tests use independent "oracle" detectors to prove two things:
- every planted case matches its pattern;
- **no unlabelled transaction matches any pattern**, checked across 3 seeds.

## Risk engine (P2) — deterministic, no AI
`src/lib/risk/` is pure TypeScript: no I/O and no knowledge of the generator. It scores 5,000 transactions in about 100 ms.

1. **Features.** Each transaction only sees data up to its own timestamp:
   - customer baseline (median debit, usual city)
   - velocity (5 min)
   - device age
   - geo (fastest implied travel speed within 6h)
   - counterparty (new payee, ring size, inbound senders, payouts)
   - structuring band (24h)
2. **Rules.** Ruleset `2026.09.26-r1`. Each hit carries a stable reason code, a weight and human-readable evidence.
   - Pattern rules:
     `VELOCITY_BURST`, `NEW_DEVICE_HIGH_VALUE`, `IMPOSSIBLE_TRAVEL`, `MULE_RING`, `MULE_PASS_THROUGH`, `STRUCTURING`
   - Supporting signals:
     `NEW_DEVICE`, `NEW_PAYEE`, `AMOUNT_SPIKE`, `HIGH_VALUE`, `ODD_HOUR`, `FAR_FROM_HOME`, `NEAR_THRESHOLD`
3. **Cluster expansion.** When a windowed pattern completes (burst, ring, pass-through, structuring), the earlier members of that cluster get the same code, with `via` pointing to the transaction that completed it.
4. **Score.** Pattern weights plus signals, with signals capped at 45. An alert needs score ≥ 50, so **at least one pattern rule must fire**. Severity bands: medium 50–69, high 70–84, critical 85+.
5. **Persist.** `apply_risk_assessments(jsonb)` runs as service role only and is atomic. It upserts assessments and inserts alerts with `on conflict do nothing`, so re-runs never touch analyst work.

`npm run eval` (offline, any `--seed`):
```
Transactions evaluated: 5,000   Planted fraud: 115
TP 115 · FP 0 · TN 4,885 · FN 0 · Precision 100.0% · Recall 100.0% · Alerts 115
```
⚠️ **Read this number correctly.** The rules and the generator share the same pattern definitions, so 100% proves the engine is *correct* on known behaviours, not that it's *accurate* in the real world.
The meaningful part is that all 16 innocent look-alikes score between 0 and 35 and stay below the alert line. Real data would produce false positives, which is where the analyst workflow (P3/P4) earns its keep.

## Security model
- RLS on every table. `anon` has no table grants.
- Roles: `analyst` | `supervisor` | `admin`. A new user has no role until an admin assigns one.
- Scores, reason codes and AI summaries can't be changed by users (DB trigger). Only the server can write them, using the service role.
- Alert state machine is enforced in Postgres:
  - `open → in_review | escalated`
  - `in_review → escalated | confirmed_fraud | false_positive`
  - `escalated → closed` (supervisor only)
  - Closing requires a note of at least 10 characters. Closed alerts are frozen.
- Analysts can only act on alerts that are unassigned or assigned to themselves.
- Every alert change is written to `audit_log` by a trigger. `audit_log` is append-only for everyone, including the service role.
- JWT is verified with `getClaims()` in `src/proxy.ts`. Unauthenticated API calls get a 401 and pages redirect.
- Login rate limit: 5 attempts per 5 minutes per IP+email.
- Security headers: CSP, HSTS, `frame-ancestors 'none'`, no `X-Powered-By`.

## Known trade-offs (flagged)
1. **CSP uses `'unsafe-inline'` for scripts.** Next.js needs this for its inline bootstrap when nonces aren't used. A nonce-based CSP would force every page to render dynamically. This is acceptable for the prototype; switch to nonces for production.
2. **Login rate limiter is in-memory**, so it only works per instance. Use Redis or Upstash when running multiple instances. Supabase Auth has its own server-side limits as a backstop.
3. **AI Pipe free tier is about $0.10/week.** AI summaries are cached per alert, and the app falls back to a template summary when the LLM is unavailable (`LLM_PROVIDER=none` also works).
7. **Re-running detection with a new ruleset doesn't update existing alerts.** This is on purpose, so an alert stays tied to the rules that raised it. `risk_assessments` always reflects the latest run.
5. **The SQL file is ~1 MB.** If the Supabase SQL editor rejects it, use the `DATABASE_URL` path or `psql`.
6. **Without `DATABASE_SSL_CA`, the seed script encrypts the connection but doesn't verify the server certificate.** This only affects the demo seed.
4. **`fraud_labels` holds ground truth for the synthetic data.** Only supervisors can see it. It exists to measure detection precision in the demo.
