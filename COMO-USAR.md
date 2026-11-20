# Consulta Fácil — Guia de funcionamento

Este guia explica como instalar, rodar e demonstrar o protótipo do **Consulta Fácil**
(Projeto A3 — Grupo 2). Para a relação entre o código e as decisões do documento, veja o `README.md`.

---

## 1. Pré-requisitos

| Item | Versão | Como conferir |
|---|---|---|
| Node.js | **22.5 ou superior** (recomendado 24 LTS) | `node --version` |
| Navegador | Chrome, Edge ou Firefox atualizados | — |

Não é preciso instalar banco de dados nem rodar `npm install`: o projeto não tem dependências externas
e usa o SQLite que já vem dentro do Node.js.

> Sem o Node.js? Baixe a versão LTS em https://nodejs.org e reinicie o terminal depois de instalar.

---

## 2. Como iniciar

> **Sem instalar nada:** a versão publicada está em https://consulta-facil-kappa.vercel.app
> (painel da equipe em `/painel`). Ela usa um banco temporário: os dados voltam ao início de tempos em
> tempos e, raramente, pode ser preciso entrar de novo. Para a apresentação, rodar localmente é o mais estável.

Para rodar no seu computador:

Abra o **PowerShell** (ou o terminal do VS Code) na pasta do projeto:

```powershell
cd "D:\Projeto A3 - Modelos, metodos e tecnicas de Eng. de Software\consulta-facil"
npm start
```

O terminal mostra:

```
Consulta Fácil rodando em http://localhost:3000
Painel da UBS:          http://localhost:3000/painel  (senha: ubs123)

Pacientes de demonstração (dados fictícios):
  CPF 12345678909  nascimento 15/03/1948  MARIA DAS GRACAS SOUZA
  ...
```

Deixe esse terminal aberto enquanto usa o sistema. Para parar, pressione **Ctrl + C**.

| Endereço | Para quem |
|---|---|
| http://localhost:3000 | Cidadão (agendar, remarcar, cancelar, fila de espera) |
| http://localhost:3000/painel | Equipe da UBS / Secretaria (senha de demonstração: `ubs123`) |

---

## 3. Pacientes de demonstração

Todos os dados são fictícios. No **Painel da demonstração** (ao lado do celular), abra
**"Pacientes fictícios para entrar"** e clique em um nome para preencher o formulário automaticamente.

| Paciente | CPF | Nascimento |
|---|---|---|
| Maria das Gracas Souza (idosa) | 123.456.789-09 | 15/03/1948 |
| Joao Pereira Lima | 987.654.321-00 | 02/09/1985 |
| Ana Clara Rocha | 111.222.333-96 | 20/11/1992 |
| Jose Carlos Nunes (idoso) | 444.555.666-19 | 07/07/1955 |

No modo demonstração, o **código do SMS aparece no Painel da demonstração** ("Código de teste do SMS"),
pois não há um provedor de SMS real conectado. No celular de verdade, ele aparece também na própria tela.

---

## 4. Usando o app do cidadão

### Como a tela é organizada
- **No computador**, o app aparece dentro de uma moldura de celular e o **Painel da demonstração** fica ao lado.
  **No celular**, o app ocupa a tela inteira e o painel fica embaixo.
- **Cabeçalho** (igual em todas as telas): botão **‹** para voltar, nome da tela e os botões **A−**, **A+**
  (tamanho do texto) e **◐** (alto contraste). As escolhas ficam lembradas no navegador.
- **Abas embaixo**: **Início**, **Agendar** e **Consultas**, com a aba atual destacada.

### Agendar em 5 passos (até 5 telas, como pede o RA01)
1. **Passo 1 de 5** — CPF e data de nascimento → **Receber código por SMS**. Não é pedido e-mail. Se algo estiver
   errado, o aviso aparece embaixo do campo, explicando o que corrigir.
2. **Passo 2 de 5** — código de 6 números → **Entrar**. **Reenviar código** fica disponível após 30 segundos.
3. **Passo 3 de 5** — "Qual consulta você precisa?": cada especialidade mostra **quantas vagas tem nesta semana**.
   Cardiologia aparece como **"Sem vagas: você pode entrar na fila"**.
4. **Passo 4 de 5** — numa tela só: **Unidade** (com o próximo horário de cada uma), **Dia** (botões como
   "Sex 20/11", com o número de vagas) e **Horário**. Horários ocupados aparecem **riscados, com "sem vaga"**,
   e não podem ser escolhidos. Se a unidade não tiver nenhum horário livre, aparece **Entrar na fila de espera**.
5. **Passo 5 de 5** — **Confira e confirme**: resumo da consulta → **Confirmar consulta**.

