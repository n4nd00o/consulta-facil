// Testes de aceitação do Consulta Fácil (tabelas de aceitação RF01/RF02 e cadeia de rastreabilidade).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { criarApp } from '../src/app.js';
import { criarSessao } from '../src/modules/pacientes.js';
import { gerarCpf, PACIENTES_DEMO } from '../src/modules/siga-adapter.js';
import { migrarDoLegado } from '../src/modules/migracao.js';
import { CircuitBreaker } from '../src/modules/notificacoes.js';

let app, base;
const cfgTeste = { demo: true, backoffUnidadeMs: 1, circuitoAbertoMs: 60_000, smsTimeoutMs: 200 };

async function req(metodo, caminho, { corpo, sid, sidUbs } = {}) {
  const cookies = [sid && `sid=${sid}`, sidUbs && `sid_ubs=${sidUbs}`].filter(Boolean).join('; ');
  const r = await fetch(base + caminho, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'consulta-facil', ...(cookies ? { Cookie: cookies } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: r.status, dados: await r.json(), cookie: r.headers.get('set-cookie') };
}

/** Cria um paciente direto no banco e devolve um token de sessão. */
let seq = 0;
function novoPaciente() {
  seq += 1;
  const cpf = gerarCpf(String(500000000 + seq));
  const r = app.db.prepare('INSERT INTO pacientes (cpf, nascimento, nome, telefone) VALUES (?, ?, ?, ?)').run(cpf, '1980-01-01', `Paciente ${seq}`, '11900000000');
  return criarSessao(app.db, app.cfg, { pacienteId: Number(r.lastInsertRowid), perfil: 'cidadao' });
}

function vagaLivre(especialidade = 'Clínico Geral') {
  return app.db.prepare(`SELECT v.id FROM vagas v JOIN profissionais p ON p.id = v.profissional_id JOIN ubs u ON u.id = p.ubs_id
                         WHERE p.especialidade = ? AND u.ativa = 1 AND v.disponiveis > 0 AND v.inicio > ? ORDER BY v.id`).all(especialidade, new Date().toISOString());
}

before(async () => {
  app = criarApp({ dbPath: ':memory:', iniciarWorker: false, config: cfgTeste });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.fechar());

describe('RA01 — acesso sem e-mail', () => {
  test('entra só com CPF, data de nascimento e código por SMS', async () => {
    const p = PACIENTES_DEMO[0];
    const [d, m, a] = p.nasc.split('/');
    const r1 = await req('POST', '/api/auth/codigo', { corpo: { cpf: p.cpf, nascimento: `${a}-${m}-${d}` } });
    assert.equal(r1.status, 200);
    assert.match(r1.dados.codigoDemo, /^\d{6}$/);
    const r2 = await req('POST', '/api/auth/entrar', { corpo: { cpf: p.cpf, codigo: r1.dados.codigoDemo } });
    assert.equal(r2.status, 200);
    assert.match(r2.cookie, /sid=[\w-]+\.[\w-]+; HttpOnly/);
  });

  test('data de nascimento errada não revela se o CPF existe', async () => {
    const r = await req('POST', '/api/auth/codigo', { corpo: { cpf: PACIENTES_DEMO[0].cpf, nascimento: '2000-01-01' } });
    const r2 = await req('POST', '/api/auth/codigo', { corpo: { cpf: gerarCpf('999888777'), nascimento: '2000-01-01' } });
    assert.equal(r.status, 404);
    assert.equal(r.dados.erro, r2.dados.erro);
  });

  test('CPF inválido é recusado com mensagem clara', async () => {
    const r = await req('POST', '/api/auth/codigo', { corpo: { cpf: '111.111.111-11', nascimento: '2000-01-01' } });
    assert.equal(r.status, 400);
  });
});

describe('RF01 — agendar (cadeia de rastreabilidade: última vaga)', () => {
  test('100 requisições simultâneas para 1 vaga: exatamente 1 confirmação, 99 recusas, 0 duplicados', async () => {
    const vaga = vagaLivre()[0].id;
    const sessoes = Array.from({ length: 100 }, novoPaciente);
    const respostas = await Promise.all(sessoes.map((sid, i) =>
      req('POST', '/api/consultas', { sid, corpo: { vagaId: vaga, chave: `chave-concorrencia-${i}` } })));
    const ok = respostas.filter((r) => r.dados.ok === true).length;
    const recusas = respostas.filter((r) => r.dados.motivo === 'vaga_esgotada');
    assert.equal(ok, 1);
    assert.equal(recusas.length, 99);
    assert.ok(recusas[0].dados.mensagem.startsWith('Esta vaga acabou'));
    const n = app.db.prepare("SELECT COUNT(*) AS n FROM consultas WHERE vaga_id = ? AND status = 'confirmada'").get(vaga).n;
    assert.equal(n, 1);
    assert.equal(app.db.prepare('SELECT disponiveis FROM vagas WHERE id = ?').get(vaga).disponiveis, 0);
  });

  test('restrição de unicidade no banco barra uma 2ª consulta confirmada mesmo se o código falhar', () => {
    const c = app.db.prepare("SELECT vaga_id, paciente_id FROM consultas WHERE status = 'confirmada' LIMIT 1").get();
    assert.throws(() => app.db.prepare("INSERT INTO consultas (vaga_id, paciente_id, status, criada_em) VALUES (?, ?, 'confirmada', 'x')").run(c.vaga_id, c.paciente_id), /UNIQUE/);
  });

  test('duplo clique com a mesma chave não gera duas reservas', async () => {
    const sid = novoPaciente();
    const vaga = vagaLivre()[0].id;
    const [a, b] = await Promise.all([1, 2].map(() => req('POST', '/api/consultas', { sid, corpo: { vagaId: vaga, chave: 'mesma-chave-duplo-clique' } })));
    assert.equal(a.dados.ok && b.dados.ok, true);
    assert.equal(a.dados.consulta.id, b.dados.consulta.id);
  });

  test('sem vagas: paciente entra na fila e vê a posição', async () => {
    const sid1 = novoPaciente(), sid2 = novoPaciente();
    const r1 = await req('POST', '/api/fila', { sid: sid1, corpo: { especialidade: 'Pediatria', ubsId: 1 } });
    const r2 = await req('POST', '/api/fila', { sid: sid2, corpo: { especialidade: 'Pediatria', ubsId: 1 } });
    assert.equal(r1.dados.posicao, 1);
    assert.equal(r2.dados.posicao, 2);
  });

  test('provedor de SMS fora do ar: agendamento é salvo, SMS fica na fila e o circuito abre', async () => {
    app.provedor.definirModo('fora_do_ar');
    const sid = novoPaciente();
    const r = await req('POST', '/api/consultas', { sid, corpo: { vagaId: vagaLivre()[0].id, chave: 'chave-sms-fora-01' } });
    assert.equal(r.dados.ok, true);
    await app.worker.ciclo();
    const pend = app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pendente' AND tentativas > 0").get().n;
    assert.ok(pend > 0, 'mensagens devem ficar pendentes para nova tentativa');
    assert.equal(app.db.prepare('SELECT status FROM consultas WHERE id = ?').get(r.dados.consulta.id).status, 'confirmada');
    assert.equal(app.worker.circuito.estado, 'aberto', 'após 5 falhas seguidas o circuito abre');
    const chamadasAntes = app.provedor.chamadas;
    await app.worker.ciclo();
    assert.equal(app.provedor.chamadas, chamadasAntes, 'circuito aberto: nenhuma chamada nova ao provedor');
    app.provedor.definirModo('normal');
    app.worker.circuito.sucesso();
  });
});

describe('RF02 — cancelar e remarcar', () => {
  test('cancelar libera a vaga e avisa o 1º da fila; cancelar de novo não libera duas vezes', async () => {
    const sid = novoPaciente();
    const fila = novoPaciente();
    const vaga = vagaLivre('Ginecologia')[0].id;
    const r = await req('POST', '/api/consultas', { sid, corpo: { vagaId: vaga, chave: 'chave-cancelar-01' } });
    const ubsId = r.dados.consulta.ubs_id;
    await req('POST', '/api/fila', { sid: fila, corpo: { especialidade: 'Ginecologia', ubsId } });
    const c1 = await req('POST', `/api/consultas/${r.dados.consulta.id}/cancelar`, { sid });
    const c2 = await req('POST', `/api/consultas/${r.dados.consulta.id}/cancelar`, { sid });
    assert.equal(c1.dados.ok, true);
    assert.equal(c2.dados.ok, false);
    assert.equal(c2.dados.mensagem, 'Esta consulta já foi cancelada.');
    assert.equal(app.db.prepare('SELECT disponiveis FROM vagas WHERE id = ?').get(vaga).disponiveis, 1);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE tipo = 'vaga_fila'").get().n, 1);
  });

  test('remarcar para vaga já ocupada mantém a consulta original', async () => {
    const sidA = novoPaciente(), sidB = novoPaciente();
    const [v1, v2] = vagaLivre();
    const original = await req('POST', '/api/consultas', { sid: sidA, corpo: { vagaId: v1.id, chave: 'chave-remarcar-a1' } });
    await req('POST', '/api/consultas', { sid: sidB, corpo: { vagaId: v2.id, chave: 'chave-remarcar-b1' } });
    const r = await req('POST', `/api/consultas/${original.dados.consulta.id}/remarcar`, { sid: sidA, corpo: { vagaId: v2.id, chave: 'chave-remarcar-a2' } });
    assert.equal(r.dados.ok, false);
    assert.match(r.dados.mensagem, /original foi mantida/);
    assert.equal(app.db.prepare('SELECT status FROM consultas WHERE id = ?').get(original.dados.consulta.id).status, 'confirmada');
  });

  test('remarcar com sucesso troca a consulta e libera a vaga antiga', async () => {
    const sid = novoPaciente();
    const [v1, v2] = vagaLivre();
    const o = await req('POST', '/api/consultas', { sid, corpo: { vagaId: v1.id, chave: 'chave-remarcar-ok1' } });
    const r = await req('POST', `/api/consultas/${o.dados.consulta.id}/remarcar`, { sid, corpo: { vagaId: v2.id, chave: 'chave-remarcar-ok2' } });
    assert.equal(r.dados.ok, true);
    assert.equal(app.db.prepare('SELECT disponiveis FROM vagas WHERE id = ?').get(v1.id).disponiveis, 1);
    assert.equal(app.db.prepare('SELECT disponiveis FROM vagas WHERE id = ?').get(v2.id).disponiveis, 0);
  });

  test('paciente não acessa consulta de outra pessoa', async () => {
    const sidA = novoPaciente(), sidB = novoPaciente();
    const o = await req('POST', '/api/consultas', { sid: sidA, corpo: { vagaId: vagaLivre()[0].id, chave: 'chave-privacidade-1' } });
    const r = await req('POST', `/api/consultas/${o.dados.consulta.id}/cancelar`, { sid: sidB });
    assert.equal(r.status, 404);
  });
});

describe('Várias instâncias do servidor (Vercel)', () => {
  test('login feito numa instância vale em outra, com banco separado (painel não "fecha")', async () => {
    const outra = criarApp({ dbPath: ':memory:', iniciarWorker: false, config: cfgTeste });
    await new Promise((r) => outra.server.listen(0, r));
    const base2 = `http://127.0.0.1:${outra.server.address().port}`;
    try {
      // Painel: entra na instância 1, consulta na instância 2
      const login = await req('POST', '/api/painel/entrar', { corpo: { senha: app.cfg.painelSenha } });
      const sidUbs = login.cookie.match(/sid_ubs=([\w.-]+)/)[1];
      const r1 = await fetch(`${base2}/api/painel/resumo`, { headers: { Cookie: `sid_ubs=${sidUbs}` } });
      assert.equal(r1.status, 200);

      // Cidadão: pede o código na instância 1 e confirma na instância 2 (cookie com o desafio assinado)
      const p = PACIENTES_DEMO[1];
      const [d, m, a] = p.nasc.split('/');
      const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'consulta-facil' };
      const c = await fetch(`${base}/api/auth/codigo`, { method: 'POST', headers: H, body: JSON.stringify({ cpf: p.cpf, nascimento: `${a}-${m}-${d}` }) });
      const otp = c.headers.get('set-cookie').match(/otp=([\w.-]+)/)[1];
      const { codigoDemo } = await c.json();
      const e = await fetch(`${base2}/api/auth/entrar`, { method: 'POST', headers: { ...H, Cookie: `otp=${otp}` }, body: JSON.stringify({ cpf: p.cpf, codigo: codigoDemo }) });
      assert.equal(e.status, 200);
      const sid = e.headers.get('set-cookie').match(/sid=([\w-]+\.[\w-]+)/)[1];
      const eu = await fetch(`${base}/api/eu`, { headers: { Cookie: `sid=${sid}` } });
      assert.equal(eu.status, 200, 'a sessão criada na instância 2 vale na instância 1');

      // Sair revoga o token
      await fetch(`${base}/api/auth/sair`, { method: 'POST', headers: { ...H, Cookie: `sid=${sid}` } });
      assert.equal((await fetch(`${base}/api/eu`, { headers: { Cookie: `sid=${sid}` } })).status, 401);
    } finally {
      await outra.fechar();
    }
  });

  test('token adulterado é recusado', async () => {
    const login = await req('POST', '/api/painel/entrar', { corpo: { senha: app.cfg.painelSenha } });
    const sidUbs = login.cookie.match(/sid_ubs=([\w.-]+)/)[1];
    const [corpo, assinatura] = sidUbs.split('.');
    const falso = Buffer.from(JSON.stringify({ t: 'sessao', perfil: 'ubs', exp: Date.now() + 1e9 })).toString('base64url');
    const r = await req('GET', '/api/painel/resumo', { sidUbs: `${falso}.${assinatura}` });
    assert.equal(r.status, 401);
    assert.ok(corpo);
  });
});

describe('Operação', () => {
  test('migração do legado: ensaio não grava e a efetiva é idempotente', () => {
    const contar = () => app.db.prepare('SELECT COUNT(*) AS n FROM vagas').get().n;
    const antes = contar();
    const ensaio = migrarDoLegado(app.db, app.adapter, { dryRun: true });
    assert.equal(ensaio.modo, 'ensaio');
    assert.equal(ensaio.reconciliacao.ok, true);
    assert.equal(contar(), antes);
    const efetiva = migrarDoLegado(app.db, app.adapter, { dryRun: false });
    assert.equal(efetiva.inseridos.vagas, 0);
    assert.equal(contar(), antes);
  });

  test('painel exige login da equipe e mostra 0 reservas duplicadas', async () => {
    const negado = await req('GET', '/api/painel/resumo');
    assert.equal(negado.status, 401);
    const login = await req('POST', '/api/painel/entrar', { corpo: { senha: app.cfg.painelSenha } });
    const sidUbs = login.cookie.match(/sid_ubs=([\w.-]+)/)[1];
    const r = await req('GET', '/api/painel/resumo', { sidUbs });
    assert.equal(r.dados.integridade.vagasComReservaDuplicada, 0);
    assert.ok(r.dados.jornada.tentativas > 0);
  });

  test('POST sem cabeçalho anti-CSRF é recusado', async () => {
    const r = await fetch(`${base}/api/auth/sair`, { method: 'POST' });
    assert.equal(r.status, 403);
  });

  test('circuit breaker: meio-aberto libera uma chamada de prova e reabre se falhar', () => {
    let t = 0;
    const cb = new CircuitBreaker({ falhasParaAbrir: 5, abertoMs: 60_000, relogio: () => t });
    for (let i = 0; i < 5; i++) cb.falha();
    assert.equal(cb.permite(), false);
    t = 60_000;
    assert.equal(cb.permite(), true);
    assert.equal(cb.permite(), false, 'só uma chamada de prova');
    cb.falha();
    assert.equal(cb.estado, 'aberto');
  });
});
