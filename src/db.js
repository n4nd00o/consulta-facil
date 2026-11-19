import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ubs (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  bairro TEXT NOT NULL,
  ativa INTEGER NOT NULL DEFAULT 0          -- feature flag por unidade (kill switch)
);

CREATE TABLE IF NOT EXISTS profissionais (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  especialidade TEXT NOT NULL,
  ubs_id INTEGER NOT NULL REFERENCES ubs(id),
  codigo_legado TEXT UNIQUE
);

-- Cada horário de cada profissional é um registro próprio (ADR-001)
CREATE TABLE IF NOT EXISTS vagas (
  id INTEGER PRIMARY KEY,
  profissional_id INTEGER NOT NULL REFERENCES profissionais(id),
  inicio TEXT NOT NULL,
  disponiveis INTEGER NOT NULL DEFAULT 1 CHECK (disponiveis >= 0),
  status TEXT NOT NULL DEFAULT 'ativa',     -- soft delete: 'ativa' | 'suspensa'
  codigo_legado TEXT UNIQUE,
  UNIQUE (profissional_id, inicio)
);

-- Minimização de dados (LGPD): sem e-mail, sem prontuário
CREATE TABLE IF NOT EXISTS pacientes (
  id INTEGER PRIMARY KEY,
  cpf TEXT NOT NULL UNIQUE,
  nascimento TEXT NOT NULL,
  nome TEXT NOT NULL,
  telefone TEXT NOT NULL,
  origem TEXT NOT NULL DEFAULT 'siga'       -- siga (cadastro da UBS) | app (pré-cadastro a conferir)
);

CREATE TABLE IF NOT EXISTS consultas (
  id INTEGER PRIMARY KEY,
  vaga_id INTEGER NOT NULL REFERENCES vagas(id),
  paciente_id INTEGER NOT NULL REFERENCES pacientes(id),
  status TEXT NOT NULL,                     -- confirmada | cancelada | remarcada
  presenca_confirmada INTEGER NOT NULL DEFAULT 0,
  lembrete_enviado INTEGER NOT NULL DEFAULT 0,
  cancelamento_tardio INTEGER NOT NULL DEFAULT 0,
  chave_idempotencia TEXT UNIQUE,
  criada_em TEXT NOT NULL,
  cancelada_em TEXT
);
-- Última barreira: no máximo UMA consulta ativa por vaga, mesmo que o código erre
CREATE UNIQUE INDEX IF NOT EXISTS ux_consulta_ativa_por_vaga
  ON consultas(vaga_id) WHERE status = 'confirmada';

CREATE TABLE IF NOT EXISTS fila_espera (
  id INTEGER PRIMARY KEY,
  paciente_id INTEGER NOT NULL REFERENCES pacientes(id),
  especialidade TEXT NOT NULL,
  ubs_id INTEGER NOT NULL REFERENCES ubs(id),
  status TEXT NOT NULL DEFAULT 'aguardando', -- aguardando | avisado | saiu
  criada_em TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fila_ativa
  ON fila_espera(paciente_id, especialidade, ubs_id) WHERE status = 'aguardando';

-- Padrão outbox: evento gravado na mesma transação do agendamento
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL,
  paciente_id INTEGER REFERENCES pacientes(id),
  telefone TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',  -- pendente | enviada | falhou | contatado
  tentativas INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa TEXT NOT NULL,
  ultimo_erro TEXT,
  criada_em TEXT NOT NULL,
  enviada_em TEXT,
  resumo TEXT
);

CREATE TABLE IF NOT EXISTS otp (
  cpf TEXT PRIMARY KEY,
  codigo TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  tentativas INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  paciente_id INTEGER,
  perfil TEXT NOT NULL,                     -- cidadao | ubs
  expira_em TEXT NOT NULL
);

-- Métrica de jornada: % de agendamentos concluídos
CREATE TABLE IF NOT EXISTS tentativas_agendamento (
  id INTEGER PRIMARY KEY,
  resultado TEXT NOT NULL,                  -- concluido | vaga_esgotada | erro
  criada_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY,
  ubs_id INTEGER,
  paciente_id INTEGER,
  mensagem TEXT NOT NULL,
  resolvido INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL
);

-- Trilha de auditoria (LGPD)
CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY,
  ator TEXT NOT NULL,
  acao TEXT NOT NULL,
  alvo TEXT,
  criada_em TEXT NOT NULL
);
`;

export function abrirBanco(caminho) {
  if (caminho !== ':memory:') mkdirSync(dirname(caminho), { recursive: true });
  const db = new DatabaseSync(caminho);
  db.exec(SCHEMA);
  // Bancos criados antes destas colunas: acrescenta sem apagar nada
  try { db.exec('ALTER TABLE outbox ADD COLUMN resumo TEXT'); } catch { /* coluna já existe */ }
  try { db.exec("ALTER TABLE pacientes ADD COLUMN origem TEXT NOT NULL DEFAULT 'siga'"); } catch { /* coluna já existe */ }
  return db;
}

/** Executa fn dentro de uma transação; desfaz tudo em caso de erro. */
export function transacao(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const agora = () => new Date().toISOString();
