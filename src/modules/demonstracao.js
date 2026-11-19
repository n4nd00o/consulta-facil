// Painel da demonstração (só com DEMO ligado). NÃO faz parte do produto:
// reproduz, sob comando, os problemas do piloto para mostrar como o sistema reage.
import { randomUUID } from 'node:crypto';
import { gerarCpf } from './siga-adapter.js';
import { agendar } from './agenda.js';

/** "Outra pessoa confirma a mesma vaga um instante antes de mim": um paciente fictício reserva a vaga. */
export function outraPessoaReserva(db, vagaId) {
  const n = Number(db.prepare("SELECT COUNT(*) AS n FROM pacientes WHERE nome LIKE 'Outra pessoa%'").get().n) + 1;
  const r = db.prepare('INSERT INTO pacientes (cpf, nascimento, nome, telefone) VALUES (?, ?, ?, ?)')
    .run(gerarCpf(String(800000000 + n)), '1990-01-01', `Outra pessoa ${n} (demonstração)`, '11900000000');
  return agendar(db, Number(r.lastInsertRowid), Number(vagaId), randomUUID());
}

const TIPOS = { confirmacao: 'Confirmação', lembrete: 'Lembrete', cancelamento: 'Cancelamento', vaga_fila: 'Vaga da fila' };

function situacao(m, maxTentativas) {
  if (m.status === 'enviada') return 'entregue';
  if (m.status === 'contatado') return 'não chegou; a UBS já ligou para o paciente';
  if (m.status === 'falhou') return `falhou ${m.tentativas} vezes; foi para a lista da UBS ligar`;
  if (m.tentativas === 0) return 'na fila para envio';
  const espera = Math.max(0, Math.round((new Date(m.proxima_tentativa) - Date.now()) / 1000));
  return `falhou, na fila (tentativa ${m.tentativas} de ${maxTentativas}, espera crescente: nova tentativa em ${espera} s)`;
}

/** Últimas mensagens do paciente da sessão (outbox), em linguagem simples. */
export function filaDeMensagens(db, pacienteId, cfg) {
  if (!pacienteId) return [];
  return db.prepare(`SELECT id, tipo, resumo, status, tentativas, proxima_tentativa FROM outbox
                     WHERE paciente_id = ? ORDER BY id DESC LIMIT 6`).all(pacienteId)
    .map((m) => ({ id: m.id, texto: m.resumo ?? TIPOS[m.tipo] ?? m.tipo, status: m.status, situacao: situacao(m, cfg.smsMaxTentativas) }));
}
