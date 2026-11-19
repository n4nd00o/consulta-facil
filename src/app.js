// Monólito modular (ADR-001): um processo, um banco, módulos internos separados.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHash } from 'node:crypto';
import { abrirBanco } from './db.js';
import { config as configPadrao } from './config.js';
import { SigaSaudeAdapter, criarLegadoSimulado, PACIENTES_DEMO } from './modules/siga-adapter.js';
import { migrarDoLegado } from './modules/migracao.js';
import { SmsProviderSimulado } from './modules/sms-provider.js';
import { WorkerNotificacoes } from './modules/notificacoes.js';
import * as pacientes from './modules/pacientes.js';
import * as agenda from './modules/agenda.js';
import * as painel from './modules/painel.js';
import * as demonstracao from './modules/demonstracao.js';

const { ErroNegocio } = pacientes;
const PUBLICO = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const UBS_PILOTO = [1, 2, 3]; // 3 UBS no piloto (meta de 3 meses)

export function criarApp(opcoes = {}) {
  const cfg = { ...configPadrao, ...opcoes.config };
  const db = abrirBanco(opcoes.dbPath ?? cfg.dbPath);
  const adapter = opcoes.adapter ?? new SigaSaudeAdapter(criarLegadoSimulado());
  const provedor = opcoes.provedor ?? new SmsProviderSimulado();
  const worker = new WorkerNotificacoes(db, provedor, cfg);
  const medidor = new painel.MedidorLatencia();
  const ctx = { db, adapter, notificacoes: worker, cfg };

  // Sincroniza com o SIGA-Saúde a cada início: idempotente e nunca apaga (novos dias entram sozinhos)
  const rel = migrarDoLegado(db, adapter, { ubsPiloto: UBS_PILOTO });
  console.log(`[migracao] SIGA-Saúde: ${rel.inseridos.vagas} horários novos, ${rel.jaExistentes} já existentes, reconciliação ok=${rel.reconciliacao.ok}`);

  const rotas = criarRotas({ ...ctx, provedor, worker, medidor });
  // Em ambiente serverless (Vercel) não há processo contínuo: o envio da fila de SMS
  // avança a cada requisição, sem atrasar a resposta.
  const serverless = Boolean(opcoes.serverless);

  const tratar = async (req, res) => {
    const inicio = performance.now();
    res.on('finish', () => {
      if (req.url.startsWith('/api/')) medidor.registrar(performance.now() - inicio, res.statusCode);
    });
    if (serverless) worker.ciclo().catch((e) => console.error('[notificacoes]', e));
    try {
      cabecalhosSeguranca(res);
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await tratarApi(rotas, req, res, url, db);
      return await servirEstatico(url.pathname, res);
    } catch (e) {
      if (e instanceof ErroNegocio) return json(res, e.status, { erro: e.message, ...e.extra });
      console.error('[erro]', e);
      return json(res, 500, { erro: 'Algo deu errado do nosso lado. Tente de novo em instantes.' });
    }
  };
  const server = createServer(tratar);

  if (opcoes.iniciarWorker !== false && !serverless) worker.iniciar();
  return {
    server, tratar, db, worker, provedor, cfg, adapter,
    fechar: () => new Promise((r) => { worker.parar(); server.close(() => { db.close(); r(); }); }),
  };
}

