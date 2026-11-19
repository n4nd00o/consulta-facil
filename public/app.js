// Consulta Fácil — app do cidadão (sem frameworks; funciona em celulares simples).
// Heurísticas de Nielsen indicadas nos comentários como [H1]…[H10].
import {
  api, el, icone, fmtDataHora, fmtHora, fmtCurta, novaChave,
  configurarAjustes, confirmar, comEspera, cpfValido,
} from './comum.js';

const $ = (id) => document.getElementById(id);
const REENVIO_SEGUNDOS = 30;
const HORAS_LEMBRETE = 24;
const HORAS_TARDIO = 2;
const DEMO_ATUALIZAR_MS = 2000;

const estado = {
  cpf: '', nascimento: '', logado: false, tela: null,
  especialidade: null, ubs: null, horarios: [], dia: null, vaga: null, chave: null,
  remarcando: null, ultimoCancelamento: null, mostrarFila: false,
};
let timerReenvio = null;
let demo = false;

configurarAjustes();

// ======================================================================= navegação
// [H4] Consistência: todas as telas têm o mesmo cabeçalho (voltar, título, texto) e as mesmas abas.
const META = {
  entrar: { titulo: 'Consulta Fácil' },
  codigo: { titulo: 'Entrar', voltar: 'entrar' },
  inicio: { titulo: 'Consulta Fácil', aba: 'inicio' },
  especialidade: { titulo: 'Agendar', voltar: 'inicio', aba: 'agendar' },
  horario: { titulo: 'Agendar', voltar: () => (estado.remarcando ? 'consultas' : 'especialidade'), aba: 'agendar' },
  confirmar: { titulo: 'Agendar', voltar: 'horario', aba: 'agendar' },
  ok: { titulo: 'Agendar', voltar: 'inicio', aba: 'agendar' },
  consultas: { titulo: 'Minhas consultas', voltar: 'inicio', aba: 'consultas' },
};

function mostrar(tela) {
  estado.tela = tela;
  const meta = META[tela];
  document.querySelectorAll('.tela').forEach((s) => { s.hidden = s.id !== `tela-${tela}`; });
  const titulo = estado.remarcando && ['horario', 'confirmar'].includes(tela) ? 'Remarcar' : meta.titulo;
  $('app-titulo').textContent = titulo;
  $('voltar').hidden = !meta.voltar;
  $('app-logo').hidden = Boolean(meta.voltar);
  $('abas').hidden = !estado.logado;
  document.querySelectorAll('#abas [data-aba]').forEach((b) => {
    if (b.dataset.aba === meta.aba) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('conteudo').scrollTop = 0;
  window.scrollTo(0, 0);
  document.querySelector(`#tela-${tela} h1`)?.focus({ preventScroll: true });
}

function destinoVoltar() {
  const v = META[estado.tela]?.voltar;
  return typeof v === 'function' ? v() : v;
}

function ir(destino) {
  aviso('');
  const acoes = {
    entrar: () => mostrar('entrar'),
    inicio: irInicio,
    especialidade: irEspecialidades,
    horario: irHorario,
    consultas: irConsultas,
  };
  executar(null, acoes[destino] ?? (() => mostrar(destino)));
}

$('voltar').addEventListener('click', () => { const d = destinoVoltar(); if (d) ir(d); });
document.querySelectorAll('[data-voltar]').forEach((b) => b.addEventListener('click', () => { const d = destinoVoltar(); if (d) ir(d); }));
document.querySelectorAll('#abas [data-aba]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.aba === 'agendar') { estado.remarcando = null; ir('especialidade'); } else ir(b.dataset.aba);
}));

// ======================================================================= utilidades
function aviso(texto, tipo = 'info') {
  const a = $('aviso');
  a.hidden = !texto;
  a.className = `aviso ${tipo}`;
  a.textContent = texto ?? '';
}

