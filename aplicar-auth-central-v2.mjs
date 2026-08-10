// OZONTECK - Security Phase 1 / Auth Central v2
// Executar na raiz do repositório OZONTECK:
// node aplicar-auth-central-v2.mjs
//
// Segurança:
// - não altera /api/auth/login;
// - não remove tokens ainda;
// - valida todos os arquivos antes de escrever;
// - rollback automático se qualquer validação falhar;
// - exige ausência de mudanças TRACKED antes de iniciar;
// - node --check + git diff --check ao final.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const EXPECTED_FILES = [
  "src/middlewares/auth.middleware.js",
  "src/routes/products.routes.js",
  "src/routes/categories.routes.js",
  "src/routes/banners.routes.js",
  "src/routes/orders.routes.js",
  "src/routes/customers.routes.js",
  "src/routes/settings.routes.js",
];

const ROUTES = [
  { path: "src/routes/products.routes.js", marker: "function sanitizeFileName" },
  { path: "src/routes/categories.routes.js", marker: "// Rotas administrativas" },
  { path: "src/routes/banners.routes.js", marker: "// Rotas públicas" },
  { path: "src/routes/orders.routes.js", marker: "function formatCurrency" },
  { path: "src/routes/customers.routes.js", marker: "async function callRpc" },
  { path: "src/routes/settings.routes.js", marker: "async function callRpc" },
];

function run(command, args = [], options = {}) {
  return execFileSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function countMatches(text, regex) {
  const flags = regex.flags.includes("g") ? regex.flags : regex.flags + "g";
  return [...text.matchAll(new RegExp(regex.source, flags))].length;
}

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function replaceExactlyOnce(text, regex, replacement, label, file) {
  const count = countMatches(text, regex);
  assert(
    count === 1,
    `${label}: esperado exatamente 1 trecho em ${file}; encontrado ${count}.`
  );
  return text.replace(regex, replacement);
}

function ensureRepoRoot() {
  const inside = run("git", ["rev-parse", "--is-inside-work-tree"]).trim();
  assert(inside === "true", "Execute este script dentro do repositório Git da API.");

  const top = run("git", ["rev-parse", "--show-toplevel"]).trim();
  const cwd = path.resolve(process.cwd());
  assert(
    path.resolve(top) === cwd,
    `Execute na raiz do repositório. Raiz detectada: ${top}`
  );
}

function ensureTrackedTreeClean() {
  // Ignora arquivos não rastreados (como este script), mas não aceita mudanças
  // em arquivos já versionados nem no stage.
  try {
    execFileSync("git", ["diff", "--quiet"], { cwd: process.cwd() });
  } catch {
    throw new Error(
      "Existem alterações TRACKED não commitadas. Faça commit/stash antes de executar."
    );
  }

  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: process.cwd() });
  } catch {
    throw new Error(
      "Existem alterações no stage. Faça commit/stash antes de executar."
    );
  }
}

function ensureExpectedFiles() {
  for (const file of EXPECTED_FILES) {
    assert(fs.existsSync(file), `Arquivo obrigatório não encontrado: ${file}`);

    try {
      run("git", ["ls-files", "--error-unmatch", file]);
    } catch {
      throw new Error(`Arquivo não está versionado no Git: ${file}`);
    }
  }
}

function patchMiddleware(text, file) {
  const eol = detectEol(text);

  assert(
    !text.includes("Compatibilidade temporária para rotas administrativas legadas."),
    `${file} já parece conter a ponte de compatibilidade desta fase.`
  );

  const pattern =
    /(    req\.admin = \{[\s\S]*?      is_master: currentAdmin\.is_master,\r?\n    \};)(?:\r?\n){2,}\s*return next\(\);/;

  const bridge = [
    "$1",
    "",
    "    // Compatibilidade temporária para rotas administrativas legadas.",
    "    // Não reintroduz credenciais Supabase: apenas preserva req.auth.admin.",
    "    req.auth = {",
    "      admin: currentAdmin,",
    "    };",
    "",
    "    return next();",
  ].join(eol);

  return replaceExactlyOnce(
    text,
    pattern,
    bridge,
    "ponte req.auth",
    file
  );
}

function patchRoute(text, file, marker) {
  const eol = detectEol(text);

  assert(
    !text.includes('requireAdminAuth as requireAuth'),
    `${file} já parece ter sido migrado para requireAdminAuth.`
  );

  text = replaceExactlyOnce(
    text,
    /^import jwt from "jsonwebtoken";\r?\n/m,
    "",
    "remover import jsonwebtoken",
    file
  );

  text = replaceExactlyOnce(
    text,
    /^(import express from "express";\r?\n)/m,
    `$1import { requireAdminAuth as requireAuth } from "../middlewares/auth.middleware.js";${eol}`,
    "importar requireAdminAuth",
    file
  );

  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const authBlock = new RegExp(
    `async function getUserFromToken\\(token\\) \\{[\\s\\S]*?(?=${escapedMarker})`
  );

  const authMatch = text.match(authBlock);
  assert(authMatch, `bloco de autenticação legado não encontrado em ${file}`);

  const block = authMatch[0];
  assert(
    block.includes("async function findAdminByEmail"),
    `findAdminByEmail não encontrado dentro do bloco esperado em ${file}`
  );
  assert(
    block.includes("async function requireAuth"),
    `requireAuth local não encontrado dentro do bloco esperado em ${file}`
  );
  assert(
    block.includes("decoded.supabase_access_token"),
    `dependência legada de supabase_access_token não encontrada em ${file}; código pode ter divergido`
  );

  text = replaceExactlyOnce(
    text,
    authBlock,
    "",
    "remover autenticação administrativa duplicada",
    file
  );

  return text;
}

