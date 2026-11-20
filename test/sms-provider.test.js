// Provedor real (Twilio) testado contra um servidor falso que imita a API do Twilio:
// nenhum SMS de verdade é enviado e não é preciso credencial.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { criarProvedor, SmsProviderTwilio, telefoneInternacional } from '../src/modules/sms-provider.js';
import { abrirBanco } from '../src/db.js';
import { WorkerNotificacoes, enfileirar } from '../src/modules/notificacoes.js';

let falso, base, pedidos = [], resposta = { status: 201, corpo: { sid: 'SM123' } };

before(async () => {
  falso = createServer((req, res) => {
    let dados = '';
    req.on('data', (c) => { dados += c; });
    req.on('end', () => {
      pedidos.push({ url: req.url, auth: req.headers.authorization, corpo: new URLSearchParams(dados), bruto: dados });
      res.writeHead(resposta.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resposta.corpo));
    });
  });
  await new Promise((r) => falso.listen(0, r));
  base = `http://127.0.0.1:${falso.address().port}`;
});
after(() => new Promise((r) => falso.close(r)));

const env = (extra = {}) => ({
  SMS_PROVEDOR: 'twilio', TWILIO_ACCOUNT_SID: 'ACteste', TWILIO_AUTH_TOKEN: 'segredo-teste',
  TWILIO_FROM: '+15005550006', TWILIO_API_BASE: base, ...extra,
});
const CFG_WORKER = { smsTimeoutMs: 2000, smsMaxTentativas: 5, circuitoFalhasParaAbrir: 5, circuitoAbertoMs: 60_000, lembreteHorasAntes: 24 };

function bancoComPaciente() {
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO pacientes (cpf, nascimento, nome, telefone) VALUES ('1', '2000-01-01', 'Teste', '11988881001')").run();
  return db;
}

describe('Provedor de SMS', () => {
  test('sem configuração completa, continua no simulado e explica o que falta', () => {
    const { provedor, aviso } = criarProvedor({ SMS_PROVEDOR: 'twilio', TWILIO_ACCOUNT_SID: 'AC1' });
    assert.equal(provedor.nome, 'simulado');
    assert.match(aviso, /TWILIO_AUTH_TOKEN/);
    assert.equal(criarProvedor({}).provedor.nome, 'simulado');
  });

  test('converte celular brasileiro para o formato internacional', () => {
    assert.equal(telefoneInternacional('(11) 98888-1001'), '+5511988881001');
    assert.equal(telefoneInternacional('5511988881001'), '+5511988881001');
    assert.throws(() => telefoneInternacional('123'), /inválido/);
  });

  test('envia SMS pela API do Twilio com autenticação, remetente e destino corretos', async () => {
    pedidos = [];
    resposta = { status: 201, corpo: { sid: 'SM123' } };
    const { provedor } = criarProvedor(env());
    assert.ok(provedor instanceof SmsProviderTwilio);
    const r = await provedor.enviar('11988881001', 'Olá');
    assert.equal(r.id, 'SM123');
    assert.equal(pedidos[0].url, '/2010-04-01/Accounts/ACteste/Messages.json');
    assert.equal(pedidos[0].auth, `Basic ${Buffer.from('ACteste:segredo-teste').toString('base64')}`);
    assert.equal(pedidos[0].corpo.get('To'), '+5511988881001');
    assert.equal(pedidos[0].corpo.get('From'), '+15005550006');
    assert.equal(pedidos[0].corpo.get('Body'), 'Olá');
  });

  test('SMS Gateway (gratuito, celular Android) envia JSON com autenticação básica', async () => {
    pedidos = [];
    resposta = { status: 202, corpo: { id: 'msg-1', state: 'Pending' } };
    const faltando = criarProvedor({ SMS_PROVEDOR: 'smsgate', SMSGATE_USUARIO: 'u' });
    assert.equal(faltando.provedor.nome, 'simulado');
    assert.match(faltando.aviso, /SMSGATE_SENHA/);

    const { provedor } = criarProvedor({ SMS_PROVEDOR: 'smsgate', SMSGATE_USUARIO: 'usuario', SMSGATE_SENHA: 'senha', SMSGATE_URL: `${base}/3rdparty/v1/` });
    assert.equal(provedor.nome, 'smsgate');
    const r = await provedor.enviar('(11) 98888-1001', 'Seu código é 123456');
    assert.equal(r.id, 'msg-1');
    assert.equal(pedidos[0].url, '/3rdparty/v1/message');
    assert.equal(pedidos[0].auth, `Basic ${Buffer.from('usuario:senha').toString('base64')}`);
    assert.deepEqual(JSON.parse(pedidos[0].bruto), { message: 'Seu código é 123456', phoneNumbers: ['+5511988881001'] });
  });

  test('WhatsApp usa o prefixo whatsapp: no remetente e no destino', async () => {
    pedidos = [];
    resposta = { status: 201, corpo: { sid: 'SM456' } };
    const { provedor } = criarProvedor(env({ SMS_CANAL: 'whatsapp', TWILIO_FROM: 'whatsapp:+14155238886' }));
    await provedor.enviar('11988881001', 'Olá');
    assert.equal(pedidos[0].corpo.get('To'), 'whatsapp:+5511988881001');
    assert.equal(pedidos[0].corpo.get('From'), 'whatsapp:+14155238886');
  });

  test('número recusado (4xx) é falha permanente: não retenta e não abre o circuit breaker', async () => {
    resposta = { status: 400, corpo: { code: 21608, message: 'Número não verificado na conta de teste' } };
    const db = bancoComPaciente();
    const worker = new WorkerNotificacoes(db, criarProvedor(env()).provedor, { ...CFG_WORKER, backoffUnidadeMs: 1 });
    for (let i = 0; i < 6; i++) enfileirar(db, { tipo: 'confirmacao', pacienteId: 1, telefone: '11988881001', mensagem: `m${i}` });
    await worker.processarOutbox();
    const st = db.prepare('SELECT status, tentativas, ultimo_erro FROM outbox').all();
    assert.ok(st.every((m) => m.status === 'falhou' && m.tentativas === 1), 'vai direto para a lista da UBS ligar');
    assert.match(st[0].ultimo_erro, /21608/);
    assert.equal(worker.circuito.estado, 'fechado');
    db.close();
  });

  test('provedor fora do ar (5xx) é falha temporária: retenta com espera crescente', async () => {
    resposta = { status: 503, corpo: { message: 'Service Unavailable' } };
    const db = bancoComPaciente();
    const worker = new WorkerNotificacoes(db, criarProvedor(env()).provedor, { ...CFG_WORKER, backoffUnidadeMs: 1000 });
    enfileirar(db, { tipo: 'confirmacao', pacienteId: 1, telefone: '11988881001', mensagem: 'x' });
    await worker.processarOutbox();
    const m = db.prepare('SELECT status, tentativas FROM outbox').get();
    assert.equal(m.status, 'pendente');
    assert.equal(m.tentativas, 1);
    db.close();
  });
});
