param(
  [string]$WorkspaceRoot = ""
)

$ErrorActionPreference = "Stop"

$ApiRoot = Split-Path -Parent $PSScriptRoot
if (-not $WorkspaceRoot) {
  $WorkspaceRoot = Split-Path -Parent $ApiRoot
}

$AdminRoot = Join-Path $WorkspaceRoot "ozonteck-admin"
$StoreRoot = Join-Path $WorkspaceRoot "ozonteck-loja"

foreach ($requiredPath in @($ApiRoot, $AdminRoot, $StoreRoot)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Container)) {
    throw "Diretório obrigatório não encontrado: $requiredPath"
  }
}

function Invoke-Checked {
  param(
    [string]$Label,
    [scriptblock]$Command
  )

  Write-Host "`n=== $Label ==="
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label falhou com código $LASTEXITCODE."
  }
}

Set-Location $ApiRoot
Invoke-Checked "API: campanhas e regressões críticas" {
  node --test `
    ".\src\tests\marketing-campaign-platform.test.js" `
    ".\src\tests\product-interest-notifications.test.js" `
    ".\src\tests\public-product-projection-regressions.test.js" `
    ".\src\tests\lead-tracking-atomic-regressions.test.js" `
    ".\src\tests\card-payment-integration.test.js" `
    ".\src\tests\payment-reconciliation-regressions.test.js"
}

foreach ($file in @(
  ".\src\services\marketingCampaign.service.js",
  ".\src\services\marketingAudience.service.js",
  ".\src\services\marketingCampaignWorker.service.js",
  ".\src\services\marketingAttribution.service.js",
  ".\src\routes\adminMarketingCampaigns.routes.js",
  ".\src\routes\storeMarketing.routes.js",
  ".\src\workers\marketingCampaign.worker.js"
)) {
  Invoke-Checked "API: sintaxe $file" { node --check $file }
}

Set-Location $StoreRoot
Invoke-Checked "Loja: tracking" {
  node --check ".\frontend\assets\js\tracking.js"
}
Invoke-Checked "Loja: catálogo" {
  node --check ".\frontend\assets\js\core\catalogo-lazy-features.js"
}
Invoke-Checked "Loja: criação do pedido" {
  node --check ".\frontend\assets\js\pages\pagamento.js"
}
Invoke-Checked "Loja: atribuição e segurança do pagamento" {
  node --test `
    ".\tests\marketing-campaign-attribution.test.mjs" `
    ".\tests\payment-security-static.test.mjs"
}

Set-Location $AdminRoot
Invoke-Checked "Admin: testes de campanhas" {
  node --test ".\src\tests\marketing-campaigns-ui.test.js"
}
Invoke-Checked "Admin: build de produção" {
  npm run build
}

foreach ($repository in @($ApiRoot, $StoreRoot, $AdminRoot)) {
  Set-Location $repository
  Invoke-Checked "Git diff check: $repository" {
    git diff --check
  }
}

Write-Host "`nMARKETING_CAMPAIGNS_VERIFICATION_OK=true"
