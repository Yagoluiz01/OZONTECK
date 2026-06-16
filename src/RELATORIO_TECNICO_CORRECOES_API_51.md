# Relatório técnico de correções — API OZONTECK 51

**Data:** 7 de junho de 2026  
**Origem:** `api(51).zip`  
**Entrega:** API corrigida sem exclusão de arquivos existentes.

## Veredito

Os 11 riscos críticos e os principais riscos altos identificados na auditoria foram tratados de forma localizada. A entrega adiciona autenticação e autorização, reserva transacional de estoque, idempotência financeira, proteção de webhooks, reversão de comissões, OAuth state de uso único, limites de upload e testes de regressão.

A API não deve ser publicada antes da migration `sql/security-integrity-hardening.sql`. Sem ela, o checkout corrigido recusará a criação do pedido para evitar operar sem reserva atômica de estoque.

## Correções críticas

| ID | Situação | Correção aplicada |
|---|---|---|
| C-01 | Corrigido | Marketing administrativo exige sessão de admin; mutações e uploads exigem master; tamanho real, MIME real, extensão e rate limit foram validados. |
| C-02 | Corrigido | Consultas de sessões, eventos e leads agora exigem admin master; gravações públicas receberam limites e respostas reduzidas. |
| C-03 | Corrigido por bloqueio seguro | Registro existente de checkout não pode mais ser reivindicado somente pelo e-mail. |
| C-04 | Corrigido | Ações e treinamentos exigem token de afiliado e usam `req.affiliateId`. |
| C-05 | Corrigido | Pedido, itens e reserva de estoque foram movidos para uma RPC transacional com bloqueio de produtos. |
| C-06 | Corrigido | Comissão e meta só liberam com pagamento confirmado **e** entrega confirmada. |
| C-07 | Corrigido | Rejeição, cancelamento, estorno e chargeback acionam reversão das conversões e metas; estoque volta quando ainda não houve envio. |
| C-08 | Corrigido | Transição de pagamento e claim de etiqueta são atômicos; índices únicos impedem duplicidade de comissão. |
| C-09 | Corrigido | Simulação exige master, fica desativada em produção e a API recusa iniciar se a variável estiver ativa em produção. |
| C-10 | Corrigido | OAuth do Melhor Envio usa state aleatório, hash, expiração e consumo único no banco. |
| C-11 | Corrigido | Número do pedido usa data + 96 bits aleatórios e recebe índice único no banco. |

## Correções de risco alto

- Admin é revalidado na tabela `admins` em cada rota protegida; desativação e troca de função passam a valer imediatamente.
- Módulos financeiro, fiscal, precificação, pixels e operações críticas de afiliados exigem master.
- Processamento manual de pedido pago exige master e recusa pedido sem pagamento confirmado.
- Mudança manual para enviado/entregue é bloqueada quando o pagamento não está confirmado.
- Pedido e itens deixam de ser gravados separadamente.
- Assinatura inválida do Mercado Pago é rejeitada; em produção, segredo ausente torna o webhook indisponível.
- Valor, moeda e vínculo do pagamento são comparados com o pedido antes da confirmação.
- Status público do pedido foi reduzido; URLs internas, IDs de envio e referências financeiras não são retornados.
- Push de pedido exige token secreto do pedido ou ID de pagamento vinculado.
- Conta desativada de cliente e afiliado perde acesso mesmo com token antigo.
- E-mail normalizado do cliente recebe índice único, desde que os dados atuais não tenham duplicidades.
- Webhook do Melhor Envio usa somente identificadores exatos e recusa ambiguidade.
- Upload de produto possui limite de 8 MB, tipos permitidos e assinatura real do arquivo.

## Robustez adicional

- Limite JSON global caiu de 80 MB para 2 MB.
- O limite de 70 MB ficou isolado no upload legado base64 do marketing; o arquivo decodificado continua limitado a 50 MB.
- Webhook do Melhor Envio mantém corpo bruto isolado para HMAC.
- Caminho estático de etiquetas foi corrigido para a raiz do projeto.
- Servidor fecha timers e listener HTTP de forma graciosa.
- Reserva vencida de estoque é liberada automaticamente em job idempotente.
- Falha de upload não cria produto silenciosamente sem imagem.
- Erros 5xx em produção recebem mensagem genérica e ID de rastreio.

