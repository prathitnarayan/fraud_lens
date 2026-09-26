# FraudLens — AI-assisted fraud alert triage

Next.js 16 · Supabase (Postgres + RLS + Auth + Realtime) · AI Pipe / OpenAI-compatible LLM · Vitest

## Phase status
| Phase | Scope | Status |
|---|---|---|
| P0 | Scaffold, schema, RLS, alert state machine, append-only audit, auth, LLM client, security headers | ✅ |
| P1 | Deterministic synthetic data + planted fraud + look-alikes + idempotent seed | ✅ |
| P2 | Risk engine (rules + customer baseline) → alerts, analyst queue | ⏳ |
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
6. `npm run dev` and open http://localhost:3000

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
5. **The SQL file is ~1 MB.** If the Supabase SQL editor rejects it, use the `DATABASE_URL` path or `psql`.
6. **Without `DATABASE_SSL_CA`, the seed script encrypts the connection but doesn't verify the server certificate.** This only affects the demo seed.
4. **`fraud_labels` holds ground truth for the synthetic data.** Only supervisors can see it. It exists to measure detection precision in the demo.
