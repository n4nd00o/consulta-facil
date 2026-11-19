// Provedor de SMS/WhatsApp SIMULADO. Em produção seria substituído por um cliente
// HTTP do provedor contratado, mantendo a mesma interface: enviar(telefone, texto).
// O modo pode ser alterado no painel da UBS para reproduzir as falhas do piloto.
export const MODOS_SMS = ['normal', 'fora_do_ar', 'lento'];

export class SmsProviderSimulado {
  constructor() {
    this.modo = 'normal';
    this.caixa = []; // últimas mensagens "entregues" (só para demonstração)
    this.chamadas = 0;
  }

  definirModo(modo) {
    if (!MODOS_SMS.includes(modo)) throw new Error('Modo inválido');
    this.modo = modo;
  }

  async enviar(telefone, texto) {
    this.chamadas += 1;
    if (this.modo === 'fora_do_ar') throw new Error('Provedor de SMS indisponível (503)');
    if (this.modo === 'lento') await new Promise((r) => setTimeout(r, 30_000).unref());
    this.caixa.unshift({ telefone, texto, em: new Date().toISOString() });
    this.caixa.length = Math.min(this.caixa.length, 50);
    return { id: `sim-${this.chamadas}` };
  }
}
