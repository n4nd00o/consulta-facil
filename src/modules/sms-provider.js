// Provedores de SMS/WhatsApp. Todos têm a mesma interface — enviar(telefone, texto) — e o resto do
// sistema (outbox, retentativas, circuit breaker) não sabe qual está em uso.
//
//   SMS_PROVEDOR=simulado (padrão) → nada sai do servidor; as mensagens aparecem no painel.
//   SMS_PROVEDOR=twilio            → envio real pelo Twilio (SMS ou WhatsApp), via API HTTP.
//
// Em qualquer provedor, o painel da demonstração pode simular "fora do ar" e "lento"
// para reproduzir as falhas do piloto sem desligar o provedor de verdade.
export const MODOS_SMS = ['normal', 'fora_do_ar', 'lento'];
const ATRASO_LENTO_MS = 30_000;
const TAMANHO_CAIXA = 50;

/** Erro de envio. `permanente` = não adianta tentar de novo (número inválido, credencial errada...). */
export class ErroEnvio extends Error {
  constructor(mensagem, { permanente = false } = {}) {
    super(mensagem);
    this.permanente = permanente;
  }
}

/** Celular brasileiro (DDD + número, 10 ou 11 dígitos) → formato internacional +55... */
export function telefoneInternacional(telefone) {
  const d = String(telefone).replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `+${d}`;
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  throw new ErroEnvio(`Telefone inválido para envio: ${d.slice(0, 2)}…`, { permanente: true });
}

class ProvedorBase {
  constructor(nome) {
    this.nome = nome;
    this.modo = 'normal';
    this.caixa = []; // últimas mensagens entregues (exibidas no painel no modo demonstração)
    this.chamadas = 0;
  }

  definirModo(modo) {
    if (!MODOS_SMS.includes(modo)) throw new Error('Modo inválido');
    this.modo = modo;
  }

  async enviar(telefone, texto) {
    this.chamadas += 1;
    if (this.modo === 'fora_do_ar') throw new ErroEnvio('Provedor de SMS indisponível (503, simulação)');
    if (this.modo === 'lento') await new Promise((r) => setTimeout(r, ATRASO_LENTO_MS).unref());
    const r = await this.entregar(telefone, texto);
    this.caixa.unshift({ telefone, texto, em: new Date().toISOString(), id: r.id });
    this.caixa.length = Math.min(this.caixa.length, TAMANHO_CAIXA);
    return r;
  }
}

export class SmsProviderSimulado extends ProvedorBase {
  constructor() {
    super('simulado');
  }

  async entregar() {
    return { id: `sim-${this.chamadas}` };
  }
}

/** Twilio (https://www.twilio.com/docs/messaging/api/message-resource). Sem SDK: um POST HTTP. */
export class SmsProviderTwilio extends ProvedorBase {
  constructor({ accountSid, authToken, remetente, messagingServiceSid, canal = 'sms', timeoutMs = 5000, baseUrl = 'https://api.twilio.com' }) {
    super(canal === 'whatsapp' ? 'twilio-whatsapp' : 'twilio-sms');
    this.autorizacao = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
    this.remetente = remetente;
    this.messagingServiceSid = messagingServiceSid;
    this.canal = canal;
    this.timeoutMs = timeoutMs;
    this.url = `${baseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  }

  async entregar(telefone, texto) {
    const para = telefoneInternacional(telefone);
    const prefixo = this.canal === 'whatsapp' ? 'whatsapp:' : '';
    const corpo = new URLSearchParams({ To: `${prefixo}${para}`, Body: texto });
    if (this.messagingServiceSid) corpo.set('MessagingServiceSid', this.messagingServiceSid);
    else corpo.set('From', `${prefixo}${this.remetente.replace(/^whatsapp:/, '')}`);

    let r;
    try {
      r = await fetch(this.url, {
        method: 'POST',
        headers: { Authorization: this.autorizacao, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: corpo,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ErroEnvio(`Sem resposta do Twilio (${e.name === 'TimeoutError' ? 'timeout' : 'rede'})`);
    }
    const dados = await r.json().catch(() => ({}));
    if (r.ok) return { id: dados.sid };
    // 4xx (exceto 429) = problema no pedido: número inválido, não verificado na conta de teste, credencial errada
    const permanente = r.status >= 400 && r.status < 500 && r.status !== 429;
    throw new ErroEnvio(`Twilio ${r.status}${dados.code ? ` (código ${dados.code})` : ''}: ${dados.message ?? 'erro'}`, { permanente });
  }
}

/**
 * Escolhe o provedor pelas variáveis de ambiente. Configuração incompleta não derruba o app:
 * ele continua no modo simulado e o aviso aparece no log e no painel da equipe.
 */
export function criarProvedor(env = process.env, { timeoutMs } = {}) {
  const escolhido = (env.SMS_PROVEDOR || 'simulado').toLowerCase();
  if (escolhido !== 'twilio') return { provedor: new SmsProviderSimulado(), aviso: null };

  const canal = (env.SMS_CANAL || 'sms').toLowerCase() === 'whatsapp' ? 'whatsapp' : 'sms';
  const faltando = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'].filter((k) => !env[k]);
  if (!env.TWILIO_FROM && !env.TWILIO_MESSAGING_SERVICE_SID) faltando.push('TWILIO_FROM (ou TWILIO_MESSAGING_SERVICE_SID)');
  if (faltando.length) {
    return {
      provedor: new SmsProviderSimulado(),
      aviso: `SMS_PROVEDOR=twilio, mas faltam: ${faltando.join(', ')}. Usando o modo simulado.`,
    };
  }
  return {
    provedor: new SmsProviderTwilio({
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      remetente: env.TWILIO_FROM ?? '',
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
      canal,
      timeoutMs,
      baseUrl: env.TWILIO_API_BASE || undefined,
    }),
    aviso: null,
  };
}
