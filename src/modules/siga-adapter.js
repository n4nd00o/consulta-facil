// Módulo "Integração com o legado" — padrão Adapter (questão 4).
// O Consulta Fácil só conhece a interface abaixo; o SigaSaudeAdapter traduz
// as chamadas para o formato do banco único do SIGA-Saúde (sem API).
// Trocar o legado = trocar uma única classe. Nos testes usamos um legado simulado.

/**
 * Interface esperada pelo Consulta Fácil:
 *  listarUnidades()      -> [{ codigo, nome, bairro }]
 *  listarProfissionais() -> [{ codigo, nome, especialidade, codigoUbs }]
 *  consultarAgenda()     -> [{ codigo, codigoProfissional, inicio (ISO), livre }]
 *  buscarPaciente(cpf)   -> { cpf, nome, nascimento (AAAA-MM-DD), telefone } | null
 */
export class SigaSaudeAdapter {
  constructor(bancoLegado) {
    this.legado = bancoLegado;
  }

  listarUnidades() {
    return this.legado.TB_UNIDADE.map((r) => ({
      codigo: String(r.CD_UBS).trim(),
      nome: r.DS_UBS.trim(),
      bairro: r.DS_BAIRRO.trim(),
    }));
  }

  listarProfissionais() {
    return this.legado.TB_MEDICO.map((r) => ({
      codigo: String(r.CD_MED).trim(),
      nome: titulo(r.NM_MED),
      especialidade: ESPECIALIDADES[r.DS_ESPEC.trim()] ?? titulo(r.DS_ESPEC),
      codigoUbs: String(r.CD_UBS).trim(),
    }));
  }

  consultarAgenda() {
    return this.legado.TB_AGENDA.map((r) => ({
      codigo: String(r.CD_AGENDA),
      codigoProfissional: String(r.CD_MED).trim(),
      inicio: dataHoraLegadoParaIso(r.DT_AGENDA, r.HR_AGENDA),
      livre: r.FL_LIVRE === 'S',
    }));
  }

  buscarPaciente(cpf) {
    const alvo = somenteDigitos(cpf);
    const r = this.legado.TB_PACIENTE.find((p) => somenteDigitos(p.NR_CPF) === alvo);
    if (!r) return null;
    const [d, m, a] = r.DT_NASC.split('/');
    return {
      cpf: alvo,
      nome: titulo(r.NM_PACIENTE),
      nascimento: `${a}-${m}-${d}`,
      telefone: somenteDigitos(r.NR_FONE),
    };
  }
}

// O legado grava sem acento; o Adapter traduz para o nome que o cidadão reconhece.
const ESPECIALIDADES = { 'CLINICO GERAL': 'Clínico Geral', PEDIATRIA: 'Pediatria', GINECOLOGIA: 'Ginecologia', CARDIOLOGIA: 'Cardiologia' };

const somenteDigitos = (s) => String(s ?? '').replace(/\D/g, '');
const titulo = (s) =>
  String(s).trim().toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, e, l) => e + l.toUpperCase())
    .replace(/\s(Da|De|Do|Das|Dos|E)(?=\s)/g, (w) => w.toLowerCase());

function dataHoraLegadoParaIso(data, hora) {
  const [d, m, a] = data.split('/').map(Number);
  const [h, min] = hora.split(':').map(Number);
  return new Date(a, m - 1, d, h, min).toISOString();
}

// ---------------------------------------------------------------------------
// Legado simulado: imita as tabelas do SIGA-Saúde (nomes de coluna e formatos
// antigos: datas dd/mm/aaaa, CPF com máscara, nomes em maiúsculas).
// Dados 100% fictícios.

