# FraudLens — AI-assisted fraud alert triage

Next.js 16 · Supabase (Postgres + RLS + Auth + Realtime) · AI Pipe / OpenAI-compatible LLM · Vitest

## Phase status
| Phase | Scope | Status |
|---|---|---|
| P0 | Scaffold, schema, RLS, alert state machine, append-only audit, auth, LLM client, security headers | ✅ |
| P1 | Synthetic data generator + seed (planted fraud patterns) | ⏳ |
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
5. `npm run dev` and open http://localhost:3000

## Tests
`npm run check` runs typecheck, lint, and all tests. The RLS tests run the real migration
on PGlite (Postgres in WASM) with Supabase auth stubs, so no Supabase project is needed.

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
4. **`fraud_labels` holds ground truth for the synthetic data.** Only supervisors can see it. It exists to measure detection precision in the demo.
# fraud_lens
# fraud_lens