/** [H9] Erro junto do campo, em linguagem simples, dizendo como resolver. */
function erroCampo(campoIds, idErro, msg) {
  const p = $(idErro);
  p.hidden = !msg;
  p.textContent = msg ?? '';
  for (const id of campoIds) {
    if (msg) $(id).setAttribute('aria-invalid', 'true'); else $(id).removeAttribute('aria-invalid');
  }
  if (msg) $(campoIds[0]).focus();
}

async function executar(botao, fn) {
  try {
    await comEspera(botao, fn);
  } catch (e) {
    if (e.status === 401) {
      estado.logado = false;
      mostrar('entrar');
      aviso('Por segurança, sua sessão terminou. Entre novamente para continuar.', 'erro');
      return;
    }
    aviso(e.message, 'erro');
  }
}

const maiuscula = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const semana = (d) => maiuscula(d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', ''));
const diaMes = (d) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const mesmoDia = (a, b) => a.toDateString() === b.toDateString();

/** "Hoje 16/11 às 17:30", "Amanhã…", "Sex 20/11 às 10:30" — como as pessoas falam. [H2] */
function fmtCartao(iso) {
  const d = new Date(iso);
  const hoje = new Date();
  const amanha = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 1);
  const nome = mesmoDia(d, hoje) ? 'Hoje' : mesmoDia(d, amanha) ? 'Amanhã' : semana(d);
  return `${nome} ${diaMes(d)} às ${fmtHora(iso)}`;
}

const ficha = (pares) => pares.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]);
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

// ======================================================================= passos 1 e 2: entrar
$('cpf').addEventListener('input', (e) => {
  const d = e.target.value.replace(/\D/g, '').slice(0, 11);
  e.target.value = d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
});
for (const [de, para] of [['dia', 'mes'], ['mes', 'ano']]) {
  $(de).addEventListener('input', (e) => { if (e.target.value.replace(/\D/g, '').length === 2) $(para).focus(); });
}

