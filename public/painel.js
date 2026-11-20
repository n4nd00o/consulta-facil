// Painel da equipe da UBS / Secretaria. Heurísticas de Nielsen indicadas como [H1]…[H10].
import { api, el, fmtDataHora, configurarAjustes, confirmar, comEspera } from './comum.js';

const $ = (id) => document.getElementById(id);
const ATUALIZAR_MS = 3000;
let demo = false;
let timer = null;

configurarAjustes();

function aviso(texto, tipo = 'info') {
  $('aviso').hidden = !texto;
  $('aviso').className = `aviso ${tipo}`;
  $('aviso').textContent = texto ?? '';
}

async function seguro(fn, botao) {
  try {
    await comEspera(botao, fn);
  } catch (e) {
    if (e.status === 401) {
      clearInterval(timer);
      $('painel').hidden = true;
      $('login').hidden = false;
      aviso('Sua sessão terminou. Entre novamente.', 'erro');
      return;
    }
    aviso(e.message, 'erro');
  }
}

$('form-login').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const erro = $('senha-erro');
  erro.hidden = true;
  $('senha').removeAttribute('aria-invalid');
  if (!$('senha').value) {
    erro.textContent = 'Digite a senha do painel.';
    erro.hidden = false;
    $('senha').setAttribute('aria-invalid', 'true');
    $('senha').focus();
    return;
  }
  seguro(async () => {
    try {
      await api('POST', '/api/painel/entrar', { senha: $('senha').value });
    } catch (e) {
      if (e.status !== 401) throw e;
      erro.textContent = 'Senha incorreta. Confira com a coordenação da UBS.';
      erro.hidden = false;
      $('senha').setAttribute('aria-invalid', 'true');
      $('senha').select();
      return;
    }
    $('senha').value = '';
    aviso('');
    iniciar();
  }, ev.submitter);
});

function indicador(rotulo, valor, det, ruim = false) {
  return el('div', { class: `indicador ${ruim ? 'ruim' : ''}` },
    el('div', { class: 'rotulo' }, rotulo), el('div', { class: 'valor' }, valor), el('div', { class: 'det' }, det));
}

const ESTADOS_CIRCUITO = {
  fechado: ['', 'Funcionando normalmente.'],
  aberto: ['aberto', 'Envios pausados: o provedor falhou 5 vezes seguidas. As mensagens esperam na fila e nenhuma consulta é afetada.'],
  'meio-aberto': ['meio', 'Testando o provedor com uma mensagem antes de voltar ao normal.'],
};

/** [H1] Estado do sistema sempre visível, com a hora da última atualização. */
async function atualizarResumo() {
  const r = await api('GET', '/api/painel/resumo');
  const j = r.jornada, n = r.notificacoes;
  $('indicadores').replaceChildren(
    indicador('Agendamentos concluídos', j.percentualConcluidos === null ? '—' : `${j.percentualConcluidos}%`,
      `${j.concluidos} de ${j.tentativas} tentativas · ${j.vagaEsgotada} encontraram a vaga ocupada · ${j.erros} com erro`, j.erros > 0),
    indicador('Consultas marcadas', r.consultas.confirmadas,
      `${r.consultas.presencasConfirmadas} com presença confirmada · ${r.consultas.canceladas} canceladas (${r.consultas.cancelamentosTardios} tardias)`),
    indicador('Vagas com duas reservas', r.integridade.vagasComReservaDuplicada, 'Precisa ser sempre 0', r.integridade.vagasComReservaDuplicada > 0),
    indicador('SMS enviados', n.enviadas, `${n.pendentes} aguardando · ${n.falharam} não chegaram · ${n.contatados} pacientes contatados`, n.falharam > 0),
    indicador('Tempo de resposta (95%)', `${r.desempenho.p95ms} ms`, `Meta: até 3 segundos · ${r.desempenho.requisicoes} acessos · ${r.desempenho.erros5xx} erros`, r.desempenho.p95ms > 3000),
    indicador('Alertas abertos', r.alertasAbertos, 'Cancelamentos tardios repetidos', r.alertasAbertos > 0),
  );
  const c = n.circuito;
  const [classe, texto] = ESTADOS_CIRCUITO[c.estado];
  $('circuito').className = `circuito ${classe}`;
  $('circuito').textContent = c.estado === 'aberto'
    ? `${texto} Nova tentativa às ${new Date(c.abertoAte).toLocaleTimeString('pt-BR')}.`
    : texto;
  $('modo-sms').value = n.modoProvedor;
  const nomes = {
    simulado: 'Simulado (nenhuma mensagem sai do servidor)',
    smsgate: 'SMS Gateway (celular Android) — SMS real e gratuito',
    'twilio-sms': 'Twilio — SMS real', 'twilio-whatsapp': 'Twilio — WhatsApp real',
  };
  $('provedor-sms').textContent = `Provedor: ${nomes[n.provedor] ?? n.provedor}`;
  $('aviso-provedor').hidden = !n.avisoProvedor;
  $('aviso-provedor').textContent = n.avisoProvedor ?? '';
  $('atualizado').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
}