function validatePatchedContents(patched) {
  const middleware = patched.get("src/middlewares/auth.middleware.js");
  assert(
    middleware.includes("req.auth = {") &&
      middleware.includes("admin: currentAdmin"),
    "Ponte req.auth.admin não foi criada corretamente."
  );

  for (const route of ROUTES) {
    const text = patched.get(route.path);
    assert(
      text.includes('requireAdminAuth as requireAuth'),
      `Middleware central não encontrado em ${route.path}`
    );
    assert(
      !/\bjwt\.verify\s*\(/.test(text),
      `Ainda existe jwt.verify em ${route.path}`
    );
    assert(
      !text.includes("supabase_access_token"),
      `Ainda existe dependência de supabase_access_token em ${route.path}`
    );
    assert(
      !text.includes("async function getUserFromToken"),
      `Ainda existe getUserFromToken em ${route.path}`
    );
    assert(
      !text.includes("async function findAdminByEmail"),
      `Ainda existe findAdminByEmail local em ${route.path}`
    );
  }
}

function validateGitDiff() {
  const changed = run("git", ["diff", "--name-only"])
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .sort();

  const expected = [...EXPECTED_FILES].sort();

  assert(
    JSON.stringify(changed) === JSON.stringify(expected),
    `Arquivos alterados divergiram do esperado.\nEsperado:\n${expected.join(
      "\n"
    )}\nEncontrado:\n${changed.join("\n")}`
  );

  run("git", ["diff", "--check"]);
}

function syntaxCheck() {
  for (const file of EXPECTED_FILES) {
    run("node", ["--check", file]);
  }
}

const originals = new Map();
let wroteFiles = false;

try {
  console.log("1/7 Validando repositório...");
  ensureRepoRoot();
  ensureTrackedTreeClean();
  ensureExpectedFiles();

  console.log("2/7 Lendo arquivos atuais...");
  for (const file of EXPECTED_FILES) {
    originals.set(file, fs.readFileSync(file));
  }

  const patched = new Map();

  console.log("3/7 Validando e preparando alterações em memória...");
  for (const file of EXPECTED_FILES) {
    const originalText = originals.get(file).toString("utf8");

    if (file === "src/middlewares/auth.middleware.js") {
      patched.set(file, patchMiddleware(originalText, file));
      continue;
    }

    const config = ROUTES.find((item) => item.path === file);
    assert(config, `Configuração de rota ausente para ${file}`);
    patched.set(file, patchRoute(originalText, file, config.marker));
  }

  validatePatchedContents(patched);

  console.log("4/7 Todas as validações prévias passaram. Gravando...");
  for (const file of EXPECTED_FILES) {
    fs.writeFileSync(file, patched.get(file), "utf8");
  }
  wroteFiles = true;

  console.log("5/7 Executando node --check...");
  syntaxCheck();

  console.log("6/7 Validando diff do Git...");
  validateGitDiff();

  console.log("7/7 Validação final...");
  const finalPatched = new Map(
    EXPECTED_FILES.map((file) => [file, fs.readFileSync(file, "utf8")])
  );
  validatePatchedContents(finalPatched);

  console.log("");
  console.log("FASE 1 PREPARADA COM SUCESSO.");
  console.log("Contrato de /api/auth/login: NÃO ALTERADO.");
  console.log("Supabase access/refresh tokens: AINDA NÃO REMOVIDOS.");
  console.log("");
  console.log("Arquivos alterados:");
  console.log(run("git", ["diff", "--name-only"]).trim());
  console.log("");
  console.log("Resumo:");
  console.log(run("git", ["diff", "--stat"]).trim());
  console.log("");
  console.log("Agora execute SOMENTE: git diff");
  console.log("Não faça commit/push antes de revisar o diff.");
} catch (error) {
  console.error("");
  console.error("ERRO:", error?.message || error);

  if (wroteFiles) {
    console.error("Restaurando automaticamente os arquivos originais...");
    for (const [file, buffer] of originals.entries()) {
      fs.writeFileSync(file, buffer);
    }

    try {
      const remaining = run("git", ["diff", "--name-only"]).trim();
      if (remaining) {
        console.error(
          "ATENÇÃO: ainda há diff tracked após rollback:\n" + remaining
        );
      } else {
        console.error("Rollback concluído: nenhum diff tracked restante.");
      }
    } catch {
      console.error("Não foi possível confirmar git diff após rollback.");
    }
  } else {
    console.error("Nenhum arquivo do projeto foi gravado.");
  }

  process.exitCode = 1;
}
