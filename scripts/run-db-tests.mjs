#!/usr/bin/env node
/**
 * Runs the pgTAP database tests in supabase/tests/*.sql against a database
 * given by the DATABASE_URL environment variable. No Docker needed.
 *
 *   PowerShell:  $env:DATABASE_URL = "postgresql://..."; npm run test:db
 *
 * Each test file runs inside its own transaction and ends with ROLLBACK, so
 * it leaves no data behind. Even so, only run this against STAGING.
 * As a safeguard, it refuses to run against the production project ref
 * listed in supabase/config.toml.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to the STAGING database connection string first.");
  process.exit(2);
}

const config = readFileSync("supabase/config.toml", "utf8");
const productionRef = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
if (productionRef && url.includes(productionRef)) {
  console.error(`Refusing to run: DATABASE_URL points at ${productionRef}, the production project in supabase/config.toml.`);
  process.exit(2);
}

const dir = "supabase/tests";
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

let failedFiles = 0;
for (const file of files) {
  const sql = readFileSync(join(dir, file), "utf8");
  console.log(`\n=== ${file}`);
  let tap = [];
  try {
    const results = await client.query(sql);
    for (const result of Array.isArray(results) ? results : [results]) {
      for (const row of result.rows ?? []) {
        for (const value of Object.values(row)) {
          if (typeof value === "string") tap.push(...value.split("\n"));
        }
      }
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.log(`ERROR (the file stopped here; nothing was saved): ${error.message}`);
    if (error.where) console.log(`  at: ${error.where}`);
    failedFiles++;
    continue;
  }

  tap = tap.filter((line) => line.trim() !== "");
  for (const line of tap) console.log(line);
  const planned = Number(/^1\.\.(\d+)/m.exec(tap.join("\n"))?.[1] ?? NaN);
  const passed = tap.filter((l) => /^ok \d+/.test(l)).length;
  const failed = tap.filter((l) => /^not ok \d+/.test(l)).length;
  const fileOk = failed === 0 && passed === planned;
  if (!fileOk) failedFiles++;
  console.log(`--> ${fileOk ? "PASS" : "FAIL"}: ${passed}/${Number.isNaN(planned) ? "?" : planned} passed${failed ? `, ${failed} failed` : ""}`);
}

await client.end();
console.log(failedFiles === 0 ? "\nALL DATABASE TESTS PASSED" : `\n${failedFiles} TEST FILE(S) FAILED`);
process.exit(failedFiles === 0 ? 0 : 1);
