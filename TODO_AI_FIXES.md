# TODO - Fixes AI (ozonteck-api/src/services/AI)

## Passo 1: Análise e alinhamento de contrato
- [x] Atualizar `src/services/AI/core/ai.core.js` para retornar contrato padrão: success/reply/data/actions/metadata
- [x] Atualizar `src/services/AI/router/ai.route.js` para retornar contrato padrão em erro 500
- [x] Atualizar `src/services/AI/agent/agent.core.js` para remover campos quebrados e padronizar reply/data/actions/metadata
- [x] Atualizar `src/services/AI/tools/execute.tools.js` para aceitar args e executar tools com parâmetros

## Passo 2: Perguntas que consultam banco automaticamente
- [x] Atualizar `src/services/AI/decision/decision.engine.js` para criar sinais FINANCIAL_SUMMARY e ORDERS_SUMMARY para perguntas
- [x] Atualizar `src/services/AI/actions/execute.actions.js` para executar getFinancialSummary/getOrdersSummary

## Passo 3: Writes respeitando Permission Engine
- [ ] Verificar/ajustar dispatcher/tools para que `products_write` chegue com permissões e args reais
- [ ] Garantir que `products.write.tool.js` não dependa de env inexistente e que receba authToken/perms via pipeline
- [ ] Ajustar `permissions.engine.js`/`permission.service.js` se necessário para bloquear writes

## Passo 4: Corrigir integrações faltantes (response formatter / memory / providers / registry)
- [ ] Ler e corrigir `src/services/AI/core/response.core.js` (estava vazio no tool de leitura)
- [ ] Ler e corrigir `src/services/AI/memory/memory.service.js` (tool de leitura retornou vazio)
- [ ] Verificar `src/services/AI/registry/index.js`, `modules.registry.js`, `tools.registry.js` para consistência de exports

## Passo 5: Relatório final
- [ ] Gerar relatório com: arquivos corrigidos, incompletos, integrações faltantes, fluxo final, checklist de produção