### Primeira vez: criar cadastro
Quem não está no cadastro da UBS (SIGA-Saúde) toca em **Criar meu cadastro**, na tela de entrada. O botão
aparece embaixo de "Primeira vez aqui?", e o aviso de "não encontramos cadastro" também aponta para ele.
- Pede só **nome completo, CPF, data de nascimento e celular com DDD**. Não há e-mail nem senha (RA01).
- É obrigatório marcar a **autorização de uso dos dados (LGPD)**; sem ela, o cadastro não é enviado.
- Cada campo é conferido antes do envio, com o erro explicado embaixo do campo.
- Depois vem o **código por SMS**, que confirma o celular, e a pessoa já entra e pode agendar.
- Se o CPF **já tem cadastro**, o app volta para "Entrar" com os dados preenchidos.
- É um **pré-cadastro**: na **Agenda da recepção** do painel da equipe, o nome aparece com o aviso
  *"Pré-cadastro pelo app: conferir documento e Cartão SUS"*.
- Na demonstração, o botão **"Preencher um cadastro novo (fictício)"** do painel lateral preenche tudo com
  um CPF válido inventado; falta só marcar a autorização.

### Início
"Olá, Maria! O que você precisa hoje?", o cartão **Sua próxima consulta** e os botões **Agendar consulta** e
**Ver, remarcar ou cancelar**. Se abrir uma vaga da fila de espera, aparece um cartão **"Abriu uma vaga"**.
Embaixo ficam **Precisa de ajuda?** e o link **Sair**.

### Consultas
- Cada consulta mostra a especialidade, uma etiqueta (**Marcada**, **Presença confirmada**, **Cancelada**), a UBS e
  a data ("Amanhã 20/11 às 07:30").
- Nas 24 horas antes da consulta aparece **"Lembrete: sua consulta é em breve."** e o botão **Vou comparecer** (RF03).
- **Remarcar** volta ao passo 4; a consulta antiga só é trocada quando o novo horário é confirmado.
- **Cancelar** abre uma janela de confirmação (o foco começa em **Manter consulta**; Esc fecha sem cancelar).
  A vaga volta para a agenda e é oferecida ao primeiro da fila de espera.
- **Fila de espera** mostra a posição de cada fila, com **Ver horários** e **Sair da fila**.

---

## 5. Usando o painel da UBS

Acesse http://localhost:3000/painel e entre com a senha `ubs123`. O painel atualiza sozinho a cada
3 segundos (a hora da última atualização aparece ao lado do título). Os links no topo levam direto a cada seção.

| Seção | O que mostra / faz |
|---|---|
| **Visão geral** | % de agendamentos concluídos, consultas confirmadas, **reservas duplicadas (sempre 0)**, SMS enviados/falhos, tempo de resposta p95 e alertas |
| **Unidades no Consulta Fácil** | Liga/desliga cada unidade (feature flag). O piloto começa com 3 UBS ativas. Desligar pede confirmação e esconde a UBS do cidadão sem apagar agendas |
| **Envio de SMS** | Situação do envio (*circuit breaker*) em linguagem simples e o seletor **Simular provedor de SMS** (Funcionando / Fora do ar / Lento) |
| **Últimos SMS entregues** | Caixa de SMS simulada (só no modo demonstração) |
| **SMS que não chegaram** | Mensagens que falharam após 5 tentativas — a recepção liga para o paciente e clica **Já liguei** |
| **Alertas para a UBS** | Pacientes com 3 cancelamentos tardios em 30 dias |
| **Agenda da recepção** | Consultas marcadas pelo app em cada UBS (CPF mascarado) |
| **Migração do SIGA-Saúde** | **Fazer ensaio** (roda e desfaz, mostrando o relatório de conferência) e **Migrar de verdade** (pede confirmação; não duplica nem apaga dados) |

---

## 6. Roteiro de demonstração (as falhas do piloto)

Tudo é feito pelo **Painel da demonstração**, ao lado do celular. Ele **não faz parte do app**: só provoca,
sob comando, os problemas que derrubaram o piloto, para mostrar como o sistema reage.

### 6.1 A última vaga (duas pessoas, uma vaga)
1. Entre como **Maria** → **Agendar** → **Pediatria** → **UBS Centro** → escolha o horário livre.
2. No painel, marque **"Outra pessoa confirma a mesma vaga um instante antes de mim"**.
3. Toque em **Confirmar consulta**.
   Resultado: a outra pessoa fica com a vaga e Maria vê **"Esta vaga acabou"**, volta para a escolha de horário
   (agora "sem vaga") e recebe a opção **Entrar na fila de espera**. No painel da equipe, *Vagas com duas reservas*
   continua **0**. A caixa é desmarcada sozinha depois de usada.