function criarRotas(ctx) {
  const { db, cfg, worker, provedor, medidor, adapter } = ctx;
  const cidadao = (s) => {
    if (s?.perfil !== 'cidadao') throw new ErroNegocio(401, 'Sua sessão expirou. Entre novamente.');
    return s.paciente_id;
  };
  const exigirDemo = () => {
    if (!cfg.demo) throw new ErroNegocio(404, 'Indisponível.');
  };
  const equipe = (s) => {
    if (s?.perfil !== 'ubs') throw new ErroNegocio(401, 'Acesso restrito à equipe da UBS.');
  };

  return {
    'GET /api/config': () => ({
      demo: cfg.demo,
      ...(cfg.demo ? { pacientesDemo: PACIENTES_DEMO.map((p) => ({ cpf: p.cpf, nascimento: p.nasc, nome: p.nome })) } : {}),
    }),

    // --- Autenticação do cidadão (sem e-mail) ---
    'POST /api/auth/codigo': async ({ body, ip }) => {
      limitarTaxa(`otp:${ip}`, 10, 10 * 60_000);
      return pacientes.solicitarCodigo(ctx, body.cpf, body.nascimento);
    },
    'POST /api/auth/entrar': ({ body, ip, res }) => {
      limitarTaxa(`login:${ip}`, 20, 10 * 60_000);
      const r = pacientes.verificarCodigo(ctx, body.cpf, body.codigo);
      definirCookie(res, r.token, cfg.sessaoHoras);
      return { nome: r.nome };
    },
    'POST /api/auth/sair': ({ token, res }) => {
      if (token) pacientes.encerrarSessao(db, token);
      definirCookie(res, '', 0);
      return { ok: true };
    },
    'GET /api/eu': ({ sessao }) => pacientes.perfilPaciente(db, cidadao(sessao)),

    // --- Agenda ---
    'GET /api/especialidades': () => agenda.especialidadesComVagas(db),
    'GET /api/ubs': ({ url }) => agenda.listarUbs(db, url.searchParams.get('especialidade') ?? ''),
    'GET /api/horarios': ({ url }) => agenda.listarHorarios(db, url.searchParams.get('especialidade') ?? '', url.searchParams.get('ubs'),
      { todos: url.searchParams.get('todos') === '1' }),

    // --- Painel da demonstração (somente DEMO): reproduz os problemas do piloto ---
    'GET /api/demo/estado': ({ sessao }) => {
      exigirDemo();
      const pacienteId = sessao?.perfil === 'cidadao' ? sessao.paciente_id : null;
      return { modoSms: provedor.modo, circuito: worker.circuito.snapshot().estado, mensagens: demonstracao.filaDeMensagens(db, pacienteId, cfg) };
    },
    'POST /api/demo/sms': ({ body }) => {
      exigirDemo();
      provedor.definirModo(body.modo);
      if (body.modo === 'normal') worker.circuito.sucesso();
      return { modoSms: provedor.modo };
    },
    'POST /api/demo/outra-pessoa': ({ body }) => { exigirDemo(); return demonstracao.outraPessoaReserva(db, body.vagaId); },
    'GET /api/consultas': ({ sessao }) => agenda.minhasConsultas(db, cidadao(sessao)),
    'POST /api/consultas': ({ sessao, body }) => agenda.agendar(db, cidadao(sessao), body.vagaId, body.chave),
    'POST /api/consultas/:id/cancelar': ({ sessao, params }) => agenda.cancelar(db, cfg, cidadao(sessao), params.id),
    'POST /api/consultas/:id/remarcar': ({ sessao, params, body }) => agenda.remarcar(db, cidadao(sessao), params.id, body.vagaId, body.chave),
    'POST /api/consultas/:id/presenca': ({ sessao, params }) => agenda.confirmarPresenca(db, cidadao(sessao), params.id),
    'GET /api/fila': ({ sessao }) => agenda.minhasFilas(db, cidadao(sessao)),
    'POST /api/fila': ({ sessao, body }) => agenda.entrarNaFila(db, cidadao(sessao), body.especialidade, body.ubsId),
    'POST /api/fila/:id/sair': ({ sessao, params }) => agenda.sairDaFila(db, cidadao(sessao), params.id),

    // --- Painel da UBS ---
    'POST /api/painel/entrar': ({ body, ip, res }) => {
      limitarTaxa(`painel:${ip}`, 10, 10 * 60_000);
      const a = createHash('sha256').update(String(body.senha ?? '')).digest();
      const b = createHash('sha256').update(cfg.painelSenha).digest();
      if (!timingSafeEqual(a, b)) throw new ErroNegocio(401, 'Senha incorreta.');
      const token = pacientes.criarSessao(db, cfg, { perfil: 'ubs' });
      pacientes.auditar(db, 'equipe_ubs', 'login_painel');
      definirCookie(res, token, cfg.sessaoHoras, 'sid_ubs');
      return { ok: true };
    },
    'GET /api/painel/resumo': ({ sessao }) => { equipe(sessao); return painel.resumo(db, { medidor, worker }); },
    'GET /api/painel/unidades': ({ sessao }) => { equipe(sessao); return painel.listarUnidades(db); },
    'POST /api/painel/unidades/:id/flag': ({ sessao, params, body }) => {
      equipe(sessao);
      painel.definirFlag(db, params.id, Boolean(body.ativa));
      pacientes.auditar(db, 'equipe_ubs', body.ativa ? 'ativou_ubs' : 'desativou_ubs', `ubs:${params.id}`);
      return { ok: true };
    },
    'GET /api/painel/agenda/:ubs': ({ sessao, params }) => {
      equipe(sessao);
      pacientes.auditar(db, 'equipe_ubs', 'consultou_agenda', `ubs:${params.ubs}`);
      return painel.agendaDaUbs(db, params.ubs);
    },
    'GET /api/painel/sms-falhas': ({ sessao }) => { equipe(sessao); return painel.smsComFalha(db); },
    'POST /api/painel/sms-falhas/:id/contatado': ({ sessao, params }) => { equipe(sessao); painel.marcarContatado(db, params.id); return { ok: true }; },
    'POST /api/painel/sms-falhas/reenviar': ({ sessao }) => { equipe(sessao); return { reenfileiradas: painel.reenviarFalhas(db) }; },
    'GET /api/painel/alertas': ({ sessao }) => { equipe(sessao); return painel.listarAlertas(db); },
    'POST /api/painel/alertas/:id/resolver': ({ sessao, params }) => { equipe(sessao); painel.resolverAlerta(db, params.id); return { ok: true }; },
    'POST /api/painel/migracao': ({ sessao, body }) => {
      equipe(sessao);
      const rel = migrarDoLegado(db, adapter, { dryRun: body.dryRun !== false });
      pacientes.auditar(db, 'equipe_ubs', rel.modo === 'ensaio' ? 'ensaio_migracao' : 'migracao');
      return rel;
    },
    // Simulação (somente modo demo): reproduzir a queda do provedor de SMS do piloto
    'POST /api/painel/simulacao/sms': ({ sessao, body }) => {
      equipe(sessao);
      if (!cfg.demo) throw new ErroNegocio(404, 'Indisponível.');
      provedor.definirModo(body.modo);
      return { modo: provedor.modo };
    },
    'GET /api/painel/simulacao/caixa-sms': ({ sessao }) => {
      equipe(sessao);
      if (!cfg.demo) throw new ErroNegocio(404, 'Indisponível.');
      return provedor.caixa;
    },
  };
}

