// Módulo Agenda: agendar (RF01), cancelar e remarcar (RF02), confirmar presença (RF03),
// fila de espera. Regra central: UMA VAGA, UMA CONFIRMAÇÃO.
//  - UPDATE vagas SET disponiveis = disponiveis - 1 WHERE id = ? AND disponiveis > 0 (atômico)
//  - índice único parcial: no máximo uma consulta 'confirmada' por vaga (última barreira)
//  - chave de idempotência por clique: duplo clique/reenvio não gera duas reservas
import { agora, transacao } from '../db.js';
import { enfileirar, fmt, fmtCurto } from './notificacoes.js';
import { ErroNegocio, auditar } from './pacientes.js';

const SQL_VAGA = `
  SELECT v.id, v.inicio, v.disponiveis, pr.nome AS profissional, pr.especialidade, u.id AS ubs_id, u.nome AS ubs, u.ativa
  FROM vagas v JOIN profissionais pr ON pr.id = v.profissional_id JOIN ubs u ON u.id = pr.ubs_id`;

export function listarEspecialidades(db) {
  return db.prepare(`SELECT DISTINCT pr.especialidade FROM profissionais pr JOIN ubs u ON u.id = pr.ubs_id
                     WHERE u.ativa = 1 ORDER BY 1`).all().map((r) => r.especialidade);
}

/** Especialidades com o total de horários livres nos próximos 7 dias. */
export function especialidadesComVagas(db) {
  const ate = new Date(Date.now() + 7 * 86400_000).toISOString();
  return db.prepare(`
    SELECT pr.especialidade,
      SUM(CASE WHEN v.disponiveis > 0 AND v.status = 'ativa' AND v.inicio > ? AND v.inicio <= ? THEN 1 ELSE 0 END) AS vagas
    FROM profissionais pr JOIN ubs u ON u.id = pr.ubs_id AND u.ativa = 1
    LEFT JOIN vagas v ON v.profissional_id = pr.id
    GROUP BY pr.especialidade
    ORDER BY (vagas = 0), CASE pr.especialidade WHEN 'Clínico geral' THEN 1 WHEN 'Pediatria' THEN 2 WHEN 'Ginecologia' THEN 3 ELSE 4 END,
      pr.especialidade`).all(agora(), ate)
    .map((r) => ({ especialidade: r.especialidade, vagas: Number(r.vagas) }));
}

export function listarUbs(db, especialidade) {
  return db.prepare(`
    SELECT u.id, u.nome, u.bairro, COUNT(v.id) AS vagas, MIN(v.inicio) AS proxima
    FROM ubs u
    LEFT JOIN profissionais p ON p.ubs_id = u.id AND p.especialidade = ?
    LEFT JOIN vagas v ON v.profissional_id = p.id AND v.disponiveis > 0 AND v.status = 'ativa' AND v.inicio > ?
    WHERE u.ativa = 1 GROUP BY u.id ORDER BY (COUNT(v.id) = 0), MIN(v.inicio), u.nome`).all(especialidade, agora());
}

/** Horários livres; com `todos`, inclui também os ocupados (mostrados como "sem vaga"). */
export function listarHorarios(db, especialidade, ubsId, { todos = false } = {}) {
  return db.prepare(`${SQL_VAGA}
    WHERE pr.especialidade = ? AND u.id = ? AND u.ativa = 1 AND v.status = 'ativa' AND v.inicio > ?
      ${todos ? '' : 'AND v.disponiveis > 0'}
    ORDER BY v.inicio LIMIT 120`).all(especialidade, Number(ubsId), agora());
}

function registrarTentativa(db, resultado) {
  db.prepare('INSERT INTO tentativas_agendamento (resultado, criada_em) VALUES (?, ?)').run(resultado, agora());
}

function obterPaciente(db, id) {
  return db.prepare('SELECT id, nome, telefone FROM pacientes WHERE id = ?').get(id);
}

/** Reserva atômica: retorna true se ESTE chamador ficou com a vaga. */
function reservarVaga(db, vagaId) {
  const r = db.prepare(`UPDATE vagas SET disponiveis = disponiveis - 1
                        WHERE id = ? AND disponiveis > 0 AND status = 'ativa' AND inicio > ?`).run(vagaId, agora());
  return Number(r.changes) === 1;
}

function liberarVaga(db, vagaId) {
  db.prepare('UPDATE vagas SET disponiveis = disponiveis + 1 WHERE id = ?').run(vagaId);
  ofertarParaFila(db, vagaId);
}

