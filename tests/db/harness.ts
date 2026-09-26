import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Minimal replica of the Supabase roles/auth schema the migration depends on. */
const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, file), "utf8"));
  }
  return db;
}

export type DbRole = "anon" | "authenticated" | "service_role";

/** Run fn as a Supabase role with the given JWT subject, then restore superuser. */
export async function as<T>(
  db: PGlite,
  role: DbRole,
  uid: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const claims = uid ? JSON.stringify({ sub: uid, role }) : "";
  await db.query("select set_config('request.jwt.claims', $1, false)", [claims]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
}

export async function createUser(
  db: PGlite,
  role: "analyst" | "supervisor" | "admin" | null,
  name = "Test User",
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
    [`${crypto.randomUUID()}@bank.test`, JSON.stringify({ full_name: name, role: "admin" })],
  );
  const id = rows[0].id;
  if (role) await db.query("update public.profiles set role = $1 where id = $2", [role, id]);
  return id;
}

export async function seedAlert(db: PGlite): Promise<{ alertId: string; txnId: string; customerId: string }> {
  const ref = `CUST-${crypto.randomUUID().slice(0, 8)}`;
  const c = await db.query<{ id: string }>(
    `insert into public.customers (external_ref, full_name, account_masked, home_city, segment, kyc_tier)
     values ($1, 'Asha Rao', 'XXXXXXXX4821', 'Pune', 'retail', 2) returning id`,
    [ref],
  );
  const t = await db.query<{ id: string }>(
    `insert into public.transactions (customer_id, amount, channel, direction, counterparty, city, device_id, occurred_at)
     values ($1, 95000, 'UPI', 'debit', 'mule@upi', 'Delhi', 'dev-new', now()) returning id`,
    [c.rows[0].id],
  );
  await db.query("insert into public.fraud_labels (transaction_id, pattern) values ($1, 'new_device_high_value')", [
    t.rows[0].id,
  ]);
  const a = await db.query<{ id: string }>(
    `insert into public.alerts (transaction_id, customer_id, risk_score, severity, reason_codes)
     values ($1, $2, 88, 'critical', array['NEW_DEVICE','AMOUNT_SPIKE']) returning id`,
    [t.rows[0].id, c.rows[0].id],
  );
  return { alertId: a.rows[0].id, txnId: t.rows[0].id, customerId: c.rows[0].id };
}
