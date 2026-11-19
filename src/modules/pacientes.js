// Módulo Pacientes e Autenticação.
// RA01: acesso SEM e-mail — CPF + data de nascimento + código por SMS.
// LGPD: minimização (só nome, CPF, nascimento e telefone), código guardado como hash,
// mensagens de erro que não revelam se um CPF existe, trilha de auditoria.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { agora } from '../db.js';

export class ErroNegocio extends Error {
  constructor(status, mensagem, extra = {}) {
    super(mensagem);
    this.status = status;
    this.extra = extra;
  }
}

const MSG_DADOS = 'Não encontramos um cadastro com esse CPF e essa data de nascimento. Confira os dados ou procure sua UBS.';

export function somenteDigitos(s) {
  return String(s ?? '').replace(/\D/g, '');
}

export function cpfValido(cpf) {
  const c = somenteDigitos(cpf);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

export const mascararCpf = (cpf) => `***.${cpf.slice(3, 6)}.***-${cpf.slice(9)}`;
export const mascararTelefone = (t) => `(${t.slice(0, 2)}) *****-${t.slice(-4)}`;
const hash = (s) => createHash('sha256').update(s).digest();

export function auditar(db, ator, acao, alvo = null) {
  db.prepare('INSERT INTO auditoria (ator, acao, alvo, criada_em) VALUES (?, ?, ?, ?)').run(ator, acao, alvo, agora());
}

function localizarPaciente(db, adapter, cpf) {
  const local = db.prepare('SELECT * FROM pacientes WHERE cpf = ?').get(cpf);
  if (local) return local;
  const doLegado = adapter.buscarPaciente(cpf); // cadastro vem do SIGA-Saúde via Adapter
  if (!doLegado) return null;
  db.prepare('INSERT INTO pacientes (cpf, nascimento, nome, telefone) VALUES (?, ?, ?, ?)')
    .run(doLegado.cpf, doLegado.nascimento, doLegado.nome, doLegado.telefone);
  return db.prepare('SELECT * FROM pacientes WHERE cpf = ?').get(cpf);
}

/** Passo 1: CPF + nascimento → envia código de 6 dígitos por SMS. */
export async function solicitarCodigo({ db, adapter, notificacoes, cfg }, cpfBruto, nascimento) {
  const cpf = somenteDigitos(cpfBruto);
  if (!cpfValido(cpf)) throw new ErroNegocio(400, 'CPF inválido. Digite os 11 números do CPF.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(nascimento))) throw new ErroNegocio(400, 'Informe a data de nascimento.');

  const paciente = localizarPaciente(db, adapter, cpf);
  if (!paciente || paciente.nascimento !== nascimento) throw new ErroNegocio(404, MSG_DADOS);

  const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expira = new Date(Date.now() + cfg.otpValidadeMin * 60_000).toISOString();
  db.prepare(`INSERT INTO otp (cpf, codigo, expira_em, tentativas) VALUES (?, ?, ?, 0)
              ON CONFLICT(cpf) DO UPDATE SET codigo = excluded.codigo, expira_em = excluded.expira_em, tentativas = 0`)
    .run(cpf, hash(codigo).toString('hex'), expira);

  const envio = await notificacoes.enviarAgora(paciente.telefone, `Consulta Fácil: seu código de acesso é ${codigo}. Não compartilhe.`);
  auditar(db, `paciente:${paciente.id}`, 'solicitou_codigo', envio.enviado ? 'sms_enviado' : 'sms_falhou');
  return {
    telefone: mascararTelefone(paciente.telefone),
    smsEnviado: envio.enviado,
    ...(cfg.demo ? { codigoDemo: codigo } : {}),
  };
}

/** Passo 2: confere o código e abre a sessão. */
export function verificarCodigo({ db, cfg }, cpfBruto, codigo) {
  const cpf = somenteDigitos(cpfBruto);
  const reg = db.prepare('SELECT * FROM otp WHERE cpf = ?').get(cpf);
  if (!reg || reg.expira_em < agora()) throw new ErroNegocio(400, 'Código expirado. Peça um novo código.');
  if (reg.tentativas >= cfg.otpMaxTentativas) throw new ErroNegocio(429, 'Muitas tentativas. Peça um novo código.');

  const ok = timingSafeEqual(Buffer.from(reg.codigo, 'hex'), hash(somenteDigitos(codigo)));
  if (!ok) {
    db.prepare('UPDATE otp SET tentativas = tentativas + 1 WHERE cpf = ?').run(cpf);
    throw new ErroNegocio(400, 'Código incorreto. Confira o SMS e tente de novo.');
  }
  db.prepare('DELETE FROM otp WHERE cpf = ?').run(cpf);
  const paciente = db.prepare('SELECT id, nome FROM pacientes WHERE cpf = ?').get(cpf);
  const token = criarSessao(db, cfg, { pacienteId: paciente.id, perfil: 'cidadao' });
  auditar(db, `paciente:${paciente.id}`, 'login');
  return { token, nome: paciente.nome };
}

export function criarSessao(db, cfg, { pacienteId = null, perfil }) {
  const token = randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + cfg.sessaoHoras * 3600_000).toISOString();
  db.prepare('INSERT INTO sessoes (token, paciente_id, perfil, expira_em) VALUES (?, ?, ?, ?)').run(token, pacienteId, perfil, expira);
  return token;
}

export function obterSessao(db, token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const s = db.prepare('SELECT * FROM sessoes WHERE token = ? AND expira_em > ?').get(token, agora());
  return s ?? null;
}

export function encerrarSessao(db, token) {
  db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
}

export function perfilPaciente(db, id) {
  const p = db.prepare('SELECT nome, cpf, telefone FROM pacientes WHERE id = ?').get(id);
  return { nome: p.nome, cpf: mascararCpf(p.cpf), telefone: mascararTelefone(p.telefone) };
}