function linhaVazia(colunas, texto) {
  return [el('tr', {}, el('td', { colspan: colunas, class: 'estado-off' }, texto))];
}

async function atualizarUnidades() {
  const lista = await api('GET', '/api/painel/unidades');
  $('unidades').replaceChildren(...lista.map((u) => el('tr', {},
    el('td', {}, u.nome), el('td', {}, u.vagas_livres),
    el('td', { class: u.ativa ? 'estado-on' : 'estado-off' }, u.ativa ? 'Ativa' : 'Desligada'),
    el('td', {}, el('button', { type: 'button', class: `botao ${u.ativa ? 'perigo' : ''}`, onclick: (e) => alternarUnidade(u, e.currentTarget) },
      u.ativa ? 'Desligar' : 'Ativar')))));
  const sel = $('ubs-agenda');
  if (!sel.options.length) sel.replaceChildren(...lista.map((u) => el('option', { value: u.id }, u.nome)));
}

/** [H5] Desligar uma unidade afeta o cidadão: pede confirmação e explica o efeito. */
async function alternarUnidade(u, botao) {
  if (u.ativa) {
    const ok = await confirmar({
      titulo: `Desligar a ${u.nome}?`,
      texto: 'Os cidadãos deixam de ver esta unidade no app agora mesmo. As consultas já marcadas continuam valendo e nenhum dado é apagado. Você pode ativar de novo a qualquer momento.',
      confirmar: 'Desligar unidade', cancelar: 'Manter ativa', perigo: true,
    });
    if (!ok) return;
  }
  await seguro(async () => {
    await api('POST', `/api/painel/unidades/${u.id}/flag`, { ativa: !u.ativa });
    await atualizarUnidades();
    aviso(u.ativa ? `${u.nome} foi desligada no app do cidadão.` : `${u.nome} está ativa no app do cidadão.`);
  }, botao);
}

// Não redesenha uma tabela enquanto alguém está usando o teclado dentro dela (o foco se perderia).
const emUso = (id) => $(id).contains(document.activeElement);

async function atualizarFalhas() {
  if (emUso('falhas')) return;
  const lista = await api('GET', '/api/painel/sms-falhas');
  $('falhas').replaceChildren(...(lista.length ? lista.map((f) => el('tr', {},
    el('td', {}, f.nome ?? '—'), el('td', {}, f.telefone), el('td', {}, f.mensagem), el('td', {}, f.ultimo_erro ?? ''),
    el('td', {}, el('button', { type: 'button', class: 'botao', onclick: (e) => seguro(async () => {
      await api('POST', `/api/painel/sms-falhas/${f.id}/contatado`);
      await atualizarFalhas();
      aviso(`Contato com ${f.nome ?? 'o paciente'} registrado.`);
    }, e.currentTarget) }, 'Já liguei')))) : linhaVazia(5, 'Nenhuma mensagem pendente de contato.')));
}

async function atualizarAlertas() {
  if (emUso('alertas')) return;
  const lista = await api('GET', '/api/painel/alertas');
  $('alertas').replaceChildren(...(lista.length ? lista.map((a) => el('tr', {},
    el('td', {}, a.ubs ?? '—'), el('td', {}, a.paciente ?? '—'), el('td', {}, a.telefone ?? ''), el('td', {}, a.mensagem),
    el('td', {}, el('button', { type: 'button', class: 'botao', onclick: (e) => seguro(async () => {
      await api('POST', `/api/painel/alertas/${a.id}/resolver`);
      await atualizarAlertas();
    }, e.currentTarget) }, 'Marcar como resolvido')))) : linhaVazia(5, 'Nenhum alerta.')));
}

async function atualizarAgenda() {
  const ubs = $('ubs-agenda').value;
  if (!ubs) return;
  const lista = await api('GET', `/api/painel/agenda/${ubs}`);
  $('agenda').replaceChildren(...(lista.length ? lista.map((c) => el('tr', {},
    el('td', {}, fmtDataHora(c.inicio)), el('td', {}, c.especialidade), el('td', {}, c.profissional),
    el('td', {}, c.paciente, c.origem === 'app'
      ? el('span', { class: 'pre-cadastro' }, 'Pré-cadastro pelo app: conferir documento e Cartão SUS')
      : null),
    el('td', {}, c.cpf),
    el('td', { class: c.presenca_confirmada ? 'estado-on' : 'estado-off' }, c.presenca_confirmada ? 'Confirmada' : 'Aguardando'))) :
    linhaVazia(6, 'Nenhuma consulta marcada pelo app nesta unidade.')));
}

