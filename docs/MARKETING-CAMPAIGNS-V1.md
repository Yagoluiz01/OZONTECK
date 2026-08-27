# Plataforma de campanhas — V1

## Objetivo

Centralizar campanhas manuais e automáticas de Web Push para clientes e
visitantes com consentimento, usando o interesse aprendido para reduzir
mensagens irrelevantes.

## Fluxo

1. O administrador cria um rascunho e seleciona produtos, público e conteúdo.
2. A API valida produto, estoque, URL, imagem, permissões e limites.
   O rascunho e seus produtos são gravados na mesma transação.
3. A estimativa calcula pessoas e dispositivos sem carregar chaves Push.
4. A simulação calcula a audiência, não cria entregas e devolve a campanha ao
   estado de rascunho.
5. O envio real ou agendado cria o job atomicamente no Postgres.
6. Um worker dedicado reivindica jobs com `SKIP LOCKED`, renova o lease e
   respeita pausa/cancelamento entre lotes.
7. Cada pessoa é reservada de forma concorrente e sujeita aos limites diário e
   semanal. Cada dispositivo gera uma tentativa separada.
8. O link opaco registra o clique antes de redirecionar para a loja.
9. A loja guarda o token de atribuição por até 30 dias, sem colocá-lo em logs.
10. O pedido pode registrar a atribuição e só vira conversão após pagamento
    oficialmente confirmado.

## Públicos

- `smart`: pessoas com interesse aprendido compatível; quem ainda não possui
  interesse elegível entra em descoberta, se habilitada.
- `all_opted_in`: todos os clientes e visitantes com inscrição Push ativa,
  respeitando supressões.
- `category`: somente perfis elegíveis das categorias informadas.

Uma pessoa pode ter mais de um dispositivo. Métricas de pessoas e tentativas
em dispositivos permanecem separadas.

## Métricas honestas

- **Selecionadas:** pessoas pseudônimas escolhidas naquela campanha.
- **Aceitas pelo provedor:** ao menos um dispositivo recebeu resposta de aceite
  do provedor Push. Não comprova exibição ou leitura.
- **Cliques únicos:** destinatários cujo link opaco foi aberto ao menos uma vez.
- **CTR:** cliques únicos divididos por pessoas aceitas pelo provedor.
- **Conversões:** pedidos atribuídos que chegaram ao estado pago.
- **Receita atribuída:** total oficial dos pedidos convertidos.

## Proteções

- RLS habilitada e nenhum acesso `anon`/`authenticated` às tabelas internas.
- RPCs disponíveis somente para `service_role`.
- RBAC separado para visualizar, gerenciar, publicar e analisar.
- CSRF e cookie HttpOnly reutilizam a camada segura do painel.
- URLs de destino aceitam somente a origem oficial da loja.
- Imagens aceitam somente HTTPS e origens autorizadas.
- Tokens de clique são HMAC opacos; IP é armazenado apenas como hash.
- Publicação e criação do job ocorrem na mesma transação.
- Frequência é reservada com advisory lock para evitar corrida.
- Worker desativado por padrão, com retry exponencial e lease renovável.
- Falha de atribuição nunca bloqueia checkout, pagamento ou pedido.

## Descontos

Promoções são cadastradas apenas como rascunho nesta etapa. A flag
`MARKETING_PROMOTIONS_CHECKOUT_ENABLED` permanece `false` até o checkout
calcular o desconto no servidor, reservar uso atomicamente e testar estorno,
expiração, estoque e concorrência. Não habilitar apenas pela interface.

## Integração de conversão na loja

O `tracking.js` captura o token opaco `oz_mkt` do fragmento do link, remove-o
da barra de endereço e o mantém por no máximo 30 dias. A integração está
concluída em `frontend/assets/js/pages/pagamento.js`: os dois caminhos que criam
pedido (cartão e PIX/outros) passam uma cópia do corpo pelo decorador
imediatamente antes de `POST /api/store/orders`:

```javascript
const requestPayload = buildAttributedOrderPayload(payload);
```

O backend aceita `marketingAttributionToken`, vincula o pedido ao último clique
válido e só registra receita quando o pagamento oficial estiver confirmado.
O payload original continua sendo usado nos pixels e na telemetria, portanto o
token não é enviado a terceiros nem escrito em console. As páginas críticas
também usam uma versão nova do asset para evitar cache do `tracking.js` antigo.
Essa integração é coberta por `marketing-campaign-attribution.test.mjs`.

## Ordem segura de implantação

1. Confirmar backup e executar a bateria completa de testes.
2. Desativar o worker legado com
   `PRODUCT_INTEREST_NOTIFICATIONS_ENABLED=false`.
3. Manter `MARKETING_CAMPAIGN_WORKER_ENABLED=false`.
4. Aplicar `20260827-marketing-campaign-platform.sql` e executar as consultas de
   `20260827-marketing-campaign-platform-verification.sql` para validar RLS,
   grants, funções, triggers e defaults.
5. Publicar a API e validar health, autenticação, RBAC e rotas sem envio.
6. Publicar o painel e a loja, validando cache e captura do link.
7. Criar campanha de teste, estimar e executar simulação.
8. Executar envio real para uma inscrição controlada.
9. Criar o Background Worker com o comando `npm run start:marketing-worker`.
10. Habilitar o worker apenas depois do teste controlado.
11. Habilitar automação e publicação automática em etapas separadas.

A sequência completa e os critérios de aprovação estão em
`MARKETING-CAMPAIGNS-TEST-PLAN.md`.

## Rollback

1. Desativar o Background Worker.
2. Desativar automação no painel.
3. Reverter API, painel e loja.
4. Aplicar `20260827-marketing-campaign-platform-rollback.sql` somente se for
   necessário remover o novo esquema. O rollback restaura o trigger legado se
   a função antiga ainda existir.

O rollback do banco remove dados da nova plataforma. Exportar campanhas e
métricas antes de executá-lo.
