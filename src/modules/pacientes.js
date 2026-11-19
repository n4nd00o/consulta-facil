// Módulo Pacientes e Autenticação.
// RA01: acesso SEM e-mail — CPF + data de nascimento + código por SMS.
// LGPD: minimização (só nome, CPF, nascimento e telefone), código guardado como hash,
// mensagens de erro que não revelam se um CPF existe, trilha de auditoria.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
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

// Tokens cifrados e autenticados (AES-256-GCM): valem em qualquer instância do servidor. Na Vercel rodam
// várias cópias do app ao mesmo tempo, cada uma com seu banco temporário; um login guardado só no banco
// se perderia. Cifrar (e não só assinar) protege os dados do pré-cadastro que viajam no token (LGPD).
// SESSAO_SEGREDO vem do ambiente (configurado na Vercel); localmente, um segredo novo a cada início.
const SEGREDO = process.env.SESSAO_SEGREDO || randomBytes(32).toString('hex');
const CHAVE = createHash('sha256').update(SEGREDO).digest();
const TAMANHO_MAX_TOKEN = 2048;
const TAMANHO_IV = 12;
const TAMANHO_TAG = 16;

function assinar(dados) {
  const iv = randomBytes(TAMANHO_IV);
  const cifra = createCipheriv('aes-256-gcm', CHAVE, iv);
  const conteudo = Buffer.concat([cifra.update(JSON.stringify(dados), 'utf8'), cifra.final()]);
  return [iv, conteudo, cifra.getAuthTag()].map((b) => b.toString('base64url')).join('.');
}

/** Devolve os dados do token se ele é autêntico e não expirou; senão, null. */
function lerAssinado(token) {
  if (typeof token !== 'string' || token.length > TAMANHO_MAX_TOKEN) return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [iv, conteudo, tag] = partes.map((p) => Buffer.from(p, 'base64url'));
  if (iv.length !== TAMANHO_IV || tag.length !== TAMANHO_TAG) return null;
  try {
    const decifra = createDecipheriv('aes-256-gcm', CHAVE, iv);
    decifra.setAuthTag(tag);
    const dados = JSON.parse(Buffer.concat([decifra.update(conteudo), decifra.final()]).toString('utf8'));
    return dados && typeof dados.exp === 'number' && dados.exp > Date.now() ? dados : null;
  } catch {
    return null; // adulterado, chave diferente ou formato inválido
  }
}

export function auditar(db, ator, acao, alvo = null) {
  db.prepare('INSERT INTO auditoria (ator, acao, alvo, criada_em) VALUES (?, ?, ?, ?)').run(ator, acao, alvo, agora());
}

/**
 * Procura o paciente: banco local → SIGA-Saúde (Adapter) → pré-cadastro feito pelo app (vindo no token,
 * quando a requisição cai numa instância que ainda não tem esse paciente).
 */
function localizarPaciente(db, adapter, cpf, preCadastro = null) {
  const local = db.prepare('SELECT * FROM pacientes WHERE cpf = ?').get(cpf);
  if (local) return local;
  const doLegado = adapter?.buscarPaciente(cpf); // cadastro vem do SIGA-Saúde via Adapter
  const origem = doLegado ? 'siga' : 'app';
  const dados = doLegado ?? (preCadastro ? { cpf, ...preCadastro } : null);
  if (!dados) return null;
  db.prepare('INSERT OR IGNORE INTO pacientes (cpf, nascimento, nome, telefone, origem) VALUES (?, ?, ?, ?, ?)')
    .run(dados.cpf, dados.nascimento, dados.nome, dados.telefone, origem);
  return db.prepare('SELECT * FROM pacientes WHERE cpf = ?').get(cpf);
}

/** Dados do pré-cadastro que viajam (cifrados) no token, para o paciente existir em qualquer instância. */
const dadosPreCadastro = (p) => (p.origem === 'app' ? { nome: p.nome, nascimento: p.nascimento, telefone: p.telefone } : undefined);

