// Utilitários compartilhados entre o app do cidadão e o painel da UBS.

export async function api(metodo, caminho, corpo) {
  let r;
  try {
    r = await fetch(caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'consulta-facil' },
      body: corpo ? JSON.stringify(corpo) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('Sem conexão com o servidor. Verifique sua internet e tente de novo.');
  }
  let dados = null;
  try { dados = await r.json(); } catch { /* resposta sem corpo JSON */ }
  if (!r.ok) {
    const erro = new Error(dados?.erro ?? 'Não foi possível concluir agora. Tente de novo em instantes.');
    erro.status = r.status;
    throw erro;
  }
  return dados;
}

/** Cria elementos sem innerHTML (evita XSS). Atributos on* viram listeners. */
export function el(tag, attrs = {}, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const f of filhos.flat()) if (f !== null && f !== undefined && f !== false) n.append(f instanceof Node ? f : String(f));
  return n;
}

const SVG = 'http://www.w3.org/2000/svg';
const ICONES = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  seta: 'M9 5l7 7-7 7',
};
/** Ícone de traço simples, decorativo (aria-hidden). */
export function icone(nome, tamanho = 20) {
  const s = document.createElementNS(SVG, 'svg');
  const attrs = { viewBox: '0 0 24 24', width: tamanho, height: tamanho, 'aria-hidden': 'true', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', ICONES[nome]);
  s.append(p);
  return s;
}

const data = (iso) => new Date(iso);
export const fmtDataHora = (iso) => data(iso).toLocaleString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
export const fmtDia = (iso) => data(iso).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
export const fmtHora = (iso) => data(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
export const fmtCurta = (iso) => data(iso).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const novaChave = () => crypto.randomUUID();

/** Mesma regra do servidor: valida os dígitos verificadores antes de enviar (prevenção de erro). */
export function cpfValido(cpf) {
  const c = String(cpf).replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

/** Diálogo de confirmação acessível (substitui o confirm() do navegador).
 *  O foco começa na opção segura; Esc fecha sem executar. */
export function confirmar({ titulo, texto, confirmar: rotuloOk = 'Confirmar', cancelar = 'Voltar', perigo = false }) {
  return new Promise((resolve) => {
    const d = el('dialog', { class: 'dialogo', 'aria-labelledby': 'dlg-titulo', 'aria-describedby': 'dlg-texto' },
      el('h2', { id: 'dlg-titulo' }, titulo),
      el('p', { id: 'dlg-texto' }, texto),
      el('div', { class: 'dialogo-acoes' },
        el('button', { type: 'button', class: 'botao', onclick: () => d.close('nao') }, cancelar),
        el('button', { type: 'button', class: `botao ${perigo ? 'perigo cheio' : 'principal'}`, onclick: () => d.close('sim') }, rotuloOk)));
    d.addEventListener('close', () => { resolve(d.returnValue === 'sim'); d.remove(); });
    document.body.append(d);
    d.showModal();
    d.querySelector('button').focus();
  });
}

/** Mostra "Aguarde…" no botão enquanto a ação roda e impede clique duplo. */
export async function comEspera(botao, fn) {
  if (!botao) return fn();
  const texto = botao.textContent;
  botao.disabled = true;
  botao.setAttribute('aria-busy', 'true');
  botao.textContent = 'Aguarde…';
  try {
    return await fn();
  } finally {
    if (botao.isConnected) {
      botao.disabled = false;
      botao.removeAttribute('aria-busy');
      botao.textContent = texto;
    }
  }
}

/** Tamanho de texto ajustável e alto contraste (RA01), lembrados neste aparelho. */
export function configurarAjustes() {
  const raiz = document.documentElement;
  const ler = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, v); } catch { /* armazenamento indisponível */ } };
  let escala = Number(ler('cf-escala', '112.5'));
  const aplicar = () => { raiz.style.fontSize = `${escala}%`; };
  aplicar();
  document.getElementById('aumentar')?.addEventListener('click', () => { escala = Math.min(escala + 12.5, 175); aplicar(); gravar('cf-escala', escala); });
  document.getElementById('diminuir')?.addEventListener('click', () => { escala = Math.max(escala - 12.5, 87.5); aplicar(); gravar('cf-escala', escala); });
  const botao = document.getElementById('contraste');
  const setContraste = (on) => { raiz.classList.toggle('contraste', on); botao?.setAttribute('aria-pressed', String(on)); gravar('cf-contraste', on ? '1' : '0'); };
  setContraste(ler('cf-contraste', '0') === '1');
  botao?.addEventListener('click', () => setContraste(!raiz.classList.contains('contraste')));
}
