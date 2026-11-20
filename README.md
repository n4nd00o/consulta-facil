# Consulta Fácil — Vale Verde

Aplicativo funcional da proposta do **Grupo 2 (A3)**: agendar, remarcar e cancelar consultas nas UBS,
lembretes por SMS, fila de espera e painel para a equipe da UBS.

**No ar:** https://consulta-facil-kappa.vercel.app · painel da equipe: https://consulta-facil-kappa.vercel.app/painel
(demonstração com dados fictícios; os dados recomeçam de tempos em tempos).

Sem dependências externas: **Node.js 22.5+** (usa o SQLite embutido `node:sqlite`).

> **Passo a passo de instalação, uso e roteiro de demonstração: [COMO-USAR.md](COMO-USAR.md)**

## Veja funcionando

| Agendamento completo (5 passos, sem e-mail) | A última vaga: duas pessoas, uma vaga |
|---|---|
| ![Agendamento completo](docs/gif/agendamento.gif) | ![Esta vaga acabou](docs/gif/ultima-vaga.gif) |
| **SMS fora do ar e clique duplo em "Cancelar"** | **Cadastro de quem ainda não tem (LGPD)** |
| ![SMS fora do ar e clique duplo](docs/gif/sms-fora-do-ar-e-clique-duplo.gif) | ![Cadastro](docs/gif/cadastro.gif) |

À direita do celular fica o **Painel da demonstração**: ele não faz parte do app, só provoca as falhas do piloto
(vaga disputada, SMS fora do ar, clique duplo) e mostra a fila de mensagens (outbox) ao vivo.

### Telas

| | | |
|---|---|---|
| ![Entrar](docs/img/01-entrar.png)<br>**1. Entrar** — CPF e data de nascimento | ![Código SMS](docs/img/02-codigo-sms.png)<br>**2. Código por SMS** | ![Início](docs/img/03-inicio.png)<br>**Início** |
| ![Especialidades](docs/img/04-especialidades.png)<br>**3. Qual consulta** — vagas na semana | ![Unidade](docs/img/05-unidade.png)<br>**4. Unidade** | ![Dia e horário](docs/img/06-dia-e-horario.png)<br>**4. Dia e horário** — "2 vagas", "sem vaga" |
| ![Confirmar](docs/img/07-confirmar.png)<br>**5. Confira e confirme** | ![Consulta marcada](docs/img/08-consulta-marcada.png)<br>**Consulta marcada** | ![Minhas consultas](docs/img/09-minhas-consultas.png)<br>**Minhas consultas** — lembrete e "Vou comparecer" |
| ![Esta vaga acabou](docs/img/10-esta-vaga-acabou.png)<br>**Vaga disputada** — nunca duas reservas | ![Confirmar cancelamento](docs/img/11-confirmar-cancelamento.png)<br>**Cancelar** pede confirmação | ![SMS fora do ar](docs/img/12-sms-fora-do-ar.png)<br>**SMS fora do ar** — retentativa com limite |
| ![Segundo clique](docs/img/13-segundo-clique.png)<br>**Clique duplo** — "já foi cancelada" | ![Cadastro LGPD](docs/img/14-cadastro-autorizacao-lgpd.png)<br>**Cadastro** — autorização LGPD obrigatória | ![No celular](docs/img/16-celular-entrar.png)<br>**No celular** — tela cheia |

![Painel da equipe da UBS](docs/img/15-painel-da-equipe.png)
**Painel da equipe da UBS** — métricas do agendamento, liberação por UBS, SMS que não chegaram, agenda da recepção e migração.

## Tudo gratuito

| Para quê | Ferramenta | Custo |
|---|---|---|
| Servidor e banco | Node.js + SQLite embutido (`node:sqlite`), sem bibliotecas | Gratuito |
| Código | GitHub (repositório público) | Gratuito |
| Publicação | Vercel, plano Hobby | Gratuito |
| Rodar com banco permanente | Docker Desktop (uso pessoal/educacional) | Gratuito |
| SMS de verdade | SMS Gateway for Android (código aberto) + chip do seu celular | Gratuito* |
| Prints e GIFs | Playwright + Microsoft Edge + gifenc | Gratuito |

\* Os SMS saem do plano do celular; a maioria dos planos inclui SMS ilimitado. O suporte ao Twilio continua no
código como opção, mas ele é pago depois do crédito de teste, então **não é necessário**.

```bash
npm start      # http://localhost:3000  (cidadão)  e  http://localhost:3000/painel  (equipe, senha demo: ubs123)
npm test       # 16 testes de aceitação
```

