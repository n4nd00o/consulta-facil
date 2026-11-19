import { fileURLToPath } from 'node:url';

// Parâmetros do sistema. Valores de produção indicados nos comentários;
// o padrão é acelerado para demonstração local.
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 3000),
  // Na Vercel só /tmp aceita escrita, e ele é temporário: a demonstração recomeça a cada nova instância.
  dbPath: process.env.DB_PATH
    || (process.env.VERCEL ? '/tmp/consulta-facil.db' : fileURLToPath(new URL('../data/consulta-facil.db', import.meta.url))),
  demo: process.env.DEMO !== '0', // mostra o código SMS na tela e expõe a caixa de SMS simulada
  painelSenha: process.env.PAINEL_SENHA || 'ubs123', // apenas demonstração; em produção, definir via ambiente

  // Regras de negócio (RF02) — parâmetros a combinar com a Secretaria
  cancelamentoTardioHoras: 2,
  limiteCancelamentosTardios: 3,
  janelaCancelamentosDias: 30,
  lembreteHorasAntes: 24,

  // Notificações (questão 4): timeout, retentativa com limite e circuit breaker
  smsTimeoutMs: num(process.env.SMS_TIMEOUT_MS, 5000),
  smsMaxTentativas: 5,
  // Produção: 60000 (1, 2, 4, 8, 16 minutos). Demo: 1 s, 2 s, 4 s...
  backoffUnidadeMs: num(process.env.BACKOFF_UNIT_MS, 1000),
  circuitoFalhasParaAbrir: 5,
  circuitoAbertoMs: num(process.env.CIRCUIT_OPEN_MS, 60000),
  workerIntervaloMs: num(process.env.WORKER_INTERVAL_MS, 1000),

  otpValidadeMin: 10,
  otpMaxTentativas: 5,
  sessaoHoras: 8,
};
