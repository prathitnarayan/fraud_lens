# FraudLens — Don't just detect fraud. Reconstruct it.

An evidence-first FraudOps workspace for Indian digital banking. It covers the whole path from a UPI/IMPS/card anomaly to a mule-network investigation, with deterministic detection, advisory AI and an auditable human decision.

Next.js 16 · Supabase (Postgres + RLS + Auth + Realtime) · AI Pipe / OpenAI-compatible LLM · Vitest

## Phase status
| Phase | Scope | Status |
|---|---|---|
| P0 | Scaffold, schema, RLS, alert state machine, append-only audit, auth, LLM client, security headers | ✅ |
| P1 | Deterministic synthetic data + planted fraud + look-alikes + idempotent seed | ✅ |
| P2 | Deterministic risk engine (features → versioned rules → score) → idempotent alerts, analyst queue, eval | ✅ |
| P3 | AI case summary: PII minimizer → AI Pipe → zod + grounding → deterministic fallback; alert detail page | ✅ |
| P4 | Investigation workspace: decisions, Decision Replay, money network, live feed, rule performance, E2E | ✅ |
| P5 | Hardening: score-tie priority, loading/error states, automated security invariants, CI | ✅ |

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
6. Run migrations `…020000_risk_engine.sql`, `…030000_investigation.sql` and `…040000_alert_priority.sql`, then score the data. Either:
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

## AI case summary (P3) — advisory only
```
P2 alert (score, severity, reason codes, evidence) + customer baseline + recent activity
  → PII minimizer   (names, refs, account, UPI handles, device ids, UUIDs removed; people/devices → person#N / device#N)
  → context builder (JSON: amounts, cities, IST times, categories, evidence text scrubbed)
  → AI Pipe          (openai/gpt-4.1-nano, JSON mode, 12s timeout, 1 retry)
  → zod schema       (unknown keys stripped: a model returning risk_score is ignored)
  → grounding check  (cited reason codes must be ones the engine produced)
  → valid ? AI summary : deterministic playbook summary (per-pattern action, questions, benign explanations)
  → analyst
```

**Enforced boundaries**
- The AI can only write `ai_summary`, `ai_model` and `ai_generated_at`. This is enforced three ways:
  - `buildAiUpdate` builds the update from those columns only;
  - a unit test checks the keys;
  - a DB test shows that score, severity, reason codes, evidence, status and notes are unchanged after an AI write.
- The suggested action comes from a fixed list of workflow steps. None of them is a verdict.
- A summary is cached per alert once the LLM succeeds. **Regenerate** is rate-limited to 6 per minute per user. Every generation is audited, with metadata only (no summary text in the audit log).
- Access is checked by reading the alert through RLS as the user. The service role is used only to write the `ai_*` columns.
- The detail page shows analysts a private legend (`person#1 = real handle`). It is never sent to the model.
- Live test: `LLM_API_KEY=… npm run test:live`

## Investigation workspace (P4)
- **Decisions.** Available actions: claim, escalate, confirm fraud, false positive.
  - Every action except claim needs a note of at least 10 characters.
  - The server action runs as the signed-in user. The Postgres state machine is the source of truth, and its errors are mapped to plain messages.
  - There's no service-role client in the decision path.
- **Decision Replay** has four steps:
  1. What happened: a timeline with cluster membership, which transaction completed which pattern, and new devices/cities.
  2. Which rules fired.
  3. The score arithmetic, re-derived from stored evidence (a warning shows if it doesn't reproduce the stored score).
  4. What people did: the audit trail with actors and notes.
- **Money network.** An SVG graph of either many customers paying one account (fan-in) or senders → mule → recipients (pass-through), within ±24h.
- **Live queue.** Uses Supabase Realtime (RLS-filtered). Refreshes are debounced, so a detection run triggers one refresh.
- **Rule performance** (`/metrics`, supervisors only): per-reason-code triggered, confirmed, false positive and precision, taken from analyst decisions. This feeds the learning loop.
- **E2E:** `npm run test:e2e`. It needs the `E2E_*` users in `.env.local` and a first-time `npx playwright install chromium`.

## Hardening (P5)
- **Score ties.** `alerts.priority` is a generated column holding the uncapped evidence total. The queue sorts by score, then priority, then time. A test checks that the SQL and TypeScript maths match for every alert.
- **Loading and error states.** Skeleton loaders and an error boundary that shows only a reference id (Next 16 `retry` API), plus a not-found page that doesn't reveal whether an alert exists.
- **Security invariants as tests.** These also catch mistakes in future migrations or files:
  - every public table has RLS;
  - `anon` has no table privileges;
  - `authenticated` can never delete or truncate, and can't insert into scoring tables;
  - every SECURITY DEFINER function pins its `search_path`;
  - the write-path RPC is callable by the service role only;
  - client components never import secret modules;
  - privileged modules are marked `server-only`;
  - every server action checks auth first (verified by breaking one on purpose);
  - only 3 non-secret `NEXT_PUBLIC_` variables exist;
  - no hard-coded keys.
- **CI** (`.github/workflows/ci.yml`): typecheck, lint with zero warnings, 174 tests, eval, build, `npm audit`.

## Roadmap (not built)
- **P5 Rule intelligence:** threshold backtesting, shadow-mode rules, versioned rollouts.
- **P6 Adaptive:** statistical anomaly and graph features, then ML scoring alongside the rules.
- **P7 Scale:** event streaming, feature store, model serving.

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
8. **No streaming.** The summary returns as one JSON object, typically 2–4s on nano, with a skeleton loader while waiting. Streaming the narrative would need an unvalidated text stream, which conflicts with schema validation, so it was skipped on purpose.
9. **Grounding only checks the cited reason codes.** A model could still phrase a number wrongly inside the narrative. The rules-engine evidence is always shown next to the summary so the analyst can cross-check.
10. **Analysts can now read the audit log, but only alert history** (P4). This is needed for Decision Replay. Other audit rows, such as detection runs, stay supervisor-only.
11. **Alerts created before P4 have no cluster members in their evidence**, so their replay timeline shows only the alerted transaction and recent history. Re-seed and re-run detection to get the full clusters.
5. **The SQL file is ~1 MB.** If the Supabase SQL editor rejects it, use the `DATABASE_URL` path or `psql`.
6. **Without `DATABASE_SSL_CA`, the seed script encrypts the connection but doesn't verify the server certificate.** This only affects the demo seed.
4. **`fraud_labels` holds ground truth for the synthetic data.** Only supervisors can see it. It exists to measure detection precision in the demo.
