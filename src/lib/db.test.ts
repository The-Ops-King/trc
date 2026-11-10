import { test } from "node:test";
import assert from "node:assert/strict";

import { transactionPoolerUrl } from "./db-url.ts";

test("session pooler port 5432 becomes the transaction pooler 6543", () => {
  assert.equal(transactionPoolerUrl("postgres://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"),
    "postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require");
});
test("transaction pooler and direct hosts are left alone", () => {
  assert.equal(transactionPoolerUrl("postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres"), "postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
  assert.equal(transactionPoolerUrl("postgres://u:p@db.abc.supabase.co:5432/postgres"), "postgres://u:p@db.abc.supabase.co:5432/postgres");
});
