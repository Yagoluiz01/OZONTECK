import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(
  new URL("../sql/20260815-lead-events-visitor-index.sql", import.meta.url),
  "utf8"
);

test("índice usa visitante antes da data", () => {
  assert.match(
    sql,
    /create index if not exists idx_lead_events_visitor_created_at\s+on public\.lead_events \(visitor_id, created_at\)/i
  );
});

test("migration é repetível e não modifica dados", () => {
  assert.equal((sql.match(/create index if not exists/gi) || []).length, 1);
  assert.doesNotMatch(sql, /\b(drop|truncate|delete|update|insert)\b/i);
  assert.match(sql, /analyze public\.lead_events/i);
});