export function gerarCpf(base9) {
  const d = String(base9).padStart(9, '0').split('').map(Number);
  const dv = (arr) => {
    const soma = arr.reduce((s, n, i) => s + n * (arr.length + 1 - i), 0);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  d.push(dv(d));
  d.push(dv(d));
  return d.join('');
}

const fmtCpf = (c) => `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;
const fmtData = (dt) =>
  `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;

export const PACIENTES_DEMO = [
  { cpf: gerarCpf('123456789'), nome: 'MARIA DAS GRACAS SOUZA', nasc: '15/03/1948', fone: '(11) 98888-1001' },
  { cpf: gerarCpf('987654321'), nome: 'JOAO PEREIRA LIMA', nasc: '02/09/1985', fone: '(11) 97777-2002' },
  { cpf: gerarCpf('111222333'), nome: 'ANA CLARA ROCHA', nasc: '20/11/1992', fone: '(11) 96666-3003' },
  { cpf: gerarCpf('444555666'), nome: 'JOSE CARLOS NUNES', nasc: '07/07/1955', fone: '(11) 95555-4004' },
];

const NOMES_MEDICOS = ['ANA LUCIA MOTA', 'CARLOS EDUARDO RAMOS', 'BEATRIZ SANTOS', 'PAULO HENRIQUE DIAS',
  'FERNANDA ALVES', 'RICARDO GOMES', 'LUCIANA PRADO', 'MARCOS VIEIRA', 'TERESA CAMPOS',
  'ROBERTO FARIAS', 'SIMONE ARAUJO', 'EDUARDO MELO', 'PATRICIA LOPES', 'GUSTAVO REIS', 'HELENA COSTA'];

function proximosDiasUteis(hoje, qtd) {
  const dias = [];
  for (let i = 1; dias.length < qtd; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + i);
    if (d.getDay() !== 0 && d.getDay() !== 6) dias.push(d);
  }
  return dias;
}

// Clínico: 8 horários/dia; Ginecologia: 4; Pediatria escassa — no 1º dia útil só
// resta 1 horário livre (o cenário da "última vaga de pediatria").
function horariosDo(especialidade, idxDia) {
  if (especialidade === 'CLINICO GERAL') return ['07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30'];
  if (especialidade === 'GINECOLOGIA') return ['13:00', '13:40', '14:20', '15:00'];
  if (especialidade === 'CARDIOLOGIA') return ['14:00', '15:00'];
  return idxDia === 0 ? ['08:00', '08:20'] : ['08:00'];
}

export function criarLegadoSimulado(hoje = new Date()) {
  const TB_UNIDADE = [
    { CD_UBS: 1, DS_UBS: 'UBS Centro', DS_BAIRRO: 'Centro' },
    { CD_UBS: 2, DS_UBS: 'UBS Jardim das Flores', DS_BAIRRO: 'Jardim das Flores' },
    { CD_UBS: 3, DS_UBS: 'UBS Vila Nova', DS_BAIRRO: 'Vila Nova' },
    { CD_UBS: 4, DS_UBS: 'UBS Parque Industrial', DS_BAIRRO: 'Parque Industrial' },
    { CD_UBS: 5, DS_UBS: 'UBS São José', DS_BAIRRO: 'São José' },
  ];
  const TB_MEDICO = [];
  let n = 0;
  for (const u of TB_UNIDADE) {
    for (const esp of ['CLINICO GERAL', 'PEDIATRIA', 'GINECOLOGIA']) {
      n += 1;
      TB_MEDICO.push({ CD_MED: `M${String(n).padStart(3, '0')}`, NM_MED: NOMES_MEDICOS[n - 1], DS_ESPEC: esp, CD_UBS: u.CD_UBS });
    }
  }
  // Cardiologia só na UBS Centro e com a agenda toda ocupada: cenário "sem vagas -> fila de espera"
  TB_MEDICO.push({ CD_MED: 'M016', NM_MED: 'RAFAEL MONTEIRO', DS_ESPEC: 'CARDIOLOGIA', CD_UBS: 1 });

  const TB_AGENDA = [];
  const dias = proximosDiasUteis(hoje, 5);
  for (const med of TB_MEDICO) {
    dias.forEach((dia, idxDia) => {
      horariosDo(med.DS_ESPEC, idxDia).forEach((h, j) => {
        const ocupado = med.DS_ESPEC === 'CARDIOLOGIA' || (med.DS_ESPEC === 'PEDIATRIA' ? (idxDia > 0 || j === 0) : (j + idxDia) % 3 === 0);
        // Código estável (profissional + data + hora): a sincronização diária não duplica horários
        TB_AGENDA.push({ CD_AGENDA: `${med.CD_MED}-${fmtData(dia).split('/').reverse().join('')}-${h.replace(':', '')}`, CD_MED: med.CD_MED, DT_AGENDA: fmtData(dia), HR_AGENDA: h, FL_LIVRE: ocupado ? 'N' : 'S' });
      });
    });
  }

  const TB_PACIENTE = PACIENTES_DEMO.map((p) => ({ NR_CPF: fmtCpf(p.cpf), NM_PACIENTE: p.nome, DT_NASC: p.nasc, NR_FONE: p.fone }));
  return { TB_UNIDADE, TB_MEDICO, TB_AGENDA, TB_PACIENTE };
}
