import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(
  new URL("../sql/20260815-lead-events-session-index.sql", import.meta.url),
  "utf8"
);

test("índice usa sessão e tipo antes da data", () => {
  assert.match(
    sql,
    /create index if not exists idx_lead_events_session_event_created_at_desc\s+on public\.lead_events \(session_id, event_type, created_at desc\)/i
  );
});

test("migration é repetível e não modifica dados", () => {
  assert.equal((sql.match(/create index if not exists/gi) || []).length, 1);
  assert.doesNotMatch(sql, /\b(drop|truncate|delete|update|insert)\b/i);
  assert.match(sql, /analyze public\.lead_events/i);
});
