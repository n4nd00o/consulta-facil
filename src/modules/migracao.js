// Migração das agendas do SIGA-Saúde (questão 2): preparar → ensaiar → validar → transicionar.
// - Idempotente: usa o código do legado como chave; rodar duas vezes não duplica nada.
// - Ensaio (dryRun): executa tudo numa transação e desfaz no final, devolvendo o relatório.
// - Reconciliação: compara contagens do legado com as do novo banco.
// - Nunca apaga: horários que sumiram do legado não são removidos, só reportados.
import { transacao } from '../db.js';

class Ensaio extends Error {}

export function migrarDoLegado(db, adapter, { dryRun = false, ubsPiloto = [] } = {}) {
  const unidades = adapter.listarUnidades();
  const profissionais = adapter.listarProfissionais();
  const agenda = adapter.consultarAgenda();
  const rel = {
    modo: dryRun ? 'ensaio' : 'efetivo',
    lidos: { unidades: unidades.length, profissionais: profissionais.length, horarios: agenda.length, horariosLivres: agenda.filter((a) => a.livre).length },
    inseridos: { unidades: 0, profissionais: 0, vagas: 0 },
    jaExistentes: 0,
    divergencias: [],
    reconciliacao: null,
  };

  const executar = () => {
    const insUbs = db.prepare('INSERT OR IGNORE INTO ubs (id, nome, bairro, ativa) VALUES (?, ?, ?, ?)');
    for (const u of unidades) {
      const ativa = ubsPiloto.includes(Number(u.codigo)) ? 1 : 0;
      rel.inseridos.unidades += Number(insUbs.run(Number(u.codigo), u.nome, u.bairro, ativa).changes);
    }

    const insProf = db.prepare('INSERT OR IGNORE INTO profissionais (nome, especialidade, ubs_id, codigo_legado) VALUES (?, ?, ?, ?)');
    for (const p of profissionais) {
      rel.inseridos.profissionais += Number(insProf.run(p.nome, p.especialidade, Number(p.codigoUbs), p.codigo).changes);
    }

    const idProf = db.prepare('SELECT id FROM profissionais WHERE codigo_legado = ?');
    const existe = db.prepare('SELECT disponiveis FROM vagas WHERE codigo_legado = ?');
    const insVaga = db.prepare('INSERT OR IGNORE INTO vagas (profissional_id, inicio, disponiveis, codigo_legado) VALUES (?, ?, ?, ?)');
    for (const h of agenda) {
      const prof = idProf.get(h.codigoProfissional);
      if (!prof) {
        rel.divergencias.push(`Horário ${h.codigo}: profissional ${h.codigoProfissional} inexistente`);
        continue;
      }
      const atual = existe.get(h.codigo);
      if (atual) {
        rel.jaExistentes += 1;
        continue;
      }
      const r = insVaga.run(prof.id, h.inicio, h.livre ? 1 : 0, h.codigo);
      if (Number(r.changes)) rel.inseridos.vagas += 1; else rel.jaExistentes += 1;
    }

    const novo = db.prepare('SELECT COUNT(*) AS n FROM vagas WHERE codigo_legado IS NOT NULL').get().n;
    rel.reconciliacao = {
      horariosNoLegado: agenda.length,
      horariosNoNovo: Number(novo),
      ok: Number(novo) >= agenda.length - rel.divergencias.length,
    };
    if (dryRun) throw new Ensaio();
  };

  try {
    transacao(db, executar);
  } catch (e) {
    if (!(e instanceof Ensaio)) throw e;
  }
  return rel;
}
