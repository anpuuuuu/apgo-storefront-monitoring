#!/usr/bin/env node
/* Builds the SQL for .github/workflows/d1-maintenance.yml from validated
   inputs, so the workflow never interpolates raw user text into a statement.
   Prints GITHUB_OUTPUT lines: `sql=...` and, for mutations, `verify=...`. */
import { buildMaintenanceSql } from './d1-maintenance-lib.mjs';

const { sql, verify } = buildMaintenanceSql({
  action: process.env.ACTION || '',
  signature: process.env.SIGNATURE || '',
  note: process.env.NOTE || '',
});
process.stdout.write(`sql=${sql}\n`);
if (verify) process.stdout.write(`verify=${verify}\n`);
