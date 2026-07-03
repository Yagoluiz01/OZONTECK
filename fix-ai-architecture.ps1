Write-Host "===================================" -ForegroundColor Cyan
Write-Host "   OZONTECK AI ARCHITECTURE FIX    " -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan

Write-Host "`n[1] Limpando cache do Node..." -ForegroundColor Yellow

Remove-Item -Recurse -Force node_modules\.cache -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force .nodemon -ErrorAction SilentlyContinue

Write-Host "`n[2] Procurando imports quebrados (services/actions)..." -ForegroundColor Yellow

Select-String -Path "src/**/*.js" -Pattern "services/actions" -ErrorAction SilentlyContinue

Write-Host "`n[3] Procurando imports quebrados (AI/core/actions)..." -ForegroundColor Yellow

Select-String -Path "src/**/*.js" -Pattern "AI/core/actions" -ErrorAction SilentlyContinue

Write-Host "`n[4] Verificando arquivos críticos da IA..." -ForegroundColor Yellow

$files = @(
"src/services/AI/core/ai.core.js",
"src/services/AI/actions/execute.actions.js",
"src/services/AI/actions/products.actions.js",
"src/services/AI/actions/financial.actions.js",
"src/services/AI/actions/orders.actions.js"
)

foreach ($file in $files) {
    if (Test-Path $file) {
        Write-Host "OK  -> $file" -ForegroundColor Green
    } else {
        Write-Host "MISSING -> $file" -ForegroundColor Red
    }
}

Write-Host "`n[5] Resultado final..." -ForegroundColor Cyan
Write-Host "Se aparecer MISSING ou imports antigos, sua IA ainda está quebrada." -ForegroundColor Yellow

Write-Host "`n===================================" -ForegroundColor Cyan
Write-Host "   CHECK FINALIZADO                " -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan