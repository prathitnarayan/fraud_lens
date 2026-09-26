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

## Detector models (P6) — advisory ensemble beside the rules
The fraudster changes the story; the money trail reveals the pattern. Three explainable models run in the same point-in-time pass as the rules (all four together take about 220 ms for 5,000 transactions):

| Model | Question it answers | Signals | Catches |
|---|---|---|---|
| **Behaviour** | How unusual is this for *this customer*? | amount (robust z-score), device, city, first payee, hour, channel, velocity | account takeover, SIM swap |
| **Beneficiary** | How suspicious is *where the money goes*? | distinct senders 24h/ever, volume received, bank-wide novelty | authorised scams (digital arrest, investment, fake KYC) |
| **Network** | Is this account moving money like a mule? | pass-through ratio, sender diversity, new recipients, time to outflow | mule accounts, one-victim → many-accounts scams |

- **Scoring and explanations.** Each model combines its factors with a noisy-OR, so every point of the 0–100 score comes from a named factor. The factor text is safe to send to the LLM.
- **Agreement.** The rules plus the three models give HIGH (2 or more flag), MIXED (1) or LOW (0).
- **Model-only candidates.** These are cases the rules scored below the alert line but a model flagged. They're listed on `/metrics`.
- **Advisory by design.** The models never change `risk_score` or create alerts. Tests show the rules output is identical with and without them, and the alert count matches the rules exactly. Promoting a model from shadow to active is a roadmap step.
- **Proof the models add something.** In a test built from the research ("one victim pays 10 new accounts", as in matrimonial or gift scams), the rules raise nothing and the network model flags it.
- **Swap-ready.** v1 is statistical. The same slot takes Isolation Forest, XGBoost or a GNN later without changing the pipeline, storage or UI.