/** [H5] Prevenção de erros: confere CPF e data antes de enviar. */
function validarEntrada() {
  erroCampo(['cpf'], 'cpf-erro', null);
  erroCampo(['dia', 'mes', 'ano'], 'nasc-erro', null);
  const cpf = $('cpf').value.replace(/\D/g, '');
  if (cpf.length !== 11) { erroCampo(['cpf'], 'cpf-erro', `Faltam números no CPF: você digitou ${cpf.length} de 11.`); return null; }
  if (!cpfValido(cpf)) { erroCampo(['cpf'], 'cpf-erro', 'Este CPF não existe. Confira os números no seu documento.'); return null; }
  const dia = Number($('dia').value), mes = Number($('mes').value), ano = Number($('ano').value);
  const dt = new Date(ano, mes - 1, dia);
  const valida = ano > 1900 && dt.getFullYear() === ano && dt.getMonth() === mes - 1 && dt.getDate() === dia && dt <= new Date();
  if (!valida) { erroCampo(['dia', 'mes', 'ano'], 'nasc-erro', 'Data inválida. Exemplo: dia 05, mês 03, ano 1950.'); return null; }
  return { cpf, nascimento: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}` };
}

async function pedirCodigo() {
  const r = await api('POST', '/api/auth/codigo', { cpf: estado.cpf, nascimento: estado.nascimento });
  $('codigo-info').textContent = r.smsEnviado
    ? `Enviamos um SMS para ${r.telefone}. Pode levar até 1 minuto.`
    : `Não conseguimos enviar o SMS para ${r.telefone} agora. Peça um novo código em instantes ou procure sua UBS.`;
  const textoDemo = r.codigoDemo ? `Código de teste do SMS: ${r.codigoDemo}` : '';
  $('codigo-demo').hidden = !r.codigoDemo;
  $('codigo-demo').textContent = textoDemo;
  $('demo-codigo').textContent = textoDemo;
  iniciarContagemReenvio();
}

/** [H3] Controle do usuário: pode pedir outro código, mas sem disparar envios em sequência. */
function iniciarContagemReenvio() {
  clearInterval(timerReenvio);
  let s = REENVIO_SEGUNDOS;
  const b = $('reenviar');
  b.disabled = true;
  b.textContent = `Reenviar código (em ${s} s)`;
  timerReenvio = setInterval(() => {
    s -= 1;
    if (s > 0) { b.textContent = `Reenviar código (em ${s} s)`; return; }
    clearInterval(timerReenvio);
    b.disabled = false;
    b.textContent = 'Reenviar código';
  }, 1000);
}

$('form-cpf').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const dados = validarEntrada();
  if (!dados) return;
  executar(ev.submitter, async () => {
    Object.assign(estado, dados);
    try {
      await pedirCodigo();
    } catch (e) {
      if (e.status === 404) { erroCampo(['cpf'], 'cpf-erro', e.message); return; }
      throw e;
    }
    aviso('');
    $('codigo').value = '';
    erroCampo(['codigo'], 'codigo-erro', null);
    mostrar('codigo');
  });
});

$('reenviar').addEventListener('click', (e) => executar(e.currentTarget, async () => {
  await pedirCodigo();
  aviso('Enviamos um novo código. Use sempre o mais recente.');
}));

$('form-codigo').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const codigo = $('codigo').value.replace(/\D/g, '');
  if (codigo.length !== 6) { erroCampo(['codigo'], 'codigo-erro', 'O código tem 6 números.'); return; }
  executar(ev.submitter, async () => {
    try {
      const r = await api('POST', '/api/auth/entrar', { cpf: estado.cpf, codigo });
      clearInterval(timerReenvio);
      aviso('');
      entrouComo(r.nome);
    } catch (e) {
      if (e.status === 400 || e.status === 429) { erroCampo(['codigo'], 'codigo-erro', e.message); return; }
      throw e;
    }
  });
});

function entrouComo(nome) {
  estado.logado = true;
  $('saudacao').textContent = `Olá, ${nome.split(' ')[0]}! O que você precisa hoje?`;
  return irInicio();
}

$('sair').addEventListener('click', () => executar(null, async () => {
  await api('POST', '/api/auth/sair');
  estado.logado = false;
  estado.ultimoCancelamento = null;
  mostrar('entrar');
  aviso('Você saiu. Seus dados não ficam salvos neste aparelho.');
}));

// ======================================================================= início
async function irInicio() {
  estado.remarcando = null;
  const [consultas, filas] = await Promise.all([api('GET', '/api/consultas'), api('GET', '/api/fila')]);
  const proxima = consultas.find((c) => c.status === 'confirmada' && new Date(c.inicio) > new Date());
  const avisada = filas.find((f) => f.status === 'avisado');
  const cards = [];
  if (avisada) {
    cards.push(el('div', { class: 'cartao ativo' },
      el('p', { class: 'rotulo' }, 'Fila de espera'),
      el('p', { class: 'titulo-cartao' }, `Abriu uma vaga de ${avisada.especialidade}!`),
      el('p', {}, avisada.ubs),
      el('button', { type: 'button', class: 'botao principal bloco', onclick: () => abrirHorarios(avisada.especialidade, { id: avisada.ubs_id, nome: avisada.ubs }) }, 'Ver horários')));
  }
  cards.push(proxima
    ? el('div', { class: 'cartao ativo' },
      el('p', { class: 'rotulo' }, 'Sua próxima consulta'),
      el('p', { class: 'titulo-cartao' }, proxima.especialidade),
      el('p', {}, proxima.ubs),
      el('p', {}, fmtCartao(proxima.inicio)))
    : el('div', { class: 'cartao' }, el('p', {}, 'Você não tem consultas marcadas.')));
  $('destaque').replaceChildren(...cards);
  mostrar('inicio');
}
$('ir-agendar').addEventListener('click', () => { estado.remarcando = null; ir('especialidade'); });
$('ir-consultas').addEventListener('click', () => ir('consultas'));

// ======================================================================= passo 3: atendimento
async function irEspecialidades() {
  const lista = await api('GET', '/api/especialidades');
  $('opcoes-especialidade').replaceChildren(...lista.map((e) => el('button', {
    type: 'button', class: `escolha-btn ${e.vagas ? '' : 'sem-vaga'}`,
    onclick: () => abrirHorarios(e.especialidade, null),
  }, el('span', {},
    el('span', { class: 'nome' }, e.especialidade),
    el('span', { class: 'det' }, e.vagas ? `${plural(e.vagas, 'vaga', 'vagas')} nesta semana` : 'Sem vagas: você pode entrar na fila')),
  icone('seta'))));
  mostrar('especialidade');
}

// ======================================================================= passo 4: unidade, dia e horário
function abrirHorarios(especialidade, ubs) {
  estado.especialidade = especialidade;
  estado.ubs = ubs;
  estado.dia = null;
  estado.mostrarFila = false;
  ir('horario');
}

/** [H6] Tudo à vista numa tela: unidade, dia e horário — inclusive os horários ocupados. */
async function irHorario() {
  $('titulo-horario').textContent = estado.especialidade;
  $('remarcando-info').hidden = !estado.remarcando;
  if (estado.remarcando) $('remarcando-info').textContent = `Escolha o novo horário. A consulta de ${fmtCartao(estado.remarcando.inicio)} só é trocada quando você confirmar.`;
  const unidades = await api('GET', `/api/ubs?especialidade=${encodeURIComponent(estado.especialidade)}`);
  $('opcoes-ubs').replaceChildren(...unidades.map((u) => el('button', {
    type: 'button', class: 'escolha-btn', 'aria-pressed': String(estado.ubs?.id === u.id),
    onclick: () => { estado.ubs = u; estado.dia = null; estado.mostrarFila = false; executar(null, irHorario); },
  }, el('span', {},
    el('span', { class: 'nome' }, u.nome),
    el('span', { class: 'det' }, u.vagas ? `Próximo horário: ${fmtCurta(u.proxima)}` : 'Sem horários livres')))));

  if (estado.ubs) {
    estado.horarios = await api('GET', `/api/horarios?especialidade=${encodeURIComponent(estado.especialidade)}&ubs=${estado.ubs.id}&todos=1`);
  } else {
    estado.horarios = [];
  }
  renderDiasEHoras();
  if (estado.tela !== 'horario') mostrar('horario');
}

function renderDiasEHoras() {
  const temUbs = Boolean(estado.ubs);
  const porDia = Map.groupBy(estado.horarios, (v) => new Date(v.inicio).toDateString());
  const livres = (lista) => lista.filter((v) => v.disponiveis > 0 && v.id !== estado.remarcando?.vaga_id).length;
  if (!estado.dia || !porDia.has(estado.dia)) {
    estado.dia = [...porDia.keys()].find((k) => livres(porDia.get(k)) > 0) ?? [...porDia.keys()][0] ?? null;
  }

  $('bloco-dias').hidden = !temUbs || porDia.size === 0;
  $('opcoes-dia').replaceChildren(...[...porDia.entries()].map(([chave, lista]) => {
    const d = new Date(lista[0].inicio);
    const n = livres(lista);
    return el('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(chave === estado.dia),
      onclick: () => { estado.dia = chave; renderDiasEHoras(); },
    }, `${semana(d)} ${diaMes(d)}`, el('span', { class: 'qtd' }, n ? plural(n, 'vaga', 'vagas') : 'sem vaga'));
  }));

  const doDia = porDia.get(estado.dia) ?? [];
  $('bloco-horas').hidden = !temUbs || doDia.length === 0;
  $('opcoes-hora').replaceChildren(...doDia.map((v) => {
    const minha = v.id === estado.remarcando?.vaga_id;
    const livre = v.disponiveis > 0 && !minha;
    return el('button', {
      type: 'button', class: 'escolha-btn', disabled: !livre,
      'aria-label': `${fmtHora(v.inicio)}, ${minha ? 'sua consulta atual' : livre ? `livre, com ${v.profissional}` : 'sem vaga'}`,
      onclick: () => escolherVaga(v),
    }, el('span', {},
      el('span', { class: 'nome' }, fmtHora(v.inicio)),
      el('span', { class: 'det' }, minha ? 'sua consulta atual' : livre ? `1 vaga · ${v.profissional}` : 'sem vaga')));
  }));

  // Sem nenhum horário livre na unidade (ou a vaga acabou): oferecer a fila de espera [H9]
  const semNada = temUbs && livres(estado.horarios) === 0;
  const blocoFila = $('bloco-fila');
  blocoFila.replaceChildren();
  if (temUbs && !estado.remarcando && (semNada || estado.mostrarFila)) {
    blocoFila.append(el('div', { class: 'cartao' },
      el('p', {}, semNada
        ? `Não há horários livres de ${estado.especialidade} na ${estado.ubs.nome}. Na fila de espera, você recebe um SMS quando alguém cancelar.`
        : 'Não encontrou um horário bom? Entre na fila de espera desta unidade.'),
      el('button', { type: 'button', class: `botao bloco ${semNada ? 'principal' : ''}`, onclick: (e) => executar(e.currentTarget, entrarNaFila) }, 'Entrar na fila de espera')));
  }
}

function escolherVaga(v) {
  estado.vaga = v;
  estado.chave = novaChave(); // uma chave por intenção: clique duplo não cria duas consultas
  const dados = [['Consulta', v.especialidade], ['Quando', fmtDataHora(v.inicio)], ['Onde', v.ubs], ['Profissional', v.profissional]];
  if (estado.remarcando) dados.push(['Substitui', fmtDataHora(estado.remarcando.inicio)]);
  $('confirmacao-dados').replaceChildren(...ficha(dados));
  $('titulo-confirmar').textContent = estado.remarcando ? 'Confira a remarcação' : 'Confira e confirme';
  $('confirmar').textContent = estado.remarcando ? 'Confirmar novo horário' : 'Confirmar consulta';
  aviso('');
  mostrar('confirmar');
}

// ======================================================================= passo 5: confirmar
$('confirmar').addEventListener('click', (e) => executar(e.currentTarget, async () => {
  if (demo && $('demo-outra').checked) {
    // Simulação: alguém confirma a mesma vaga um instante antes
    await api('POST', '/api/demo/outra-pessoa', { vagaId: estado.vaga.id });
    $('demo-outra').checked = false;
  }
  const caminho = estado.remarcando ? `/api/consultas/${estado.remarcando.id}/remarcar` : '/api/consultas';
  const r = await api('POST', caminho, { vagaId: estado.vaga.id, chave: estado.chave });
  if (!r.ok) {
    estado.mostrarFila = true;
    await irHorario();
    mostrar('horario');
    aviso(r.mensagem, 'erro');
    return;
  }
  const c = r.consulta;
  $('ok-titulo').textContent = estado.remarcando ? 'Consulta remarcada' : 'Consulta marcada';
  $('ok-cabeca').querySelector('svg')?.remove();
  $('ok-cabeca').prepend(icone('check', 34));
  $('ok-dados').replaceChildren(...ficha([['Consulta', c.especialidade], ['Quando', fmtDataHora(c.inicio)], ['Onde', c.ubs], ['Profissional', c.profissional]]));
  estado.remarcando = null;
  mostrar('ok');
}));
$('ok-consultas').addEventListener('click', () => ir('consultas'));

async function entrarNaFila() {
  const f = await api('POST', '/api/fila', { especialidade: estado.especialidade, ubsId: estado.ubs.id });
  await irConsultas();
  aviso(`Você entrou na fila de ${f.especialidade} da ${f.ubs}: ${f.posicao}ª posição. Avisaremos por SMS quando abrir uma vaga.`);
}

// ======================================================================= minhas consultas
async function irConsultas() {
  estado.remarcando = null;
  const [consultas, filas] = await Promise.all([api('GET', '/api/consultas'), api('GET', '/api/fila')]);
  const agora = new Date();
  const ativas = consultas.filter((c) => c.status === 'confirmada' && new Date(c.inicio) > agora);
  const outras = consultas.filter((c) => !ativas.includes(c)).reverse().slice(0, 5);
  $('lista-consultas').replaceChildren(...(consultas.length
    ? [...ativas.map((c) => cartaoConsulta(c, true)), ...outras.map((c) => cartaoConsulta(c, false))]
    : [el('div', { class: 'cartao' }, el('p', {}, 'Você ainda não tem consultas.'),
      el('button', { type: 'button', class: 'botao principal bloco', onclick: () => ir('especialidade') }, 'Agendar consulta'))]));
  $('secao-filas').hidden = filas.length === 0;
  $('lista-filas').replaceChildren(...filas.map(cartaoFila));
  mostrar('consultas');
}

function cartaoConsulta(c, ativa) {
  const cancelada = c.status === 'cancelada';
  const rotulo = cancelada ? 'Cancelada' : !ativa ? 'Realizada' : c.presenca_confirmada ? 'Presença confirmada' : 'Marcada';
  const cartao = el('article', { class: `cartao ${ativa ? 'ativo' : ''}`, 'aria-label': `${c.especialidade}, ${rotulo}` },
    el('p', { class: 'titulo-cartao' }, c.especialidade,
      el('span', { class: `etiqueta ${cancelada || !ativa ? 'cancelada' : c.presenca_confirmada ? 'ok' : ''}` }, rotulo)),
    el('p', {}, c.ubs),
    el('p', {}, fmtCartao(c.inicio)));
  if (!ativa) return cartao;

  // RF03: lembrete nas 24 h anteriores, com confirmação de presença em um toque
  const emBreve = new Date(c.inicio) - Date.now() < HORAS_LEMBRETE * 3600_000;
  if (emBreve) {
    cartao.append(el('p', { class: 'lembrete' }, 'Lembrete: sua consulta é em breve.'));
    if (!c.presenca_confirmada) {
      cartao.append(el('button', { type: 'button', class: 'botao principal bloco', onclick: (e) => executar(e.currentTarget, async () => {
        const r = await api('POST', `/api/consultas/${c.id}/presenca`);
        await irConsultas();
        aviso(r.mensagem);
      }) }, 'Vou comparecer'));
    }
  }
  cartao.append(el('div', { class: 'acoes-2' },
    el('button', { type: 'button', class: 'botao', onclick: () => {
      estado.remarcando = c;
      estado.especialidade = c.especialidade;
      estado.ubs = { id: c.ubs_id, nome: c.ubs };
      estado.dia = null;
      ir('horario');
    } }, 'Remarcar'),
    el('button', { type: 'button', class: 'botao perigo', onclick: (e) => cancelarConsulta(c, e.currentTarget) }, 'Cancelar')));
  return cartao;
}

/** [H5] Cancelar não tem volta: confirmação que explica a consequência. */
async function cancelarConsulta(c, botao) {
  const tardio = new Date(c.inicio) - Date.now() < HORAS_TARDIO * 3600_000;
  const ok = await confirmar({
    titulo: 'Cancelar esta consulta?',
    texto: `${c.especialidade}, ${fmtCartao(c.inicio)}, na ${c.ubs}. A vaga será oferecida a outra pessoa.`
      + (tardio ? ` Faltam menos de ${HORAS_TARDIO} horas: o cancelamento fica registrado como tardio.` : ''),
    confirmar: 'Sim, cancelar', cancelar: 'Manter consulta', perigo: true,
  });
  if (!ok) return;
  await executar(botao, async () => {
    const r = await api('POST', `/api/consultas/${c.id}/cancelar`);
    if (r.ok) estado.ultimoCancelamento = c.id;
    await irConsultas();
    aviso(r.ok ? 'Consulta cancelada. A vaga voltou para a agenda e foi oferecida ao primeiro da fila de espera.' : r.mensagem, r.ok ? 'info' : 'erro');
  });
}

function cartaoFila(f) {
  const avisado = f.status === 'avisado';
  return el('article', { class: `cartao ${avisado ? 'ativo' : ''}` },
    el('p', { class: 'titulo-cartao' }, f.especialidade, el('span', { class: 'etiqueta' }, avisado ? 'Vaga aberta' : `${f.posicao}º na fila`)),
    el('p', {}, f.ubs),
    el('p', {}, avisado ? 'Abriu uma vaga para você. Marque logo.' : 'Avisaremos por SMS quando abrir uma vaga.'),
    el('div', { class: 'acoes-2' },
      el('button', { type: 'button', class: `botao ${avisado ? 'principal' : ''}`, onclick: () => abrirHorarios(f.especialidade, { id: f.ubs_id, nome: f.ubs }) }, 'Ver horários'),
      el('button', { type: 'button', class: 'botao', onclick: async (e) => {
        const botao = e.currentTarget;
        const ok = await confirmar({ titulo: 'Sair da fila de espera?', texto: `Você perde sua posição na fila de ${f.especialidade} da ${f.ubs}.`, confirmar: 'Sair da fila', cancelar: 'Continuar na fila', perigo: true });
        if (ok) executar(botao, async () => { await api('POST', `/api/fila/${f.id}/sair`); await irConsultas(); aviso('Você saiu da fila de espera.'); });
      } }, 'Sair da fila')));
}

// ======================================================================= painel da demonstração
function configurarPainelDemo(cfg) {
  demo = true;
  $('painel-demo').hidden = false;
  $('lista-demo').replaceChildren(...(cfg.pacientesDemo ?? []).map((p) => el('li', {}, el('button', { type: 'button', onclick: () => {
    if (estado.tela !== 'entrar' && estado.tela !== 'codigo') mostrar('entrar');
    if (estado.tela === 'codigo') mostrar('entrar');
    $('cpf').value = p.cpf;
    $('cpf').dispatchEvent(new Event('input'));
    const [d, m, a] = p.nascimento.split('/');
    $('dia').value = d; $('mes').value = m; $('ano').value = a;
    $('cpf').focus();
  } }, `${p.nome} — CPF ${p.cpf}, nasc. ${p.nascimento}`))));

  $('demo-sms').addEventListener('change', (e) => executar(null, async () => {
    await api('POST', '/api/demo/sms', { modo: e.target.checked ? 'fora_do_ar' : 'normal' });
    await atualizarDemo();
  }));

  $('demo-segundo-clique').addEventListener('click', (e) => executar(e.currentTarget, async () => {
    if (!estado.logado) { aviso('Entre com um paciente primeiro.', 'erro'); return; }
    if (!estado.ultimoCancelamento) { aviso('Para simular, cancele uma consulta primeiro (aba Consultas).', 'erro'); return; }
    const r = await api('POST', `/api/consultas/${estado.ultimoCancelamento}/cancelar`);
    await irConsultas();
    aviso(r.ok ? r.mensagem : `${r.mensagem} A vaga não foi liberada duas vezes.`, r.ok ? 'info' : 'erro');
  }));

  atualizarDemo();
  setInterval(() => atualizarDemo().catch(() => { /* servidor fora do ar: tenta de novo no próximo ciclo */ }), DEMO_ATUALIZAR_MS);
}

async function atualizarDemo() {
  const r = await api('GET', '/api/demo/estado');
  if (document.activeElement !== $('demo-sms')) $('demo-sms').checked = r.modoSms === 'fora_do_ar';
  $('demo-mensagens').replaceChildren(...(r.mensagens.length
    ? r.mensagens.map((m) => el('li', { class: m.status === 'enviada' ? '' : m.status === 'pendente' && !m.situacao.startsWith('na fila') ? 'falha' : m.status === 'falhou' ? 'falha' : '' },
      `${m.texto} → ${m.situacao}`))
    : [el('li', {}, 'Nenhuma mensagem ainda.')]));
}

// ======================================================================= início do app
(async () => {
  try {
    const cfg = await api('GET', '/api/config');
    if (cfg.demo) configurarPainelDemo(cfg);
  } catch { /* segue sem o painel de demonstração */ }
  try {
    const eu = await api('GET', '/api/eu');
    await entrouComo(eu.nome);
  } catch {
    mostrar('entrar');
  }
})();