/** A vaga liberada é oferecida ao primeiro da fila de espera daquela especialidade/UBS. */
function ofertarParaFila(db, vagaId) {
  const vaga = db.prepare(`${SQL_VAGA} WHERE v.id = ?`).get(vagaId);
  const primeiro = db.prepare(`SELECT f.id, p.id AS paciente_id, p.telefone FROM fila_espera f JOIN pacientes p ON p.id = f.paciente_id
                               WHERE f.especialidade = ? AND f.ubs_id = ? AND f.status = 'aguardando' ORDER BY f.id LIMIT 1`)
    .get(vaga.especialidade, vaga.ubs_id);
  if (!primeiro) return;
  db.prepare("UPDATE fila_espera SET status = 'avisado' WHERE id = ?").run(primeiro.id);
  enfileirar(db, {
    tipo: 'vaga_fila', pacienteId: primeiro.paciente_id, telefone: primeiro.telefone, resumo: `Vaga da fila: ${vaga.especialidade}, ${fmtCurto(vaga.inicio)}`,
    mensagem: `Consulta Fácil: abriu uma vaga de ${vaga.especialidade} em ${fmt(vaga.inicio)} na ${vaga.ubs}. Entre no app para agendar.`,
  });
}

function alternativas(db, vaga) {
  return listarHorarios(db, vaga.especialidade, vaga.ubs_id).slice(0, 3);
}

function consultaPorChave(db, chave) {
  if (!chave) return null;
  return db.prepare('SELECT * FROM consultas WHERE chave_idempotencia = ?').get(chave);
}

function validarChave(chave) {
  if (chave !== undefined && chave !== null && !/^[A-Za-z0-9-]{8,64}$/.test(String(chave))) {
    throw new ErroNegocio(400, 'Chave de requisição inválida.');
  }
}

export function agendar(db, pacienteId, vagaId, chave) {
  validarChave(chave);
  const anterior = consultaPorChave(db, chave);
  if (anterior) {
    if (anterior.paciente_id !== pacienteId) throw new ErroNegocio(409, 'Requisição repetida inválida.');
    return { ok: true, repetido: true, consulta: detalharConsulta(db, anterior.id) };
  }

  const vaga = db.prepare(`${SQL_VAGA} WHERE v.id = ?`).get(Number(vagaId));
  if (!vaga) throw new ErroNegocio(404, 'Horário não encontrado.');
  if (!vaga.ativa) throw new ErroNegocio(403, 'Esta UBS ainda não está usando o Consulta Fácil.');

  const jaTem = db.prepare(`SELECT c.id FROM consultas c JOIN vagas v ON v.id = c.vaga_id JOIN profissionais p ON p.id = v.profissional_id
                            WHERE c.paciente_id = ? AND c.status = 'confirmada' AND p.especialidade = ? AND v.inicio > ?`)
    .get(pacienteId, vaga.especialidade, agora());
  if (jaTem) throw new ErroNegocio(409, `Você já tem uma consulta de ${vaga.especialidade} marcada. Para trocar o horário, use "Remarcar".`);

  let resultado;
  try {
    resultado = transacao(db, () => {
      if (!reservarVaga(db, vaga.id)) return null;
      const ins = db.prepare(`INSERT INTO consultas (vaga_id, paciente_id, status, chave_idempotencia, criada_em)
                              VALUES (?, ?, 'confirmada', ?, ?)`).run(vaga.id, pacienteId, chave ?? null, agora());
      const paciente = obterPaciente(db, pacienteId);
      enfileirar(db, { // outbox: mesma transação do agendamento
        tipo: 'confirmacao', pacienteId, telefone: paciente.telefone, resumo: `Confirmação: ${vaga.especialidade}, ${fmtCurto(vaga.inicio)}`,
        mensagem: `Consulta Fácil: consulta de ${vaga.especialidade} confirmada para ${fmt(vaga.inicio)} na ${vaga.ubs} com ${vaga.profissional}.`,
      });
      db.prepare("UPDATE fila_espera SET status = 'saiu' WHERE paciente_id = ? AND especialidade = ? AND status IN ('aguardando','avisado')")
        .run(pacienteId, vaga.especialidade);
      return Number(ins.lastInsertRowid);
    });
  } catch (e) {
    registrarTentativa(db, 'erro');
    throw e;
  }

  if (resultado === null) {
    registrarTentativa(db, 'vaga_esgotada');
    return { ok: false, motivo: 'vaga_esgotada', mensagem: 'Esta vaga acabou. Veja outros horários ou entre na fila de espera.', alternativas: alternativas(db, vaga), especialidade: vaga.especialidade, ubsId: vaga.ubs_id };
  }
  registrarTentativa(db, 'concluido');
  auditar(db, `paciente:${pacienteId}`, 'agendou', `consulta:${resultado}`);
  return { ok: true, consulta: detalharConsulta(db, resultado) };
}