/** Passo 1: CPF + nascimento → envia código de 6 dígitos por SMS. */
export async function solicitarCodigo(ctx, cpfBruto, nascimento) {
  const { db, adapter } = ctx;
  const cpf = somenteDigitos(cpfBruto);
  if (!cpfValido(cpf)) throw new ErroNegocio(400, 'CPF inválido. Digite os 11 números do CPF.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(nascimento))) throw new ErroNegocio(400, 'Informe a data de nascimento.');

  const paciente = localizarPaciente(db, adapter, cpf);
  if (!paciente || paciente.nascimento !== nascimento) throw new ErroNegocio(404, MSG_DADOS, { podeCadastrar: true });
  return enviarCodigo(ctx, paciente);
}

// ---------------------------------------------------------------- cadastro de quem ainda não tem
const NOME_VALIDO = /^[\p{L}][\p{L}' .-]*[\p{L}]$/u;
const IDADE_MAXIMA = 130;

function validarCadastro({ nome, cpf, nascimento, telefone, consentimento }) {
  const n = String(nome ?? '').trim().replace(/\s+/g, ' ');
  if (n.length < 5 || n.length > 100 || !n.includes(' ') || !NOME_VALIDO.test(n)) {
    throw new ErroNegocio(400, 'Digite seu nome completo, com nome e sobrenome.', { campo: 'nome' });
  }
  const c = somenteDigitos(cpf);
  if (!cpfValido(c)) throw new ErroNegocio(400, 'Este CPF não existe. Confira os números no seu documento.', { campo: 'cpf' });
  const data = String(nascimento ?? '');
  const dt = new Date(`${data}T12:00:00Z`);
  const idade = (Date.now() - dt) / (365.25 * 86400_000);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== data || idade < 0 || idade > IDADE_MAXIMA) {
    throw new ErroNegocio(400, 'Data de nascimento inválida. Exemplo: dia 05, mês 03, ano 1950.', { campo: 'nascimento' });
  }
  const t = somenteDigitos(telefone);
  if (!/^[1-9]{2}9\d{8}$/.test(t)) {
    throw new ErroNegocio(400, 'Digite o celular com DDD, 11 números. Exemplo: (11) 98888-7777.', { campo: 'telefone' });
  }
  if (consentimento !== true) {
    throw new ErroNegocio(400, 'Para continuar, marque que autoriza o uso dos dados para o agendamento.', { campo: 'consentimento' });
  }
  return { nome: n, cpf: c, nascimento: data, telefone: t };
}

/**
 * Pré-cadastro pelo app (sem e-mail, RA01). Só os dados mínimos (LGPD) e o consentimento registrado.
 * A UBS confere os documentos na primeira consulta (o pré-cadastro aparece marcado na agenda da recepção).
 */
export async function cadastrar(ctx, dados) {
  const { db, adapter } = ctx;
  const novo = validarCadastro(dados);
  if (localizarPaciente(db, adapter, novo.cpf)) {
    throw new ErroNegocio(409, 'Já existe cadastro com este CPF. Use "Entrar" com seu CPF e data de nascimento.', { jaCadastrado: true });
  }
  db.prepare("INSERT INTO pacientes (cpf, nascimento, nome, telefone, origem) VALUES (?, ?, ?, ?, 'app')")
    .run(novo.cpf, novo.nascimento, novo.nome, novo.telefone);
  const paciente = db.prepare('SELECT * FROM pacientes WHERE cpf = ?').get(novo.cpf);
  auditar(db, `paciente:${paciente.id}`, 'pre_cadastro', 'consentimento_lgpd_registrado');
  return enviarCodigo(ctx, paciente);
}

/** Gera o código, guarda o hash e envia por SMS; o desafio cifrado vai num cookie HttpOnly. */
async function enviarCodigo({ db, notificacoes, cfg }, paciente) {
  const cpf = paciente.cpf;
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
    desafio: assinar({
      t: 'otp', cpf, h: hash(codigo).toString('hex'), cad: dadosPreCadastro(paciente),
      exp: Date.now() + cfg.otpValidadeMin * 60_000,
    }),
  };
}

/** Passo 2: confere o código e abre a sessão. */
export function verificarCodigo({ db, cfg, adapter }, cpfBruto, codigo, desafio) {
  const cpf = somenteDigitos(cpfBruto);
  const reg = db.prepare('SELECT * FROM otp WHERE cpf = ?').get(cpf);
  const d = lerAssinado(desafio);
  const doDesafio = d?.t === 'otp' && d.cpf === cpf ? d : null;
  let codigoEsperado = null;
  if (reg && reg.expira_em >= agora()) {
    if (reg.tentativas >= cfg.otpMaxTentativas) throw new ErroNegocio(429, 'Muitas tentativas. Peça um novo código.');
    codigoEsperado = reg.codigo;
  } else if (doDesafio) {
    codigoEsperado = doDesafio.h; // código pedido em outra instância
  }
  if (!codigoEsperado) throw new ErroNegocio(400, 'Código expirado. Peça um novo código.');

  const ok = timingSafeEqual(Buffer.from(codigoEsperado, 'hex'), hash(somenteDigitos(codigo)));
  if (!ok) {
    if (reg) db.prepare('UPDATE otp SET tentativas = tentativas + 1 WHERE cpf = ?').run(cpf);
    throw new ErroNegocio(400, 'Código incorreto. Confira o SMS e tente de novo.');
  }
  db.prepare('DELETE FROM otp WHERE cpf = ?').run(cpf);
  const paciente = localizarPaciente(db, adapter, cpf, doDesafio?.cad);
  const token = criarSessao(db, cfg, { pacienteId: paciente.id, perfil: 'cidadao' });
  auditar(db, `paciente:${paciente.id}`, 'login');
  return { token, nome: paciente.nome };
}

/** Sessão = token assinado com perfil e CPF (não depende do banco da instância). */
export function criarSessao(db, cfg, { pacienteId = null, perfil }) {
  const p = pacienteId ? db.prepare('SELECT * FROM pacientes WHERE id = ?').get(pacienteId) : null;
  return assinar({
    t: 'sessao', perfil, cpf: p?.cpf ?? null, cad: p ? dadosPreCadastro(p) : undefined,
    n: randomBytes(8).toString('hex'), exp: Date.now() + cfg.sessaoHoras * 3600_000,
  });
}

const idRevogacao = (token) => createHash('sha256').update(token).digest('hex');

export function obterSessao(db, token, adapter = null) {
  const d = lerAssinado(token);
  if (d?.t !== 'sessao') return null;
  const revogada = db.prepare("SELECT 1 FROM sessoes WHERE token = ? AND perfil = 'encerrada'").get(idRevogacao(token));
  if (revogada) return null;
  if (d.perfil !== 'cidadao') return { perfil: d.perfil, paciente_id: null };
  // Em outra instância o paciente pode ainda não estar no banco local: vem do SIGA-Saúde pelo Adapter
  const paciente = localizarPaciente(db, adapter, d.cpf, d.cad);
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
