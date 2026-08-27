# Bateria de testes — campanhas V1

Nenhuma etapa desta lista deve ser executada diretamente em produção sem
backup, janela de mudança e confirmação explícita. O worker permanece
desativado até o teste controlado de envio real.

## 1. Validação local e regressões

- Executar os testes da plataforma, notificações de interesse, tracking,
  projeção pública, pagamentos e conciliação.
- Executar as regressões da loja para atribuição e segurança de pagamentos.
- Validar a sintaxe de todos os arquivos novos da API e da loja.
- Gerar o build de produção do painel.
- Executar `git diff --check` e a varredura de segredos apenas nos arquivos da
  entrega.

Critério: zero falhas; avisos de tamanho do bundle não bloqueiam esta entrega,
mas devem ser tratados em uma otimização separada.

## 2. Banco em ambiente de teste

- Confirmar backup restaurável.
- Aplicar `20260827-marketing-campaign-platform.sql` em staging.
- Executar `20260827-marketing-campaign-platform-verification.sql`.
- Confirmar `all_checks_ok=true`, automação desligada, publicação automática
  desligada e simulação padrão ligada.
- Validar que `anon` e `authenticated` não leem tabelas internas.
- Executar o rollback em um banco descartável e reaplicar a migration.

## 3. API e RBAC

- Master acessa todas as rotas.
- Perfil com `campaigns.view` apenas consulta.
- Perfil sem `campaigns.manage` não cria nem edita.
- Perfil sem `campaigns.publish` não simula, agenda, publica, pausa ou cancela.
- Perfil sem `campaigns.analytics` não consulta métricas detalhadas.
- Mutação sem CSRF e sessão válida deve falhar.
- URL externa, imagem fora da allowlist, produto inativo e estoque zero devem
  falhar de forma segura.

## 4. Painel administrativo

- Criar e editar rascunhos de produto e de aviso.
- Selecionar até 50 produtos e confirmar bloqueio do 51º.
- Estimar público sem carregar chaves Push no fluxo de estimativa.
- Executar simulação e confirmar retorno ao estado `draft`.
- Agendar, pausar, retomar e cancelar sem duplicar job.
- Validar gráficos, estado vazio, responsividade e mensagens de erro.
- Cadastrar desconto e confirmar que permanece `draft` e não altera o pedido.

## 5. Loja, clique e atribuição

- Abrir link opaco e confirmar redirecionamento apenas para a origem da loja.
- Confirmar remoção de `oz_mkt` da barra e armazenamento por no máximo 30 dias.
- Confirmar um clique único e múltiplos cliques totais.
- Confirmar que cartão e PIX/outros enviam uma cópia decorada do pedido.
- Confirmar que pixels, logs e telemetria não recebem o token de atribuição.
- Confirmar que páginas críticas carregam a versão atual do `tracking.js`.
- Confirmar atribuição `pending` antes do pagamento.
- Confirmar que pedido pendente não vira conversão.
- Confirmar conversão e receita oficial somente depois do pagamento aprovado.

## 6. Worker e concorrência

- Com worker desligado, confirmar zero consultas de reivindicação.
- Reivindicar o mesmo job com dois workers e confirmar `SKIP LOCKED`.
- Derrubar um worker, esperar o lease e confirmar retomada idempotente.
- Simular falha transitória, 404/410 de endpoint e retry exponencial.
- Pausar e cancelar durante um lote e confirmar interrupção entre lotes.
- Confirmar limites diário/semanal sob concorrência.

## 7. Audiência inteligente

- Visitante e cliente sem interesse: seleção por descoberta.
- Perfil masculino aprendido: campanha masculina selecionada.
- Perfil masculino aprendido: campanha feminina excluída.
- Público `all_opted_in`: todos com consentimento, exceto supressões.
- Dois dispositivos da mesma pessoa: uma pessoa e duas tentativas.

## 8. Envio real controlado

- Usar uma campanha e uma inscrição de teste identificada.
- Confirmar manualmente o envio real.
- Validar aceite do provedor, exibição no navegador, clique e destino.
- Confirmar que o painel não chama aceite do provedor de “leitura”.
- Só depois criar o Background Worker e habilitar a flag do worker.

## 9. Automação de produtos

- Manter `MARKETING_AUTOMATION_REAL_SEND_ENABLED=false`.
- Habilitar o motor com simulação padrão e testar lançamento, reativação e
  reposição.
- Confirmar cooldown e ausência de campanhas duplicadas.
- Habilitar publicação automática ainda em dry-run.
- Envio automático real é a última chave e exige nova confirmação da mudança.