async function atualizarCaixa() {
  if (!demo) return;
  const lista = await api('GET', '/api/painel/simulacao/caixa-sms');
  $('caixa-wrap').hidden = false;
  $('caixa').replaceChildren(...(lista.length ? lista.slice(0, 6).map((m) => el('tr', {},
    el('td', {}, new Date(m.em).toLocaleTimeString('pt-BR')), el('td', {}, m.telefone), el('td', {}, m.texto))) :
    linhaVazia(3, 'Nenhum SMS enviado ainda.')));
}

$('modo-sms').addEventListener('change', (e) => seguro(async () => {
  await api('POST', '/api/painel/simulacao/sms', { modo: e.target.value });
  aviso(`Simulação: provedor de SMS agora está "${e.target.selectedOptions[0].textContent}".`);
  await atualizarResumo();
}));
$('ubs-agenda').addEventListener('change', () => seguro(atualizarAgenda));
$('reenviar').addEventListener('click', (e) => seguro(async () => {
  const r = await api('POST', '/api/painel/sms-falhas/reenviar');
  aviso(r.reenfileiradas ? `${r.reenfileiradas} mensagem(ns) voltaram para a fila de envio.` : 'Não havia mensagens para reenviar.');
  await atualizarFalhas();
}, e.currentTarget));

/** [H2] Relatório da migração em linguagem de conferência, não em JSON. */
function mostrarRelatorio(r) {
  const ok = r.reconciliacao.ok;
  const linhas = [
    ['Tipo', r.modo === 'ensaio' ? 'Ensaio (nada foi gravado)' : 'Migração real'],
    ['Lidos do SIGA-Saúde', `${r.lidos.unidades} unidades, ${r.lidos.profissionais} profissionais, ${r.lidos.horarios} horários (${r.lidos.horariosLivres} livres)`],
    ['Novos no Consulta Fácil', `${r.inseridos.unidades} unidades, ${r.inseridos.profissionais} profissionais, ${r.inseridos.vagas} horários`],
    ['Já existiam (ignorados)', `${r.jaExistentes} horários`],
    ['Conferência', `${r.reconciliacao.horariosNoLegado} horários no legado × ${r.reconciliacao.horariosNoNovo} no novo sistema — ${ok ? 'confere' : 'NÃO confere'}`],
    ['Divergências', r.divergencias.length ? r.divergencias.join('; ') : 'Nenhuma'],
  ];
  $('relatorio').replaceChildren(el('div', { class: `aviso ${ok ? 'info' : 'erro'}` }, ok ? 'Conferência sem divergências.' : 'Há divergências: não prossiga sem revisar.'),
    el('dl', { class: 'ficha' }, ...linhas.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
}
$('ensaio').addEventListener('click', (e) => seguro(async () => mostrarRelatorio(await api('POST', '/api/painel/migracao', { dryRun: true })), e.currentTarget));
$('migrar').addEventListener('click', async (e) => {
  const botao = e.currentTarget;
  const ok = await confirmar({
    titulo: 'Fazer a migração real?',
    texto: 'Os horários do SIGA-Saúde serão gravados no Consulta Fácil. Nada é apagado e horários já migrados são ignorados. Recomendamos fazer o ensaio antes.',
    confirmar: 'Migrar agora', cancelar: 'Voltar',
  });
  if (ok) seguro(async () => mostrarRelatorio(await api('POST', '/api/painel/migracao', { dryRun: false })), botao);
});

async function ciclo() {
  await Promise.all([atualizarResumo(), atualizarFalhas(), atualizarAlertas(), atualizarCaixa()]);
}

async function iniciar() {
  $('login').hidden = true;
  $('painel').hidden = false;
  $('simulacao').hidden = !demo;
  await seguro(async () => { await atualizarUnidades(); await ciclo(); await atualizarAgenda(); });
  clearInterval(timer);
  timer = setInterval(() => seguro(async () => { await ciclo(); await atualizarAgenda(); }), ATUALIZAR_MS);
}

(async () => {
  try { demo = (await api('GET', '/api/config')).demo; } catch { /* segue sem modo demo */ }
  try {
    await api('GET', '/api/painel/resumo');
    iniciar();
  } catch {
    $('login').hidden = false;
    if (demo) aviso('Demonstração: a senha do painel é ubs123.');
    $('senha').focus();
  }
})();
