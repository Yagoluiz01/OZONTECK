import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  sanitizeHttpsUrlFields,
  sanitizeOptionalHttpsUrl,
} from "../utils/affiliateMarketingUrl.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const routeSource = readFileSync(
  join(testDirectory, "..", "routes", "adminAffiliateMarketing.routes.js"),
  "utf8"
);

test("aceita somente URLs HTTPS absolutas sem credenciais", () => {
  assert.equal(
    sanitizeOptionalHttpsUrl("https://cdn.example.com/material.pdf", "file_url"),
    "https://cdn.example.com/material.pdf"
  );

  for (const unsafeUrl of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://example.com/id",
    "http://example.com/material.pdf",
    "//example.com/material.pdf",
    "/storage/material.pdf",
    "https://usuario:senha@example.com/material.pdf",
  ]) {
    assert.throws(
      () => sanitizeOptionalHttpsUrl(unsafeUrl, "file_url"),
      (error) => error?.statusCode === 400 && error?.code === "INVALID_AFFILIATE_MARKETING_URL"
    );
  }
});

test("campos vazios são normalizados sem impedir remoção da mídia", () => {
  assert.equal(sanitizeOptionalHttpsUrl(undefined), undefined);
  assert.equal(sanitizeOptionalHttpsUrl(null), null);
  assert.equal(sanitizeOptionalHttpsUrl("  "), null);
});

test("sanitização cobre todos os campos mutáveis do kit", () => {
  const payload = {
    file_url: "https://cdn.example.com/file.pdf",
    thumbnail_url: "",
  };

  assert.deepEqual(
    sanitizeHttpsUrlFields(payload, ["file_url", "thumbnail_url"]),
    {
      file_url: "https://cdn.example.com/file.pdf",
      thumbnail_url: null,
    }
  );
});

test("rotas de criação e alteração aplicam a validação a todos os campos de URL", () => {
  for (const field of [
    "file_url",
    "thumbnail_url",
    "media_url",
    "media_thumbnail_url",
    "video_url",
  ]) {
    assert.match(routeSource, new RegExp(`sanitizeOptionalHttpsUrl\\(${field},`));
  }

  assert.match(routeSource, /sanitizeHttpsUrlFields\(payload, \['file_url', 'thumbnail_url'\]\)/);
  assert.match(routeSource, /sanitizeHttpsUrlFields\(payload, \['media_url', 'media_thumbnail_url'\]\)/);
  assert.match(routeSource, /sanitizeHttpsUrlFields\(payload, \['video_url', 'thumbnail_url'\]\)/);
});
