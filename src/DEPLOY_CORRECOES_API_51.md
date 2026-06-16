# OZONTECK — implantação segura das correções da API 51

## Regra principal

A migration `sql/security-integrity-hardening.sql` deve ser aplicada no Supabase **antes** de publicar o código da API. A API corrigida depende das novas colunas e RPCs para criar pedidos, reservar estoque, processar pagamentos e gerar etiquetas.

## Ordem de implantação

1. Faça backup do banco no Supabase.
2. Abra o SQL Editor e execute `sql/security-integrity-hardening.sql` inteiro.
3. Na última linha de resultado, confirme que todos os campos terminados em `_ok` retornaram `true`.
4. Se algum índice único retornar `false` ou o SQL mostrar aviso de duplicidade, não publique a API ainda. Corrija os registros duplicados antes.
5. Execute também a versão atualizada de `sql/affiliate-product-goal-bonus-lifecycle.sql` caso essa função já esteja instalada no banco.
6. Configure as variáveis descritas em `SECURITY_ENV_REQUIRED.example` no Render. Não copie os valores fictícios.
7. Confirme especialmente: `NODE_ENV=production`, `ENABLE_PAYMENT_SIMULATION=false`, `MASTER_ADMIN_EMAIL`, `MERCADO_PAGO_WEBHOOK_SECRET`, `MELHOR_ENVIO_WEBHOOK_SECRET` e as origens CORS.
8. Publique a API.
9. Entre no painel com o administrador master e refaça a conexão OAuth do Melhor Envio pela nova URL gerada pelo painel.
10. Execute os testes operacionais abaixo, nessa ordem.

## Testes operacionais obrigatórios

1. Health check da API.
2. Login administrativo e abertura dos módulos financeiro, fiscal, precificação e marketing de afiliados.
3. Tentativa sem token nos GETs de tracking: deve retornar 401.
4. Cadastro/login do afiliado e conclusão de um treinamento: a ação deve ficar vinculada ao próprio afiliado.
5. Pedido de teste com produto de estoque conhecido: o estoque deve diminuir ao criar o pedido.
6. Pedido abandonado: após a expiração da reserva, o estoque deve voltar.
7. Pix pendente: pedido e comissão devem continuar pendentes.
8. Webhook aprovado: pedido pago, comissão criada uma vez e etiqueta iniciada uma vez.
9. Reenvio do mesmo webhook: não deve duplicar comissão nem etiqueta.
10. Pedido entregue ainda pendente: não pode liberar comissão.
11. Pedido pago e entregue: deve liberar a comissão.
12. Estorno/chargeback: deve cancelar as conversões e impedir nova liberação.
13. Cancelamento antes do envio: deve devolver o estoque.
14. Consulta pública do status: deve retornar somente os campos reduzidos.
15. Push de pedido: deve exigir token público do pedido ou ID de pagamento válido.

## Mudança intencional na conta do cliente

Um e-mail que já existe por causa de checkout, mas ainda não possui senha, não pode mais ser transformado em conta apenas informando uma nova senha. Isso fechou a tomada de conta por conhecimento do e-mail. Esse cliente deve entrar por Google/Facebook ou passar por um futuro fluxo de ativação por e-mail/suporte.

## Limitações desta entrega

O pacote original não contém `package.json` nem lockfile. Por isso, não foi possível instalar exatamente as dependências, iniciar a API em um ambiente idêntico ao Render ou executar `npm audit`.

Também não foi possível compilar a migration contra o banco real nem chamar Mercado Pago, Melhor Envio, Brevo e Supabase com credenciais de sandbox. As validações realizadas foram sintáticas, estruturais, de imports e de regressões estáticas. Faça os testes operacionais antes de liberar vendas reais.

Os arquivos estruturais vazios, a divisão do grande `store.routes.js`, a duplicidade de fluxos legados e textos antigos com codificação quebrada não foram refatorados nesta etapa, para reduzir o risco de regressão. Eles não devem ser tratados como cobertura real de testes.
