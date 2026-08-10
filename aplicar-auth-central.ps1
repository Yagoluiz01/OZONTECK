# OZONTECK - Security Phase 1: centralizar autenticação administrativa
# Executar na raiz do repositório OZONTECK.
# O script ABORTA se qualquer trecho esperado não for encontrado exatamente uma vez.

$ErrorActionPreference = "Stop"

function Replace-ExactOnce {
    param(
        [string]$Path,
        [string]$Old,
        [string]$New,
        [string]$Label
    )

    $content = [System.IO.File]::ReadAllText($Path)
    $count = ([regex]::Matches($content, [regex]::Escape($Old))).Count

    if ($count -ne 1) {
        throw "$Label: esperado exatamente 1 trecho em $Path; encontrado $count. Nenhum arquivo adicional deve ser alterado."
    }

    $updated = $content.Replace($Old, $New)
    [System.IO.File]::WriteAllText($Path, $updated, [System.Text.UTF8Encoding]::new($false))
}

function Replace-RegexOnce {
    param(
        [string]$Path,
        [string]$Pattern,
        [string]$Replacement,
        [string]$Label
    )

    $content = [System.IO.File]::ReadAllText($Path)
    $matches = [regex]::Matches(
        $content,
        $Pattern,
        [System.Text.RegularExpressions.RegexOptions]::Singleline
    )

    if ($matches.Count -ne 1) {
        throw "$Label: esperado exatamente 1 bloco em $Path; encontrado $($matches.Count)."
    }

    $updated = [regex]::Replace(
        $content,
        $Pattern,
        $Replacement,
        [System.Text.RegularExpressions.RegexOptions]::Singleline
    )

    [System.IO.File]::WriteAllText($Path, $updated, [System.Text.UTF8Encoding]::new($false))
}

$files = @(
    "src/middlewares/auth.middleware.js",
    "src/routes/products.routes.js",
    "src/routes/categories.routes.js",
    "src/routes/banners.routes.js",
    "src/routes/orders.routes.js",
    "src/routes/customers.routes.js",
    "src/routes/settings.routes.js"
)

foreach ($file in $files) {
    if (-not (Test-Path $file)) {
        throw "Arquivo obrigatório não encontrado: $file"
    }
}

# Garantir árvore limpa antes de modificar.
$status = git status --porcelain
if ($LASTEXITCODE -ne 0) {
    throw "Falha ao executar git status."
}
if ($status) {
    throw "O repositório possui alterações locais. Faça commit/stash antes de executar esta migração."
}

# 1) Ponte temporária de compatibilidade.
# req.admin = formato novo.
# req.auth.admin = formato legado esperado por auditoria/identidade nas rotas atuais.
$middlewarePath = "src/middlewares/auth.middleware.js"
$oldMiddleware = @'
    req.admin = {
      id: currentAdmin.id,
      userId: currentAdmin.auth_user_id || decoded.sub || null,
      email: currentAdmin.email,
      fullName: currentAdmin.full_name || null,
      role: currentAdmin.role,
      is_master: currentAdmin.is_master,
    };



    return next();
'@

$newMiddleware = @'
    req.admin = {
      id: currentAdmin.id,
      userId: currentAdmin.auth_user_id || decoded.sub || null,
      email: currentAdmin.email,
      fullName: currentAdmin.full_name || null,
      role: currentAdmin.role,
      is_master: currentAdmin.is_master,
    };

    // Compatibilidade temporária para rotas administrativas legadas.
    // Não reintroduz credenciais Supabase: apenas preserva req.auth.admin.
    req.auth = {
      admin: currentAdmin,
    };

    return next();
'@

Replace-ExactOnce `
    -Path $middlewarePath `
    -Old $oldMiddleware `
    -New $newMiddleware `
    -Label "ponte req.auth"

# 2) Trocar autenticação duplicada nas seis rotas.
$routeConfigs = @(
    @{
        Path = "src/routes/products.routes.js"
        Marker = "function sanitizeFileName"
    },
    @{
        Path = "src/routes/categories.routes.js"
        Marker = "// Rotas administrativas"
    },
    @{
        Path = "src/routes/banners.routes.js"
        Marker = "// Rotas públicas"
    },
    @{
        Path = "src/routes/orders.routes.js"
        Marker = "function formatCurrency"
    },
    @{
        Path = "src/routes/customers.routes.js"
        Marker = "async function callRpc"
    },
    @{
        Path = "src/routes/settings.routes.js"
        Marker = "async function callRpc"
    }
)

foreach ($cfg in $routeConfigs) {
    $path = $cfg.Path
    $marker = [regex]::Escape($cfg.Marker)

    # Remove somente o import de jsonwebtoken.
    Replace-RegexOnce `
        -Path $path `
        -Pattern '(?m)^import jwt from "jsonwebtoken";\r?\n' `
        -Replacement '' `
        -Label "remover import jwt"

    # Adiciona middleware central imediatamente após import express.
    Replace-RegexOnce `
        -Path $path `
        -Pattern '(?m)^(import express from "express";\r?\n)' `
        -Replacement ('$1' + 'import { requireAdminAuth as requireAuth } from "../middlewares/auth.middleware.js";' + [Environment]::NewLine) `
        -Label "importar middleware central"

    # Remove getUserFromToken + findAdminByEmail + requireAuth local.
    # O bloco inicia exatamente em getUserFromToken e termina antes do primeiro
    # marcador funcional específico de cada arquivo.
    $pattern = 'async function getUserFromToken\(token\) \{.*?(?=' + $marker + ')'
    Replace-RegexOnce `
        -Path $path `
        -Pattern $pattern `
        -Replacement '' `
        -Label "remover autenticação legada"
}

Write-Host ""
Write-Host "Validando sintaxe..." -ForegroundColor Cyan
foreach ($file in $files) {
    node --check $file
    if ($LASTEXITCODE -ne 0) {
        throw "node --check falhou em $file"
    }
}

Write-Host ""
Write-Host "Validando que as seis rotas não verificam JWT localmente..." -ForegroundColor Cyan
$legacyRoutes = $routeConfigs.Path
foreach ($file in $legacyRoutes) {
    $content = [System.IO.File]::ReadAllText($file)

    if ($content -match 'jwt\.verify\s*\(') {
        throw "Ainda existe jwt.verify em $file"
    }

    if ($content -match 'supabase_access_token') {
        throw "Ainda existe dependência de supabase_access_token em $file"
    }

    if ($content -notmatch 'requireAdminAuth as requireAuth') {
        throw "Middleware central não encontrado em $file"
    }
}

Write-Host ""
Write-Host "Arquivos alterados:" -ForegroundColor Green
git diff --name-only

Write-Host ""
Write-Host "Resumo do diff:" -ForegroundColor Green
git diff --stat

Write-Host ""
Write-Host "Validação concluída. NÃO houve alteração no contrato de /api/auth/login." -ForegroundColor Green
Write-Host "Revise com: git diff" -ForegroundColor Yellow
