# Alertas de estoque — OZONTECK API

Implementação de 17/08/2026.

## O que foi implementado

- alerta **crítico** quando o estoque disponível cruza de `> 0` para `0`;
- alerta **alto** quando o estoque cruza de acima do limite para o limite baixo;
- reaproveitamento de `createAdminNotification()`, portanto a notificação é salva no sino do Admin e o push já existente é disparado;
- cobertura da reserva inicial de pedido, nova reserva de pedido e ajuste manual no painel;
- ausência de alerta repetido em estados como `0 -> 0` ou `5 -> 4`;
- captura de `previous_stock` e `current_stock` dentro das RPCs SQL para evitar inferência insegura em pedidos concorrentes.

## Configuração

Valores padrão:

```env
STOCK_NOTIFICATIONS_ENABLED=true
STOCK_LOW_ALERT_THRESHOLD=5
```

`STOCK_LOW_ALERT_THRESHOLD=5` significa que a notificação de estoque baixo ocorre no primeiro cruzamento, por exemplo `6 -> 5`. Ela não é repetida em `5 -> 4`, `4 -> 3`, etc. O alerta crítico continua ocorrendo em `1 -> 0`.

## Ordem segura de publicação

1. Faça backup das funções/RPCs atuais no Supabase.
2. Execute no SQL Editor:
   `src/sql/20260817-stock-alert-transitions.sql`
3. Confirme que a migration terminou sem erro.
4. Publique os arquivos JavaScript da API.
5. Reinicie a API.
6. Teste primeiro com um produto de homologação.

A migration deve ser aplicada **antes** do código da API. O código é tolerante à ausência de `stock_changes`, mas os alertas de pedidos dependem desse campo para usar a transição atômica exata.

## Testes recomendados

### Estoque baixo

Defina um produto com estoque `6` e faça uma reserva de `1` unidade.

Esperado:

- estoque final `5`;
- uma notificação `stock_low`;
- prioridade `high`;
- push para dispositivos administrativos inscritos.

### Estoque esgotado

Defina um produto com estoque `1` e faça uma reserva de `1` unidade.

Esperado:

- estoque final `0`;
- uma notificação `stock_out`;
- prioridade `critical`;
- push para dispositivos administrativos inscritos.

### Proteção contra repetição

- `5 -> 4`: não cria novo alerta de estoque baixo;
- `0 -> 0`: não cria alerta;
- `0 -> 10`: não cria alerta;
- depois de uma reposição `0 -> 10`, um futuro `1 -> 0` volta a gerar alerta normalmente.

### Ajuste manual

No Admin, altere um produto de `1` para `0`.

Esperado: o mesmo alerta crítico deve ser criado, com `source = admin_product_edit` nos metadados.

## Reserva de pedido

A regra atual do projeto reserva estoque por até 24 horas. Portanto, um alerta de estoque esgotado significa **estoque disponível esgotado**, e pode ter sido causado por um pedido ainda pendente de pagamento. A mensagem foi escrita dessa forma propositalmente.

## Rollback

Se for necessário desfazer somente a alteração das RPCs, execute:

`src/sql/20260817-stock-alert-transitions-rollback.sql`

Depois faça rollback dos arquivos JavaScript deste patch. O rollback SQL mantém as permissões das funções restritas ao `service_role`.

## Validação executada

- `node --check` nos arquivos JavaScript alterados: OK;
- testes novos de estoque: 4/4 aprovados;
- suíte geral: 152/153 aprovados;
- a falha restante está em `src/tests/banners.test.js` e é anterior/não relacionada: existe um `await import(...)` em contexto sintaticamente inválido no próprio teste.