### 6.2 Provedor de SMS fora do ar
1. No painel, marque **"Provedor de SMS fora do ar"**.
2. Agende ou cancele uma consulta: a ação é **concluída normalmente**.
3. Em **Fila de mensagens (outbox)** aparece, por exemplo:
   *"Cancelamento: Clínico Geral, sex., 20/11, 07:30 → falhou, na fila (tentativa 3 de 5, espera crescente…)"*.
   Depois de 5 tentativas, a mensagem vai para a lista **SMS que não chegaram** do painel da equipe.
4. Desmarque a caixa: as mensagens pendentes passam a ser entregues.

### 6.3 Clique duplo em "Cancelar"
1. Em **Consultas**, cancele uma consulta.
2. No painel, clique **Simular segundo clique em "Cancelar"**.
   Resultado: **"Esta consulta já foi cancelada. A vaga não foi liberada duas vezes."**, sem erro.

### 6.4 Fila de espera
1. Entre como **Maria**, escolha **Cardiologia** (sem vagas) → UBS Centro → **Entrar na fila de espera**.
2. Em **Consultas**, a fila mostra a posição ("1º na fila").
3. Com outro paciente, cancele uma consulta da mesma especialidade e UBS: Maria passa a ver **"Abriu uma vaga"**
   no Início, e o SMS aparece na fila de mensagens.

### 6.5 Idosa sem e-mail
Entre como **Maria (1948)**: todo o fluxo usa apenas CPF, data de nascimento e código por SMS.
Mostre também **A+** e **◐** (alto contraste) no cabeçalho.

### 6.6 Kill switch por UBS (painel da equipe)
No painel, clique **Desligar** na UBS Centro e confirme: ela some imediatamente da lista do cidadão.
Clique **Ativar** para voltar: nenhuma agenda foi perdida.

### 6.7 Heurísticas de Nielsen na prática
Digite um CPF errado (ex.: 123.456.789-00) e toque em **Receber código por SMS**: o erro aparece junto do campo,
em linguagem simples (heurísticas 5 e 9). Ao agendar, mostre o "Passo X de 5", o botão **‹** e as abas
(heurísticas 1, 3 e 4) e os horários "sem vaga" visíveis na mesma tela (heurística 6). Ao cancelar, mostre a
janela de confirmação (heurística 5).

---

## 7. Testes automatizados

```powershell
npm test
```

São 16 testes de aceitação. O principal é o da cadeia de rastreabilidade: **100 pedidos simultâneos
para 1 vaga → 1 confirmação, 99 recusas, 0 duplicados**. Também testam: login sem e-mail, duplo
clique, cancelamento repetido, remarcação, SMS fora do ar com *circuit breaker*, migração
idempotente, proteção do painel e isolamento entre pacientes.

Os testes usam um banco em memória: não alteram os dados da pasta `data`.

---

## 8. Configurações (opcional)