function consultaDoPaciente(db, pacienteId, consultaId) {
  const c = db.prepare(`SELECT c.*, v.inicio FROM consultas c JOIN vagas v ON v.id = c.vaga_id WHERE c.id = ? AND c.paciente_id = ?`)
    .get(Number(consultaId), pacienteId);
  if (!c) throw new ErroNegocio(404, 'Consulta não encontrada.');
  return c;
}

export function cancelar(db, cfg, pacienteId, consultaId) {
  const c = consultaDoPaciente(db, pacienteId, consultaId);
  if (c.status !== 'confirmada') return { ok: false, motivo: 'ja_cancelada', mensagem: 'Esta consulta já foi cancelada.' };
  if (c.inicio <= agora()) throw new ErroNegocio(409, 'Esta consulta já aconteceu e não pode ser cancelada.');

  const tardio = new Date(c.inicio) - Date.now() < cfg.cancelamentoTardioHoras * 3600_000;
  const mudou = transacao(db, () => {
    // Condicional: um segundo clique / outra aba não libera a vaga duas vezes
    const r = db.prepare(`UPDATE consultas SET status = 'cancelada', cancelada_em = ?, cancelamento_tardio = ?
                          WHERE id = ? AND status = 'confirmada'`).run(agora(), tardio ? 1 : 0, c.id);
    if (Number(r.changes) === 0) return false;
    liberarVaga(db, c.vaga_id);
    if (tardio) verificarCancelamentosTardios(db, cfg, pacienteId, c.vaga_id);
    const v = db.prepare(`${SQL_VAGA} WHERE v.id = ?`).get(c.vaga_id);
    const paciente = obterPaciente(db, pacienteId);
    enfileirar(db, { tipo: 'cancelamento', pacienteId, telefone: paciente.telefone, resumo: `Cancelamento: ${v.especialidade}, ${fmtCurto(v.inicio)}`,
      mensagem: `Consulta Fácil: sua consulta de ${v.especialidade} em ${fmt(v.inicio)} na ${v.ubs} foi cancelada.` });
    return true;
  });
  if (!mudou) return { ok: false, motivo: 'ja_cancelada', mensagem: 'Esta consulta já foi cancelada.' };
  auditar(db, `paciente:${pacienteId}`, tardio ? 'cancelou_tardio' : 'cancelou', `consulta:${c.id}`);
  return { ok: true, tardio, mensagem: tardio ? 'Consulta cancelada (cancelamento tardio registrado).' : 'Consulta cancelada. A vaga foi liberada para outra pessoa.' };
}

/** Não bloqueia o paciente (atendimento é direito): só avisa a UBS para entrar em contato. */
function verificarCancelamentosTardios(db, cfg, pacienteId, vagaId) {
  const desde = new Date(Date.now() - cfg.janelaCancelamentosDias * 86400_000).toISOString();
  const n = db.prepare(`SELECT COUNT(*) AS n FROM consultas WHERE paciente_id = ? AND cancelamento_tardio = 1 AND cancelada_em >= ?`)
    .get(pacienteId, desde).n;
  if (n < cfg.limiteCancelamentosTardios) return;
  const ubs = db.prepare(`SELECT pr.ubs_id FROM vagas v JOIN profissionais pr ON pr.id = v.profissional_id WHERE v.id = ?`).get(vagaId);
  db.prepare('INSERT INTO alertas (ubs_id, paciente_id, mensagem, criado_em) VALUES (?, ?, ?, ?)')
    .run(ubs.ubs_id, pacienteId, `Paciente com ${n} cancelamentos tardios em ${cfg.janelaCancelamentosDias} dias. Entrar em contato.`, agora());
}

