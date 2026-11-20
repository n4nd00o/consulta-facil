// Módulo Notificações (questão 4). O envio é SEPARADO do agendamento:
//  1. o agendamento grava um evento na tabela outbox na mesma transação;
//  2. este worker lê a outbox e chama o provedor com:
//     - timeout por chamada,
//     - retentativa com limite e espera crescente (1, 2, 4, 8, 16 unidades),
//     - circuit breaker (abre após N falhas seguidas, testa com 1 chamada de prova),
//     - lista de falhas para a UBS ligar ao paciente.
// Em nenhum caso a falha do SMS desfaz o agendamento.
import { agora } from '../db.js';

export function enfileirar(db, { tipo, pacienteId, telefone, mensagem, resumo = null }) {
  const t = agora();
  db.prepare(`INSERT INTO outbox (tipo, paciente_id, telefone, mensagem, proxima_tentativa, criada_em, resumo)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(tipo, pacienteId ?? null, telefone, mensagem, t, t, resumo);
}

export class CircuitBreaker {
  constructor({ falhasParaAbrir, abertoMs, relogio = Date.now }) {
    this.falhasParaAbrir = falhasParaAbrir;
    this.abertoMs = abertoMs;
    this.relogio = relogio;
    this.estado = 'fechado';
    this.falhasSeguidas = 0;
    this.abertoAte = 0;
  }

  /** Pode chamar o provedor agora? Em meio-aberto, libera apenas a chamada de prova. */
  permite() {
    if (this.estado === 'fechado') return true;
    if (this.estado === 'aberto' && this.relogio() >= this.abertoAte) {
      this.estado = 'meio-aberto';
      return true;
    }
    return false;
  }

  sucesso() {
    this.estado = 'fechado';
    this.falhasSeguidas = 0;
  }

  falha() {
    this.falhasSeguidas += 1;
    if (this.estado === 'meio-aberto' || this.falhasSeguidas >= this.falhasParaAbrir) {
      this.estado = 'aberto';
      this.abertoAte = this.relogio() + this.abertoMs;
    }
  }

  snapshot() {
    return { estado: this.estado, falhasSeguidas: this.falhasSeguidas, abertoAte: this.abertoAte ? new Date(this.abertoAte).toISOString() : null };
  }
}

export function comTimeout(promessa, ms) {
  let timer;
  const limite = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`Timeout de ${ms} ms no provedor`)), ms);
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

export class WorkerNotificacoes {
  constructor(db, provedor, cfg) {
    this.db = db;
    this.provedor = provedor;
    this.cfg = cfg;
    this.circuito = new CircuitBreaker({ falhasParaAbrir: cfg.circuitoFalhasParaAbrir, abertoMs: cfg.circuitoAbertoMs });
    this.rodando = false;
    this.timer = null;
  }

  iniciar() {
    this.timer = setInterval(() => this.ciclo().catch((e) => console.error('[notificacoes] erro no ciclo:', e)), this.cfg.workerIntervaloMs);
    this.timer.unref();
  }

  parar() {
    clearInterval(this.timer);
  }

  async ciclo() {
    if (this.rodando) return; // evita execuções sobrepostas
    this.rodando = true;
    try {
      this.gerarLembretes();
      await this.processarOutbox();
    } finally {
      this.rodando = false;
    }
  }

  /** RF03: lembrete 24 h antes, uma única vez por consulta. */
  gerarLembretes() {
    const limite = new Date(Date.now() + this.cfg.lembreteHorasAntes * 3600_000).toISOString();
    const pendentes = this.db.prepare(`
      SELECT c.id, p.id AS paciente_id, p.telefone, v.inicio, pr.especialidade, u.nome AS ubs
      FROM consultas c JOIN vagas v ON v.id = c.vaga_id JOIN pacientes p ON p.id = c.paciente_id
      JOIN profissionais pr ON pr.id = v.profissional_id JOIN ubs u ON u.id = pr.ubs_id
      WHERE c.status = 'confirmada' AND c.lembrete_enviado = 0 AND v.inicio > ? AND v.inicio <= ?`).all(agora(), limite);
    const marcar = this.db.prepare('UPDATE consultas SET lembrete_enviado = 1 WHERE id = ? AND lembrete_enviado = 0');
    for (const c of pendentes) {
      if (Number(marcar.run(c.id).changes) === 0) continue;
      enfileirar(this.db, {
        tipo: 'lembrete', pacienteId: c.paciente_id, telefone: c.telefone, resumo: `Lembrete: ${c.especialidade}, ${fmt(c.inicio)}`,
        mensagem: `Consulta Fácil: lembrete da sua consulta de ${c.especialidade} em ${fmt(c.inicio)} na ${c.ubs}. Responda pelo app para confirmar presença.`,
      });
    }
  }

  async processarOutbox() {
    const lote = this.db.prepare(`SELECT * FROM outbox WHERE status = 'pendente' AND proxima_tentativa <= ?
                                  ORDER BY proxima_tentativa LIMIT 20`).all(agora());
    for (const msg of lote) {
      if (!this.circuito.permite()) return; // circuito aberto: não insiste com o provedor
      const emProva = this.circuito.estado === 'meio-aberto';
      try {
        await comTimeout(this.provedor.enviar(msg.telefone, msg.mensagem), this.cfg.smsTimeoutMs);
        this.circuito.sucesso();
        this.db.prepare(`UPDATE outbox SET status = 'enviada', tentativas = tentativas + 1, enviada_em = ?, ultimo_erro = NULL WHERE id = ?`)
          .run(agora(), msg.id);
      } catch (e) {
        // Erro permanente (ex.: número inválido) = o provedor respondeu: não conta para o circuit breaker
        if (e.permanente) this.circuito.sucesso(); else this.circuito.falha();
        this.registrarFalha(msg, e.message, e.permanente);
      }
      if (emProva) return; // meio-aberto: só uma chamada de prova por ciclo
    }
  }

  registrarFalha(msg, erro, permanente = false) {
    const tentativas = msg.tentativas + 1;
    if (permanente || tentativas >= this.cfg.smsMaxTentativas) {
      this.db.prepare(`UPDATE outbox SET status = 'falhou', tentativas = ?, ultimo_erro = ? WHERE id = ?`).run(tentativas, erro, msg.id);
      return;
    }
    const espera = this.cfg.backoffUnidadeMs * 2 ** (tentativas - 1);
    this.db.prepare(`UPDATE outbox SET tentativas = ?, ultimo_erro = ?, proxima_tentativa = ? WHERE id = ?`)
      .run(tentativas, erro, new Date(Date.now() + espera).toISOString(), msg.id);
  }

  /** Envio imediato (código de acesso). Respeita o circuito e o timeout; nunca retenta sozinho. */
  async enviarAgora(telefone, mensagem) {
    if (!this.circuito.permite()) return { enviado: false, motivo: 'circuito_aberto' };
    try {
      await comTimeout(this.provedor.enviar(telefone, mensagem), this.cfg.smsTimeoutMs);
      this.circuito.sucesso();
      return { enviado: true };
    } catch (e) {
      if (e.permanente) this.circuito.sucesso(); else this.circuito.falha();
      console.warn('[sms] código não enviado:', e.message);
      return { enviado: false, motivo: e.message };
    }
  }
}

// Texto dos SMS sempre no horário de Brasília, mesmo com o servidor em UTC (Vercel).
export const fmt = (iso) =>
  new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