No modo demonstração (padrão), o app aparece numa moldura de celular com o **Painel da demonstração** ao lado:
pacientes fictícios, código SMS de teste e botões que simulam os problemas do piloto (vaga disputada, SMS fora
do ar, clique duplo em "Cancelar") com a fila de mensagens (outbox) ao vivo.
Para produção: `DEMO=0 PAINEL_SENHA=... BACKOFF_UNIT_MS=60000 npm start`.

## Como cada decisão do documento aparece no código

| Documento | Onde está |
|---|---|
| **ADR-001 – Monólito modular** (Agenda, Pacientes/Autenticação, Notificações, Integração legado) | `src/app.js` + `src/modules/*` — um processo, um banco |
| **Uma vaga, uma confirmação** (`UPDATE ... WHERE disponiveis > 0` + unicidade) | `reservarVaga()` em `src/modules/agenda.js`; índice `ux_consulta_ativa_por_vaga` em `src/db.js` |
| Chave de idempotência por clique (duplo clique) | `agendar()` / `remarcar()` + `novaChave()` no front |
| **RA01 – sem e-mail** (CPF + nascimento + código SMS, texto ajustável, alto contraste, ≤ 5 telas) | `src/modules/pacientes.js`, `public/index.html` |
| **RF02** – cancelar de novo não libera a vaga duas vezes; tardio < 2 h; 3 tardios em 30 dias → alerta, sem bloquear; remarcação só troca quando a nova vaga é confirmada | `cancelar()`, `remarcar()` em `agenda.js` |
| Fila de espera com posição; vaga liberada é oferecida ao 1º | `entrarNaFila()`, `ofertarParaFila()` |
| **RF03** – lembrete 24 h antes + confirmar presença com um toque | `gerarLembretes()` em `notificacoes.js` |
| **Falha do SMS**: outbox na mesma transação, timeout 5 s, 5 tentativas (1-2-4-8-16), circuit breaker (5 falhas → 60 s), lista para a UBS ligar | `src/modules/notificacoes.js`, painel |
| **Adapter para o SIGA-Saúde** | `src/modules/siga-adapter.js` (legado simulado com colunas e formatos antigos) |
| **Migração** preparar → ensaiar → validar → transicionar, com reconciliação, idempotente e sem apagar | `src/modules/migracao.js`, botões no painel |
| **Feature flag por UBS / kill switch** (piloto em 3 UBS) | tabela `ubs.ativa`, painel |
| **Observabilidade de negócio**: % de agendamentos concluídos, reservas duplicadas, SMS falhos, p95 | `src/modules/painel.js` |
| **LGPD**: minimização (sem e-mail/prontuário), CPF mascarado, código guardado como hash, erros que não revelam se o CPF existe, auditoria, cookies HttpOnly/SameSite, CSP | `pacientes.js`, `app.js`, tabela `auditoria` |
| **Teste da cadeia de rastreabilidade**: 100 requisições simultâneas → 1 confirmação, 99 recusas, 0 duplicados | `test/consulta-facil.test.js` |

## Heurísticas de Nielsen aplicadas à interface

| # | Heurística | Como aparece no Consulta Fácil |
|---|---|---|
| 1 | Visibilidade do estado do sistema | "Passo X de 5" em cada tela; aba atual destacada; número de vagas por especialidade e por dia; botões mostram "Aguarde…" durante o envio; fila de mensagens com a situação de cada SMS |
| 2 | Correspondência com o mundo real | Linguagem do cidadão ("Agendar consulta", "Vou comparecer", "Já liguei"); datas como as pessoas falam ("Amanhã 20/11 às 07:30"); relatório de migração em texto, não em JSON |
| 3 | Controle e liberdade | Botão ‹ (voltar) no mesmo lugar em toda tela; abas Início/Agendar/Consultas sempre disponíveis; "Escolher outro horário"; reenviar código; Esc fecha diálogos sem executar |
| 4 | Consistência e padrões | Mesmo cabeçalho (voltar, título, A−, A+, contraste) e mesmas abas em todas as telas; mesmos estilos de botão (principal, secundário, perigo); padrão de app de celular |
| 5 | Prevenção de erros | CPF validado antes do envio; data conferida; "Confira e confirme" antes de agendar; horários ocupados não podem ser escolhidos; diálogo de confirmação para cancelar, sair da fila, desligar UBS e migrar; clique duplo não cria duas consultas |
| 6 | Reconhecer em vez de lembrar | Unidade, dia e horário na mesma tela, incluindo os horários "sem vaga"; cartão "Sua próxima consulta" no Início; o que a remarcação substitui |
| 7 | Flexibilidade e eficiência | Atalho "Ver, remarcar ou cancelar" no Início; dia com vaga já selecionado; UBS ordenadas pelo horário mais cedo; tecla Enter envia formulários; avanço automático dia → mês → ano |
| 8 | Estética e design minimalista | Uma decisão por tela; ajuda recolhida; dados de demonstração fora do app (painel ao lado) |
| 9 | Ajudar a reconhecer e corrigir erros | Erro junto do campo, dizendo o que fazer ("Faltam números no CPF: você digitou 9 de 11"); "Esta vaga acabou" com horários próximos e fila de espera |
| 9b | (cadastro) | Cadastro de quem não está no SIGA-Saúde: erro "não encontramos cadastro" leva a "Criar meu cadastro"; CPF já cadastrado volta para "Entrar" com os dados preenchidos; cada campo explica o que corrigir |
| 10 | Ajuda e documentação | "Ajuda" no rodapé do Início e da entrada abre as dúvidas comuns (SMS, primeira vez, sem horário, cancelar, Disque Saúde 136); orientações para o dia da consulta |