`npm run eval` (seed 20260926):
- behaviour: 51 flagged, 57% planted fraud (noisiest, which is why it's advisory);
- beneficiary: 10/10;
- network: 11/11;
- agreement on alerts: 40 HIGH, 75 MIXED;
- 22 model-only candidates.

## Pre-transaction check (P7) — before money moves
The same point-in-time engine scores a **proposed** payment against 30 days of the customer's history and the beneficiary's history. It returns in milliseconds.

```
POST /api/v1/precheck        Authorization: Bearer $PRECHECK_API_KEY   (or a staff session)
{ "customerRef": "SEED-00143", "amount": 200000, "channel": "IMPS",
  "counterparty": "new.person@ibl", "merchantCategory": null, "city": "Hyderabad", "deviceId": "dev-unknown" }
→ { "decision": "HOLD", "ruleScore": 100, "reasonCodes": [...], "models": {...},
    "policyReasons": [...], "customerMessage": "This is a large payment from a new device…", "latencyMs": 4.1 }
```

| Decision | When | What the customer experiences |
|---|---|---|
| **HOLD** | rules ≥ 70, or rules ≥ 50 with HIGH agreement | Payment paused, fraud team calls |
| **STEP_UP** | rules ≥ 50, or any model ≥ 60 | Re-authenticate, call-back or cooling-off |
| **WARN** | beneficiary model ≥ 40, or unusual amount | Scam warning, can continue |
| **ALLOW** | nothing fires | Normal |

- **Only the rules can HOLD. Models only add friction**, so they stay advisory. A test proves this, and a mutation test confirmed it catches the change.
- A test confirms precheck and the batch engine give **the same score** for the same payment (one engine, two modes).
- The check is **stateless**: it stores no transaction. Every decision is audited (`precheck.decision`, visible to supervisors).
- API-key auth uses a constant-time compare, and key auth is disabled if `PRECHECK_API_KEY` is unset or shorter than 24 characters. Rate-limited, and a static test checks that every API route authenticates before doing any work.
- **Simulator:** `/precheck` has presets built from live data: a normal grocery payment, a SIM swap sending ₹2L from a new phone, and paying the account that many customers paid today.

## Payment-rail limits (P9) — checked before fraud scoring
`src/lib/limits.ts` records who sets each limit (checked 26 Sep 2026):

| Limit | Value | Set by |
|---|---|---|
| UPI P2P per transaction | ₹1,00,000 | NPCI |
| UPI P2P rolling 24h | ₹1,00,000 | NPCI |
| UPI in the first 24h of a new registration (a new device is treated the same) | ₹5,000 | NPCI (device re-registration: bank-policy interpretation) |
| UPI P2M, verified merchants (capital markets, insurance, travel, loans, card bills ₹5L; jewellery ₹2L) | per category | NPCI (effective 15 Sep 2025) |
| UPI transactions per 24h | 20 | Bank (configurable) |
| IMPS per transaction | ₹5,00,000 | Bank (configurable) |
| ATM withdrawal per day | ₹50,000 | Bank (configurable) |

Any breach returns **DECLINE**, with the exact limit and its source, before the fraud policy runs. Fraud scores are still returned for the audit trail.

Example: a victim sending 9 × ₹18,000 by UPI to new accounts is declined by the NPCI rolling cap. The same pattern over IMPS stays within limits, and the network model steps it up instead. Both cases are tested.

RBI's **e-mandate framework** (April 2026: recurring debits without OTP up to ₹15,000, or ₹1L for insurance, mutual funds and card bills; 24-hour pre-debit notice) is noted for the roadmap. Recurring mandates aren't in the demo data.

## RBI regulatory mapping (P8)
Checked on 26 Sep 2026. The rules are encoded as data in `src/lib/compliance.ts`, so they can be updated when drafts become final.

| RBI instrument | Status | FraudLens implementation |
|---|---|---|
| Authentication Mechanisms for Digital Payment Transactions Directions, 2025 (2FA with a dynamic factor; risk-based checks on suspicious transactions) | **In force 1 Apr 2026** | Pre-transaction **STEP_UP** is the risk-based additional authentication |
| Master Directions on Fraud Risk Management (Jul 2024): Early Warning Signals, red-flagging | **In force** | Alerts are the EWS layer. Confirming fraud red-flags the case, and the audit trail supports reporting |
| Draft SOP on suspected money-mule accounts | **Draft** (comments due 2 Oct 2026, proposed 1 Apr 2027) | See below |
| Draft compensation framework for digital banking fraud | **Draft** (Mar 2026, proposed 1 Jul 2026) | See below |

**Money-mule SOP clock** (Regulatory card on mule alerts):
- immediate debit hold for amounts ≥ ₹1,000;
- customer explanation due in 20 days;
- bank decides within 10 days of the reply, or 30 days if there's no reply;
- the hold must end within 60 days;
- ring alerts point the analyst to report the *external* beneficiary.

**Compensation estimate** (Regulatory card on victim alerts): losses up to ₹50k get min(85%, ₹25,000), once per lifetime, if reported within 5 days. The card shows the reporting deadline.

## Roadmap (not built)
- **P5 Rule intelligence:** threshold backtesting, shadow-mode rules, versioned rollouts.
- **P6+ Trained models:** analyst decisions become labels, then XGBoost/LightGBM, then champion/challenger against today's detectors. Also sequence models ("fraud journey") and graph ML.
- **Fraud intelligence graph:** customer ↔ device ↔ beneficiary ↔ account ↔ case.
- **External intelligence:** DoT Financial Fraud Risk Indicator, I4C Suspect Registry, consortium signals.
- **Pre-transaction v2:** device and login events (SIM change, MFA reset), an FRI or mobile-number risk lookup, and a streaming feature store for sub-10 ms at scale.
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
14. **Draft RBI rules are labelled DRAFT in the UI.** They're shown as decision support, not legal advice. Re-check the figures when RBI publishes the final versions.
12. **Run migration `…050000_detector_models.sql` and click Run detection once** to populate the model scores. The queue shows "—" until you do.
13. **The behaviour model is noisy on purpose** (57% precision on demo data). That's why models are advisory and the analyst decides.
7. **Re-running detection with a new ruleset doesn't update existing alerts.** This is on purpose, so an alert stays tied to the rules that raised it. `risk_assessments` always reflects the latest run.
8. **No streaming.** The summary returns as one JSON object, typically 2–4s on nano, with a skeleton loader while waiting. Streaming the narrative would need an unvalidated text stream, which conflicts with schema validation, so it was skipped on purpose.
9. **Grounding only checks the cited reason codes.** A model could still phrase a number wrongly inside the narrative. The rules-engine evidence is always shown next to the summary so the analyst can cross-check.
10. **Analysts can now read the audit log, but only alert history** (P4). This is needed for Decision Replay. Other audit rows, such as detection runs, stay supervisor-only.
11. **Alerts created before P4 have no cluster members in their evidence**, so their replay timeline shows only the alerted transaction and recent history. Re-seed and re-run detection to get the full clusters.
5. **The SQL file is ~1 MB.** If the Supabase SQL editor rejects it, use the `DATABASE_URL` path or `psql`.
6. **Without `DATABASE_SSL_CA`, the seed script encrypts the connection but doesn't verify the server certificate.** This only affects the demo seed.
4. **`fraud_labels` holds ground truth for the synthetic data.** Only supervisors can see it. It exists to measure detection precision in the demo.
