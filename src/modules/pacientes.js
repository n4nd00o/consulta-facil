// Módulo Pacientes e Autenticação.
// RA01: acesso SEM e-mail — CPF + data de nascimento + código por SMS.
// LGPD: minimização (só nome, CPF, nascimento e telefone), código guardado como hash,
// mensagens de erro que não revelam se um CPF existe, trilha de auditoria.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
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

// Tokens assinados (HMAC-SHA256): valem em qualquer instância do servidor. Na Vercel rodam várias cópias
// do app ao mesmo tempo, cada uma com seu banco temporário; um login guardado só no banco se perderia.
// SESSAO_SEGREDO vem do ambiente (configurado na Vercel); localmente, um segredo novo a cada início.
const SEGREDO = process.env.SESSAO_SEGREDO || randomBytes(32).toString('hex');
const TAMANHO_MAX_TOKEN = 1024;

function assinar(dados) {
  const corpo = Buffer.from(JSON.stringify(dados)).toString('base64url');
  const assinatura = createHmac('sha256', SEGREDO).update(corpo).digest('base64url');
  return `${corpo}.${assinatura}`;
}

/** Devolve os dados do token se a assinatura confere e ele não expirou; senão, null. */
function lerAssinado(token) {
  if (typeof token !== 'string' || token.length > TAMANHO_MAX_TOKEN) return null;
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const [corpo, assinatura] = partes;
  const esperado = createHmac('sha256', SEGREDO).update(corpo).digest();
  const recebido = Buffer.from(assinatura, 'base64url');
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) return null;
  try {
    const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    return dados && typeof dados.exp === 'number' && dados.exp > Date.now() ? dados : null;
  } catch {
    return null;
  }
}

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
    // Vai num cookie HttpOnly (não no JSON): permite conferir o código em outra instância do servidor
    desafio: assinar({ t: 'otp', cpf, h: hash(codigo).toString('hex'), exp: Date.now() + cfg.otpValidadeMin * 60_000 }),
  };
}

/** Passo 2: confere o código e abre a sessão. */
export function verificarCodigo({ db, cfg, adapter }, cpfBruto, codigo, desafio) {
  const cpf = somenteDigitos(cpfBruto);
  const reg = db.prepare('SELECT * FROM otp WHERE cpf = ?').get(cpf);
  let codigoEsperado = null;
  if (reg && reg.expira_em >= agora()) {
    if (reg.tentativas >= cfg.otpMaxTentativas) throw new ErroNegocio(429, 'Muitas tentativas. Peça um novo código.');
    codigoEsperado = reg.codigo;
  } else {
    const d = lerAssinado(desafio); // código pedido em outra instância
    if (d?.t === 'otp' && d.cpf === cpf) codigoEsperado = d.h;
  }
  if (!codigoEsperado) throw new ErroNegocio(400, 'Código expirado. Peça um novo código.');

  const ok = timingSafeEqual(Buffer.from(codigoEsperado, 'hex'), hash(somenteDigitos(codigo)));
  if (!ok) {
    if (reg) db.prepare('UPDATE otp SET tentativas = tentativas + 1 WHERE cpf = ?').run(cpf);
    throw new ErroNegocio(400, 'Código incorreto. Confira o SMS e tente de novo.');
  }
  db.prepare('DELETE FROM otp WHERE cpf = ?').run(cpf);
  const paciente = localizarPaciente(db, adapter, cpf);
  const token = criarSessao(db, cfg, { pacienteId: paciente.id, perfil: 'cidadao' });
  auditar(db, `paciente:${paciente.id}`, 'login');
  return { token, nome: paciente.nome };
}

/** Sessão = token assinado com perfil e CPF (não depende do banco da instância). */
export function criarSessao(db, cfg, { pacienteId = null, perfil }) {
  const cpf = pacienteId ? db.prepare('SELECT cpf FROM pacientes WHERE id = ?').get(pacienteId)?.cpf : null;
  return assinar({ t: 'sessao', perfil, cpf, n: randomBytes(8).toString('hex'), exp: Date.now() + cfg.sessaoHoras * 3600_000 });
}

const idRevogacao = (token) => createHash('sha256').update(token).digest('hex');

export function obterSessao(db, token, adapter = null) {
  const d = lerAssinado(token);
  if (d?.t !== 'sessao') return null;
  const revogada = db.prepare("SELECT 1 FROM sessoes WHERE token = ? AND perfil = 'encerrada'").get(idRevogacao(token));
  if (revogada) return null;
  if (d.perfil !== 'cidadao') return { perfil: d.perfil, paciente_id: null };
  // Em outra instância o paciente pode ainda não estar no banco local: vem do SIGA-Saúde pelo Adapter
  const paciente = adapter
    ? localizarPaciente(db, adapter, d.cpf)
    : db.prepare('SELECT id FROM pacientes WHERE cpf = ?').get(d.cpf);
  return paciente ? { perfil: 'cidadao', paciente_id: paciente.id } : null;
}

/** Sair: o token é revogado (lista de encerrados) e o cookie é apagado pelo navegador. */
export function encerrarSessao(db, token) {
  const d = lerAssinado(token);
  if (!d) return;
  db.prepare(`INSERT OR REPLACE INTO sessoes (token, paciente_id, perfil, expira_em) VALUES (?, NULL, 'encerrada', ?)`)
    .run(idRevogacao(token), new Date(d.exp).toISOString());
}

export function perfilPaciente(db, id) {
  const p = db.prepare('SELECT nome, cpf, telefone FROM pacientes WHERE id = ?').get(id);
  return { nome: p.nome, cpf: mascararCpf(p.cpf), telefone: mascararTelefone(p.telefone) };
}