## Validação executada

- **179 arquivos JavaScript** passaram em `node --check`.
- **173 imports relativos** foram resolvidos; nenhum arquivo ausente.
- **16 testes de regressão estática** passaram; zero falhas.
- Migration contém 6 RPCs de integridade, índices de reserva/consulta e verificações finais visíveis no SQL Editor.
- Nenhum arquivo existente foi removido.

## Arquivos modificados (24)

- `app.js`
- `config/env.js`
- `jobs/processPaidOrder.js`
- `middlewares/auth.middleware.js`
- `routes/adminAffiliateMarketing.routes.js`
- `routes/adminAffiliates.routes.js`
- `routes/adminFinancial.routes.js`
- `routes/adminFiscal.routes.js`
- `routes/adminMarketingPixels.routes.js`
- `routes/adminPricing.routes.js`
- `routes/affiliateMarketing.routes.js`
- `routes/orders.routes.js`
- `routes/products.routes.js`
- `routes/shipping.routes.js`
- `routes/store.routes.js`
- `routes/storeCustomerAccount.routes.js`
- `routes/tracking.routes.js`
- `server.js`
- `services/affiliateCommissionLifecycle.service.js`
- `services/affiliatePortal.service.js`
- `services/affiliateProductGoalLifecycle.service.js`
- `services/melhorEnvio.service.js`
- `services/melhorEnvioWebhook.service.js`
- `sql/affiliate-product-goal-bonus-lifecycle.sql`

## Arquivos adicionados (9)

- `DEPLOY_CORRECOES_API_51.md`
- `RELATORIO_TECNICO_CORRECOES_API_51.md`
- `SECURITY_ENV_REQUIRED.example`
- `VALIDACAO_ESTATICA_API_51.txt`
- `jobs/releaseExpiredStockReservations.js`
- `services/oauthState.service.js`
- `services/orderStock.service.js`
- `sql/security-integrity-hardening.sql`
- `tests/security-regressions.test.js`

## Arquivos removidos (0)

- Nenhum.

## Ordem obrigatória de publicação

1. Backup do Supabase.
2. Executar `sql/security-integrity-hardening.sql`.
3. Confirmar que todos os campos `_ok` do resultado final são `true`.
4. Resolver qualquer aviso de dados duplicados antes de continuar.
5. Aplicar a versão atualizada de `sql/affiliate-product-goal-bonus-lifecycle.sql`.
6. Configurar as variáveis de `SECURITY_ENV_REQUIRED.example` no Render.
7. Publicar a API.
8. Reconectar o Melhor Envio pelo painel.
9. Executar os testes operacionais de `DEPLOY_CORRECOES_API_51.md`.

## Limitações e riscos residuais

- O ZIP original não possui `package.json` nem lockfile. Não foi possível reproduzir as dependências, iniciar a aplicação como no Render ou executar `npm audit`.
- A migration não foi executada contra o banco real; conflitos de schema ou dados duplicados precisam ser verificados no SQL Editor.
- Mercado Pago, Melhor Envio, Brevo e Supabase não foram chamados com credenciais reais/sandbox nesta análise.
- O fluxo seguro de ativação por e-mail para cliente pré-existente ainda não foi construído no frontend. Por segurança, o cadastro por senha fica bloqueado nesse caso; Google/Facebook ou suporte continuam como caminhos disponíveis.
- Arquivos estruturais vazios, duplicidades legadas e a divisão de `store.routes.js` não foram refatorados nesta etapa para evitar regressão ampla.
- Permanecem mensagens antigas com codificação danificada em alguns arquivos. É um problema visual/log, não a base da correção financeira entregue.
- Efeitos externos como e-mail e evento Meta não são transações de banco. A idempotência evita duplicidade; uma queda exatamente entre o pagamento e o envio externo ainda pode exigir reconciliação operacional.

## Regra de segurança

Não substitua apenas o código e publique. **Banco primeiro, API depois.**
