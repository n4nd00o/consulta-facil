// Painel da equipe da UBS / Secretaria: observabilidade de NEGÓCIO (não só "servidor saudável"),
// lista de SMS que falharam para a UBS ligar, alertas, feature flag por unidade (kill switch),
// agenda do dia para a recepção e migração do legado com ensaio.
import { agora } from '../db.js';
import { mascararCpf } from './pacientes.js';

/** Latência das requisições (p95) — evidência do RNF01. */
export class MedidorLatencia {
  constructor(tamanho = 2000) {
    this.amostras = [];
    this.tamanho = tamanho;
    this.erros5xx = 0;
    this.total = 0;
  }

  registrar(ms, status) {
    this.total += 1;
    if (status >= 500) this.erros5xx += 1;
    this.amostras.push(ms);
    if (this.amostras.length > this.tamanho) this.amostras.shift();
  }

  p95() {
    if (this.amostras.length === 0) return 0;
    const ord = [...this.amostras].sort((a, b) => a - b);
    return Math.round(ord[Math.min(ord.length - 1, Math.floor(ord.length * 0.95))] * 10) / 10;
  }
}

export function resumo(db, { medidor, worker }) {
  const t = Object.fromEntries(db.prepare('SELECT resultado, COUNT(*) AS n FROM tentativas_agendamento GROUP BY resultado').all().map((r) => [r.resultado, Number(r.n)]));
  const total = (t.concluido ?? 0) + (t.vaga_esgotada ?? 0) + (t.erro ?? 0);
  const out = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status').all().map((r) => [r.status, Number(r.n)]));
  const consultas = db.prepare(`SELECT
      SUM(status = 'confirmada') AS confirmadas, SUM(status = 'cancelada') AS canceladas,
      SUM(cancelamento_tardio) AS tardios, SUM(status = 'confirmada' AND presenca_confirmada = 1) AS presencas
    FROM consultas`).get();
  const duplicadas = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT vaga_id FROM consultas WHERE status = 'confirmada' GROUP BY vaga_id HAVING COUNT(*) > 1)`).get().n;
  const negativas = db.prepare('SELECT COUNT(*) AS n FROM vagas WHERE disponiveis < 0').get().n;
  return {
    jornada: {
      tentativas: total,
      concluidos: t.concluido ?? 0,
      vagaEsgotada: t.vaga_esgotada ?? 0,
      erros: t.erro ?? 0,
      percentualConcluidos: total ? Math.round(((t.concluido ?? 0) / total) * 1000) / 10 : null,
    },
    consultas: {
      confirmadas: Number(consultas.confirmadas ?? 0),
      canceladas: Number(consultas.canceladas ?? 0),
      cancelamentosTardios: Number(consultas.tardios ?? 0),
      presencasConfirmadas: Number(consultas.presencas ?? 0),
    },
    integridade: { vagasComReservaDuplicada: Number(duplicadas), vagasNegativas: Number(negativas) },
    notificacoes: {
      pendentes: out.pendente ?? 0, enviadas: out.enviada ?? 0, falharam: out.falhou ?? 0, contatados: out.contatado ?? 0,
      circuito: worker.circuito.snapshot(), modoProvedor: worker.provedor.modo,
    },
    desempenho: { p95ms: medidor.p95(), requisicoes: medidor.total, erros5xx: medidor.erros5xx },
    alertasAbertos: Number(db.prepare('SELECT COUNT(*) AS n FROM alertas WHERE resolvido = 0').get().n),
    geradoEm: agora(),
  };
}

export function smsComFalha(db) {
  return db.prepare(`SELECT o.id, o.tipo, o.telefone, o.mensagem, o.tentativas, o.ultimo_erro, o.criada_em, p.nome
                     FROM outbox o LEFT JOIN pacientes p ON p.id = o.paciente_id
                     WHERE o.status = 'falhou' ORDER BY o.id DESC LIMIT 100`).all();
}

export function marcarContatado(db, id) {
  db.prepare("UPDATE outbox SET status = 'contatado' WHERE id = ? AND status = 'falhou'").run(Number(id));
}

export function reenviarFalhas(db) {
  const r = db.prepare("UPDATE outbox SET status = 'pendente', tentativas = 0, proxima_tentativa = ? WHERE status = 'falhou'").run(agora());
  return Number(r.changes);
}

export function listarAlertas(db) {
  return db.prepare(`SELECT a.id, a.mensagem, a.criado_em, u.nome AS ubs, p.nome AS paciente, p.telefone
                     FROM alertas a LEFT JOIN ubs u ON u.id = a.ubs_id LEFT JOIN pacientes p ON p.id = a.paciente_id
                     WHERE a.resolvido = 0 ORDER BY a.id DESC`).all();
}

export function resolverAlerta(db, id) {
  db.prepare('UPDATE alertas SET resolvido = 1 WHERE id = ?').run(Number(id));
}

export function listarUnidades(db) {
  return db.prepare(`SELECT u.id, u.nome, u.bairro, u.ativa,
      (SELECT COUNT(*) FROM vagas v JOIN profissionais p ON p.id = v.profissional_id WHERE p.ubs_id = u.id AND v.disponiveis > 0 AND v.inicio > ?) AS vagas_livres
    FROM ubs u ORDER BY u.id`).all(agora());
}

export function definirFlag(db, ubsId, ativa) {
  db.prepare('UPDATE ubs SET ativa = ? WHERE id = ?').run(ativa ? 1 : 0, Number(ubsId));
}

/** Agenda para a recepção: CPF mascarado (minimização), nome e telefone para contato. */
export function agendaDaUbs(db, ubsId) {
  return db.prepare(`SELECT c.id, v.inicio, pr.nome AS profissional, pr.especialidade, p.nome AS paciente, p.cpf, p.telefone,
                       p.origem, c.presenca_confirmada
                     FROM consultas c JOIN vagas v ON v.id = c.vaga_id JOIN profissionais pr ON pr.id = v.profissional_id
                     JOIN pacientes p ON p.id = c.paciente_id
                     WHERE pr.ubs_id = ? AND c.status = 'confirmada' AND v.inicio > ? ORDER BY v.inicio LIMIT 200`)
    .all(Number(ubsId), new Date(Date.now() - 12 * 3600_000).toISOString())
    .map((r) => ({ ...r, cpf: mascararCpf(r.cpf) }));
}