Variáveis de ambiente, definidas antes do `npm start` no PowerShell:

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3000` | Porta do servidor |
| `DEMO` | ligado | `0` desliga o modo demonstração (não mostra o código SMS nem a lista de pacientes) |
| `PAINEL_SENHA` | `ubs123` | Senha do painel — **troque fora da demonstração** |
| `BACKOFF_UNIT_MS` | `1000` | Unidade da espera entre tentativas de SMS (produção: `60000` = 1, 2, 4, 8, 16 min) |
| `CIRCUIT_OPEN_MS` | `60000` | Tempo que o *circuit breaker* fica aberto |
| `DB_PATH` | `data/consulta-facil.db` | Arquivo do banco |

Exemplo:

```powershell
$env:PORT = "8080"; $env:PAINEL_SENHA = "outra-senha"; npm start
```

---

## 9. Problemas comuns

| Sintoma | Solução |
|---|---|
| `'node' não é reconhecido` | Instale o Node.js LTS e abra um novo terminal |
| `No such built-in module: node:sqlite` | Node.js antigo — atualize para 22.5+ |
| `EADDRINUSE: address already in use :::3000` | Já há um servidor rodando. Feche o outro terminal ou use `$env:PORT = "3001"; npm start` |
| Não aparece nenhum horário | Os horários são gerados para os **próximos 5 dias úteis** a partir da criação do banco. Apague a pasta `data` e rode `npm start` de novo |
| Quero recomeçar a demonstração do zero | Pare o servidor (Ctrl + C), apague a pasta `data` e rode `npm start` |
| Painel pede senha de novo | A sessão expira em 8 horas; entre novamente |

---

## 10. Estrutura do projeto

```
consulta-facil/
├── src/
│   ├── server.js              # inicia o servidor
│   ├── app.js                 # rotas HTTP, segurança, montagem dos módulos
│   ├── config.js              # parâmetros (prazos, tentativas, timeouts)
│   ├── db.js                  # esquema do banco SQLite
│   └── modules/
│       ├── agenda.js          # agendar, cancelar, remarcar, fila (uma vaga, uma confirmação)
│       ├── pacientes.js       # login sem e-mail, sessões, LGPD, auditoria
│       ├── notificacoes.js    # outbox, retentativas, circuit breaker, lembretes
│       ├── sms-provider.js    # provedor de SMS simulado
│       ├── siga-adapter.js    # Adapter para o SIGA-Saúde (legado simulado)
│       ├── migracao.js        # migração com ensaio e reconciliação
│       └── painel.js          # métricas e funções da equipe
├── public/                    # telas do cidadão (index) e do painel
├── test/                      # testes de aceitação
├── data/                      # banco local (criado automaticamente)
├── README.md                  # decisões do documento ↔ código
└── COMO-USAR.md               # este guia
```

---

## 11. Limitações do protótipo

- O **SIGA-Saúde é simulado** (o legado real não tem API); trocar pelo banco real afeta só o `SigaSaudeAdapter`.
- O **SMS já tem envio real pronto (Twilio)**, mas vem desligado: sem credenciais, o app usa o modo simulado.
  Veja a seção 12.
- **Vercel:** o banco é temporário (veja o README). **Docker:** o banco é permanente (seção 13).
- Pipeline de CI/CD, backup PITR e testes de carga com 4 mil usuários (questões 5 e 6) estão descritos
  no documento, mas não fazem parte deste protótipo.

---

## 12. Ligar o SMS de verdade (Twilio)

O código de envio real já está pronto e testado (`src/modules/sms-provider.js`). Só faltam as suas credenciais.
O Twilio dá um crédito de teste ao criar a conta; na conta de teste, ele só envia para **números verificados**.

### O que você precisa fazer (uma vez)
1. Crie a conta em https://www.twilio.com/try-twilio e confirme seu e-mail e seu celular.
2. No Console do Twilio, copie o **Account SID** e o **Auth Token** (ficam na página inicial).
3. **Para SMS:** em *Phone Numbers → Buy a number*, pegue o número gratuito da conta de teste (formato `+1...`).
   Em *Verified Caller IDs*, cadastre os celulares que vão receber os SMS (o seu e o do grupo).
4. **Para WhatsApp (opcional, no lugar do SMS):** em *Messaging → Try it out → Send a WhatsApp message*,
   envie do seu WhatsApp a mensagem `join <código>` para o número do sandbox (+1 415 523 8886).

### Rodando localmente ou no Docker
Copie `.env.example` para `.env` e preencha:
```
SMS_PROVEDOR=twilio
SMS_CANAL=sms            # ou whatsapp
TWILIO_ACCOUNT_SID=ACxxxxxxxx...
TWILIO_AUTH_TOKEN=xxxxxxxx...
TWILIO_FROM=+1XXXXXXXXXX # para WhatsApp: whatsapp:+14155238886
```
Depois, `docker compose up -d --build`. Para rodar sem Docker, use `node --env-file=.env --no-warnings src/server.js`.

### Na Vercel
Rode na pasta do projeto. Cada comando pede o valor: cole quando pedir, e ele não aparece na tela.
```powershell
npx vercel env add SMS_PROVEDOR production       # digite: twilio
npx vercel env add TWILIO_ACCOUNT_SID production
npx vercel env add TWILIO_AUTH_TOKEN production --sensitive
npx vercel env add TWILIO_FROM production
npx vercel deploy --prod
```

### Como conferir
- No **painel da equipe** (`/painel` → Envio de SMS) aparece `Provedor: Twilio — SMS real`. Se faltar alguma
  variável, aparece um aviso em vermelho dizendo qual, e o app continua no modo simulado.
- **Cadastre-se** no app com o seu celular verificado: o código chega por SMS.
- Os pacientes de demonstração têm celulares inventados. Na conta de teste, o Twilio recusa esses envios
  (erro 21608): eles vão direto para "SMS que não chegaram", **sem** derrubar o envio dos demais.
  O código continua aparecendo na tela enquanto `DEMO=1`.

---

## 13. Rodar com Docker (banco permanente)

Com o Docker Desktop aberto, na pasta do projeto:
```powershell
docker compose up -d --build     # sobe em http://localhost:3000 (painel em /painel)
docker compose logs -f           # ver o que está acontecendo (Ctrl + C para sair)
docker compose down              # parar (os dados continuam guardados)
docker compose down -v           # parar E apagar os dados (recomeça a demonstração)
```
- Os dados ficam no volume `dados` e sobrevivem a reinícios e atualizações.
- Porta ocupada? Use outra: `$env:PORTA = "3100"; docker compose up -d --build`.
- Testes dentro do container: `docker exec consulta-facil sh -c "node --test test/*.test.js"`.