async function tratarApi(rotas, req, res, url, db) {
  const { handler, params } = encontrarRota(rotas, req.method, url.pathname);
  if (!handler) return json(res, 404, { erro: 'Rota não encontrada.' });
  if (req.method === 'POST' && req.headers['x-requested-with'] !== 'consulta-facil') {
    return json(res, 403, { erro: 'Requisição recusada.' }); // proteção simples contra CSRF
  }
  const body = req.method === 'POST' ? await lerCorpo(req) : {};
  const token = lerCookie(req, url.pathname.startsWith('/api/painel/') ? 'sid_ubs' : 'sid');
  const sessao = pacientes.obterSessao(db, token);
  // Atrás do proxy da Vercel, o IP real vem no x-forwarded-for
  const encaminhado = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const ip = encaminhado || req.socket.remoteAddress || 'desconhecido';
  const resultado = await handler({ req, res, url, params, body, sessao, token, ip });
  return json(res, 200, resultado);
}

function encontrarRota(rotas, metodo, caminho) {
  const partes = caminho.split('/').filter(Boolean);
  for (const [chave, handler] of Object.entries(rotas)) {
    const [m, padrao] = chave.split(' ');
    if (m !== metodo) continue;
    const pp = padrao.split('/').filter(Boolean);
    if (pp.length !== partes.length) continue;
    const params = {};
    const ok = pp.every((p, i) => {
      if (p.startsWith(':')) { params[p.slice(1)] = decodeURIComponent(partes[i]); return /^[\w-]+$/.test(params[p.slice(1)]); }
      return p === partes[i];
    });
    if (ok) return { handler, params };
  }
  return {};
}

function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let dados = '';
    req.on('data', (c) => {
      dados += c;
      if (dados.length > 10_000) { req.destroy(); falha(new ErroNegocio(413, 'Requisição muito grande.')); }
    });
    req.on('end', () => {
      if (!dados) return ok({});
      try {
        const obj = JSON.parse(dados);
        ok(obj && typeof obj === 'object' ? obj : {});
      } catch {
        falha(new ErroNegocio(400, 'Dados inválidos.'));
      }
    });
    req.on('error', falha);
  });
}

const tentativas = new Map();
function limitarTaxa(chave, max, janelaMs) {
  const t = Date.now();
  const lista = (tentativas.get(chave) ?? []).filter((x) => t - x < janelaMs);
  if (lista.length >= max) throw new ErroNegocio(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
  lista.push(t);
  tentativas.set(chave, lista);
}

function lerCookie(req, nome) {
  const c = req.headers.cookie ?? '';
  const m = c.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${nome}=`));
  return m ? m.slice(nome.length + 1) : null;
}

// Cookies separados para cidadão e equipe: entrar no painel não derruba a sessão do app.
function definirCookie(res, valor, horas, nome = 'sid') {
  const seguro = process.env.VERCEL ? '; Secure' : ''; // HTTPS na Vercel; localhost usa HTTP
  res.setHeader('Set-Cookie', `${nome}=${valor}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.round(horas * 3600)}${seguro}`);
}

function cabecalhosSeguranca(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

function json(res, status, dados) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(dados));
}

async function servirEstatico(caminho, res) {
  const alvo = caminho === '/' ? '/index.html' : caminho === '/painel' ? '/painel.html' : caminho;
  const arquivo = normalize(join(PUBLICO, alvo));
  if (!arquivo.startsWith(PUBLICO)) return json(res, 403, { erro: 'Proibido.' });
  try {
    const conteudo = await readFile(arquivo);
    res.writeHead(200, { 'Content-Type': TIPOS[extname(arquivo)] ?? 'application/octet-stream' });
    res.end(conteudo);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Página não encontrada');
  }
}