Acessibilidade (RA01/WCAG 2.1 AA): texto ajustável, alto contraste, contraste ≥ 4,5:1, foco visível, alvos de toque ≥ 44 px,
rótulos e mensagens ligados aos campos (`aria-describedby`, `aria-invalid`), avisos em `aria-live`, etapa atual com `aria-current`.

## Publicação na Vercel

O mesmo código roda localmente (`npm start`) e na Vercel:

- A Vercel detecta `src/app.js` como servidor: a exportação padrão (`handler`) atende páginas e API.
  O `vercel.json` só inclui a pasta `public/` na função.
- Sem processo contínuo na Vercel, a fila de SMS (outbox) avança a cada requisição.
- O banco SQLite fica em `/tmp`, que é **temporário**: a demonstração recomeça com os dados iniciais sempre que a
  Vercel cria uma nova instância (e pode pedir login de novo). Para produção, o banco iria para um serviço
  gerenciado (ex.: Postgres), trocando apenas a camada de dados.
- A Vercel roda várias cópias do app ao mesmo tempo. Por isso o login (do cidadão e da equipe) é um **token
  assinado (HMAC)** no cookie, que vale em qualquer cópia; o banco guarda só a lista de sessões encerradas.
  A chave fica na variável `SESSAO_SEGREDO` (já configurada no projeto da Vercel; localmente é gerada a cada início).
- Variável opcional no painel da Vercel: `PAINEL_SENHA` (senha do painel da equipe; padrão de demonstração `ubs123`).

## SMS real e Docker

- **SMS de verdade, de graça:** `SMS_PROVEDOR=smsgate` + usuário/senha do app **SMS Gateway for Android**
  (código aberto): um celular Android envia os SMS pelo próprio chip. Também há suporte ao Twilio (pago após o
  crédito de teste). Veja `.env.example` e a seção 12 do COMO-USAR. Sem credenciais, o app usa o provedor simulado. Número inválido ou não verificado
  (erro 4xx) é **falha permanente**: vai direto para a lista "ligar para o paciente" e não abre o circuit
  breaker. Provedor fora do ar (5xx/timeout) é **falha temporária**: retenta com espera crescente.
- **Docker:** `docker compose up -d --build`; o banco fica num volume e é **permanente** (seção 13 do COMO-USAR).
- Cada `git push` na branch `main` publica automaticamente uma nova versão.

## Simular as falhas do piloto (painel → "Simular provedor")

- **Fora do ar**: agende uma consulta — ela é confirmada; o SMS fica na fila, o circuito abre após 5 falhas
  e, esgotadas as tentativas, a mensagem aparece em "SMS que não chegaram — ligar para o paciente".
- **Lento**: cada chamada é cortada pelo timeout de 5 s.
- **Última vaga**: Pediatria na UBS Centro tem 1 horário livre no próximo dia útil; dois pacientes tentando
  ao mesmo tempo → só um confirma, o outro vê "Esta vaga acabou" e pode entrar na fila de espera.

Para recomeçar do zero, apague a pasta `data/`.

Fora do escopo deste protótipo: provedor de SMS/WhatsApp real, conexão ao banco real do SIGA-Saúde,
pipeline de CI/CD e backup PITR (descritos nas questões 5 e 6 do documento).
