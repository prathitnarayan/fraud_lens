/**
 * Demo seed CLI.
 *   npm run seed -- --confirm-demo                 # writes to DATABASE_URL in one transaction
 *   npm run seed -- --sql seed.sql                 # writes a SQL file for the Supabase SQL editor
 *   options: --seed <int> --anchor <ISO|now> --manifest manifest.json
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pg from "pg";
import { DEFAULT_ANCHOR, DEFAULT_SEED, generateDataset } from "./generator";
import { buildManifest, formatManifest } from "./manifest";
import { datasetToSql } from "./sql";

export function parseAnchor(v: string | undefined): number {
  if (!v) return DEFAULT_ANCHOR;
  if (v === "now") return Date.now();
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`invalid --anchor: ${v}`);
  return ms;
}

async function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: "string" },
      anchor: { type: "string" },
      sql: { type: "string" },
      manifest: { type: "string" },
      "confirm-demo": { type: "boolean", default: false },
    },
  });
  const seed = values.seed ? Number.parseInt(values.seed, 10) : DEFAULT_SEED;
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("--seed must be a non-negative integer");

  const dataset = generateDataset({ seed, anchor: parseAnchor(values.anchor) });
  const manifest = buildManifest(dataset);
  console.log(formatManifest(manifest));
  if (values.manifest) writeFileSync(values.manifest, JSON.stringify(manifest, null, 2));

  const body = datasetToSql(dataset);
  if (values.sql) {
    writeFileSync(values.sql, `begin;\n\n${body}\ncommit;\n`);
    console.log(`\nwrote ${values.sql} — paste into Supabase SQL editor.`);
    return;
  }

  if (!values["confirm-demo"]) {
    throw new Error("Refusing to write to a database without --confirm-demo (demo data only; never run against production).");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set (Supabase → Connect → Session pooler URI).");

  const ca = process.env.DATABASE_SSL_CA;
  const client = new pg.Client({
    connectionString: url.replace(/[?&]sslmode=[^&]*/g, ""),
    ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
  });
  if (!ca) console.warn("warning: DATABASE_SSL_CA not set — TLS is encrypted but the server cert is not verified.");

  await client.connect();
  try {
    await client.query("begin");
    await client.query(body);
    await client.query("commit");
    console.log("\nseeded ✓ (single transaction)");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("seed.ts")) {
  main().catch((e: unknown) => {
    console.error(`seed failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