/** A consulta original só é trocada quando a nova vaga é confirmada. */
export function remarcar(db, pacienteId, consultaId, novaVagaId, chave) {
  validarChave(chave);
  const anterior = consultaPorChave(db, chave);
  if (anterior && anterior.paciente_id === pacienteId) return { ok: true, repetido: true, consulta: detalharConsulta(db, anterior.id) };

  const c = consultaDoPaciente(db, pacienteId, consultaId);
  if (c.status !== 'confirmada') throw new ErroNegocio(409, 'Só é possível remarcar uma consulta confirmada.');
  const nova = db.prepare(`${SQL_VAGA} WHERE v.id = ?`).get(Number(novaVagaId));
  if (!nova || !nova.ativa) throw new ErroNegocio(404, 'Horário não encontrado.');

  const novoId = transacao(db, () => {
    if (!reservarVaga(db, nova.id)) return null; // nova vaga tomada por outra pessoa: nada muda
    const r = db.prepare(`UPDATE consultas SET status = 'remarcada', cancelada_em = ? WHERE id = ? AND status = 'confirmada'`).run(agora(), c.id);
    if (Number(r.changes) === 0) throw new ErroNegocio(409, 'A consulta original mudou. Atualize a página.');
    liberarVaga(db, c.vaga_id);
    const ins = db.prepare(`INSERT INTO consultas (vaga_id, paciente_id, status, chave_idempotencia, criada_em) VALUES (?, ?, 'confirmada', ?, ?)`)
      .run(nova.id, pacienteId, chave ?? null, agora());
    const paciente = obterPaciente(db, pacienteId);
    enfileirar(db, { tipo: 'confirmacao', pacienteId, telefone: paciente.telefone, resumo: `Remarcação: ${nova.especialidade}, ${fmtCurto(nova.inicio)}`,
      mensagem: `Consulta Fácil: consulta remarcada para ${fmt(nova.inicio)} na ${nova.ubs} com ${nova.profissional}.` });
    return Number(ins.lastInsertRowid);
  });

  if (novoId === null) {
    return { ok: false, motivo: 'vaga_esgotada', mensagem: 'O novo horário acabou de ser ocupado. Sua consulta original foi mantida.', alternativas: alternativas(db, nova) };
  }
  auditar(db, `paciente:${pacienteId}`, 'remarcou', `consulta:${c.id}->${novoId}`);
  return { ok: true, consulta: detalharConsulta(db, novoId) };
}

export function confirmarPresenca(db, pacienteId, consultaId) {
  const c = consultaDoPaciente(db, pacienteId, consultaId);
  if (c.status !== 'confirmada') throw new ErroNegocio(409, 'Esta consulta não está ativa.');
  db.prepare('UPDATE consultas SET presenca_confirmada = 1 WHERE id = ?').run(c.id);
  return { ok: true, mensagem: 'Presença confirmada. Obrigado!' };
}

export function detalharConsulta(db, id) {
  return db.prepare(`SELECT c.id, c.status, c.presenca_confirmada, c.cancelamento_tardio, v.id AS vaga_id, v.inicio,
                     pr.nome AS profissional, pr.especialidade, u.id AS ubs_id, u.nome AS ubs, u.bairro
                     FROM consultas c JOIN vagas v ON v.id = c.vaga_id JOIN profissionais pr ON pr.id = v.profissional_id
                     JOIN ubs u ON u.id = pr.ubs_id WHERE c.id = ?`).get(id);
}

export function minhasConsultas(db, pacienteId) {
  return db.prepare(`SELECT c.id FROM consultas c JOIN vagas v ON v.id = c.vaga_id
                     WHERE c.paciente_id = ? AND c.status != 'remarcada' ORDER BY (c.status = 'confirmada' AND v.inicio > ?) DESC, v.inicio`)
    .all(pacienteId, agora()).map((r) => detalharConsulta(db, r.id));
}

export function entrarNaFila(db, pacienteId, especialidade, ubsId) {
  const ubs = db.prepare('SELECT id, ativa FROM ubs WHERE id = ?').get(Number(ubsId));
  if (!ubs?.ativa) throw new ErroNegocio(404, 'UBS não encontrada.');
  if (!listarEspecialidades(db).includes(especialidade)) throw new ErroNegocio(400, 'Especialidade inválida.');
  db.prepare(`INSERT INTO fila_espera (paciente_id, especialidade, ubs_id, criada_em) VALUES (?, ?, ?, ?)
              ON CONFLICT DO NOTHING`).run(pacienteId, especialidade, ubs.id, agora());
  return minhasFilas(db, pacienteId).find((f) => f.especialidade === especialidade && f.ubs_id === ubs.id);
}

export function sairDaFila(db, pacienteId, filaId) {
  db.prepare("UPDATE fila_espera SET status = 'saiu' WHERE id = ? AND paciente_id = ?").run(Number(filaId), pacienteId);
  return { ok: true };
}

export function minhasFilas(db, pacienteId) {
  return db.prepare(`
    SELECT f.id, f.especialidade, f.ubs_id, u.nome AS ubs, f.status,
      (SELECT COUNT(*) FROM fila_espera g WHERE g.especialidade = f.especialidade AND g.ubs_id = f.ubs_id
         AND g.status = 'aguardando' AND g.id <= f.id) AS posicao
    FROM fila_espera f JOIN ubs u ON u.id = f.ubs_id
    WHERE f.paciente_id = ? AND f.status IN ('aguardando', 'avisado') ORDER BY f.id`).all(pacienteId);
}
