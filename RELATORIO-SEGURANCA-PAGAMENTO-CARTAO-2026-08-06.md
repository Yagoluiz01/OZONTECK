# Auditoria de segurança e pagamento com cartão

Data: 06/08/2026

## Conclusão

Antes da correção, o Checkout Transparente com cartão não estava completo no caminho realmente usado pela loja. O frontend tentava chamar rotas de pagamento que não existiam na API principal. O backend legado possuía rotas locais, mas elas não validavam adequadamente a posse do pedido e não eram a origem preferencial do frontend.

Após a correção, o fluxo está implementado e foi validado com integração simulada da API do Mercado Pago. Nenhum cartão real foi cobrado durante a auditoria. A validação real de ponta a ponta depende do deploy e da configuração das credenciais correspondentes no serviço da API.

## Correções críticas aplicadas

### Pagamento com cartão

- Adicionados os endpoints de configuração pública, consulta de parcelas e processamento de cartão na API principal.
- O cartão é tokenizado pelos campos seguros do Mercado Pago; a API recebe somente o token descartável.
- Valor, e-mail e CPF utilizados no pagamento são lidos do pedido salvo no servidor. Dados enviados pelo navegador não substituem esses valores.
- Toda tentativa de pagamento exige o token público de acesso do pedido.
- Chaves de idempotência são criptograficamente aleatórias e não contêm CPF ou outros dados pessoais.
- Timeout nas chamadas ao gateway e respostas públicas sanitizadas.
- Suporte ao redirecionamento seguro quando o gateway solicitar autenticação adicional.
- O carrinho só é apagado depois que o gateway aceita o pagamento.

### Webhook e confirmação

- Webhook do Mercado Pago passou a falhar fechado quando a assinatura está ausente, inválida ou fora da janela de tempo.
- Mantida a confirmação do pagamento pela API oficial do gateway antes de alterar o pedido.
- Validação de valor, moeda e identidade do pedido.
- Página de sucesso não confia mais em `status=approved` da URL.
- O status oficial do pedido exige token de acesso e retorna apenas dados mínimos.
- Notificações push do pedido também exigem o mesmo token.
- Evento de compra do pixel só é disparado após confirmação oficial.

### Proteção de dados no navegador

- Checkout completo, CPF, endereço e token do pedido não são persistidos em `localStorage`.
- Dados sensíveis da conta ficam apenas em `sessionStorage`; o armazenamento persistente recebe somente dados básicos permitidos.
- Removido login legado que comparava senha armazenada no navegador.
- Memória de recompra não pula mais a confirmação de CPF, endereço e frete.
- Token do pedido é mantido somente na sessão da aba e nunca colocado na URL.
- Service Worker não armazena páginas, APIs ou parâmetros de pagamento no Cache Storage.

### Superfície pública

- Simulação Pix por `?mock=true` foi bloqueada fora de `localhost` e `127.0.0.1`.
- Rotas locais legadas de pagamento ficam desativadas em produção.
- Endpoints de debug e auditoria do gateway local ficam indisponíveis em produção.
- CORS do proxy deixou de refletir origens arbitrárias com credenciais.
- `X-Powered-By` removido.
- CSP do gateway reforçada e `unsafe-eval` removido.
- Limites de corpo reduzidos e limites maiores isolados somente onde são necessários.
- Rate limits específicos para pagamento, parcelas, webhook e consulta do pedido.
- Conteúdo dinâmico nos resumos do checkout/pagamento passou a ser escapado antes de entrar no HTML.

## Credenciais expostas no repositório

Foi confirmado que `backend/.env` estava rastreado pelo Git. Também havia uma credencial do Mercado Pago escrita em `CONTEXTO_HOMOLOGACAO.md`; o arquivo foi sanitizado.

A remoção do arquivo do commit atual não invalida credenciais já presentes no histórico. É obrigatório:

1. Remover `backend/.env` do controle de versão.
2. Rotacionar todas as credenciais contidas nele, principalmente Access Token, segredo de webhook e chaves de banco.
3. Não reutilizar os valores antigos, mesmo que fossem credenciais de teste.
4. Revisar o histórico do repositório após a rotação.

## Variáveis obrigatórias na API do Render

```text
MERCADO_PAGO_ACCESS_TOKEN=<novo valor>
MERCADO_PAGO_PUBLIC_KEY=<public key da mesma aplicação>
MERCADO_PAGO_WEBHOOK_SECRET=<novo segredo>
MERCADO_PAGO_ALLOW_UNSIGNED_WEBHOOKS=false
MERCADO_PAGO_WEBHOOK_MAX_SKEW_SECONDS=600
STRICT_CORS=true
CORS_ORIGINS=https://ozonteck-loja.onrender.com,https://DOMINIO-REAL-DO-ADMIN
```

A Public Key e o Access Token precisam pertencer à mesma aplicação e ao mesmo ambiente, teste ou produção.

## Webhook

Configurar no Mercado Pago usando o domínio real da API:

```text
https://DOMINIO-REAL-DA-API/api/store/payments/mercado-pago/webhook
```

## Testes executados

- Sintaxe dos arquivos JavaScript alterados: aprovada.
- Testes direcionados da API: 23 de 23 aprovados.
- Testes estáticos de segurança da loja: 7 de 7 aprovados.
- Integração simulada de cartão confirmou que:
  - o servidor usa o valor salvo no pedido;
  - o servidor ignora e-mail e CPF adulterados no navegador;
  - o token público do pedido é obrigatório;
  - a chave de idempotência não contém CPF;
  - a consulta de status sem token retorna 403;
  - a resposta de status não expõe CPF nem e-mail.
- Suíte completa da API: 36 de 37 testes aprovados. A única falha já existia em `src/tests/banners.test.js`, que contém `await import` em contexto não assíncrono e não pertence ao pagamento.

## Limitações

- Nenhum pagamento real ou de teste foi enviado ao Mercado Pago durante esta auditoria. Fazer isso antes do deploy criaria efeitos externos e não validaria o código ainda não publicado.
- O `npm audit` não pôde consultar o endpoint de auditoria do registro disponível no ambiente. Portanto, não há afirmação de que todas as dependências estejam livres de vulnerabilidades.
- Auditoria de código e testes reduzem riscos, mas não provam ausência total de vulnerabilidades. Após o deploy, executar teste com credenciais de teste e comprador de teste do Mercado Pago.

## Ordem de publicação

1. Rotacionar credenciais expostas.
2. Publicar a API.
3. Configurar as variáveis e o webhook no Mercado Pago/Render.
4. Publicar a loja.
5. Testar com credenciais e cartões de teste.
6. Somente depois trocar para credenciais de produção.
