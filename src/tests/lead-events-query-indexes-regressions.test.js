import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(
  new URL("../sql/20260815-lead-events-query-indexes.sql", import.meta.url),
  "utf8"
);

test("migration cria índice para ordenar eventos recentes", () => {
  assert.match(
    sql,
    /create index if not exists idx_lead_events_created_at_desc\s+on public\.lead_events \(created_at desc\)/i
  );
});

test("migration cria índice composto com igualdade antes da data", () => {
  assert.match(
    sql,
    /create index if not exists idx_lead_events_event_type_created_at_desc\s+on public\.lead_events \(event_type, created_at desc\)/i
  );
});

test("migration é repetível e não altera nem remove dados", () => {
  assert.equal((sql.match(/create index if not exists/gi) || []).length, 2);
  assert.doesNotMatch(sql, /\b(drop|truncate|delete|update)\b/i);
  assert.match(sql, /analyze public\.lead_events/i);
});
