import { criarApp } from './app.js';
import { config } from './config.js';
import { PACIENTES_DEMO } from './modules/siga-adapter.js';

const app = criarApp();
app.server.listen(config.port, () => {
  console.log(`\nConsulta Fácil rodando em http://localhost:${config.port}`);
  console.log(`Painel da UBS:          http://localhost:${config.port}/painel  (senha: ${config.demo ? config.painelSenha : 'definida em PAINEL_SENHA'})`);
  if (config.demo) {
    console.log('\nPacientes de demonstração (dados fictícios):');
    for (const p of PACIENTES_DEMO) console.log(`  CPF ${p.cpf}  nascimento ${p.nasc}  ${p.nome}`);
  }
});

const encerrar = () => app.fechar().then(() => process.exit(0));
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
