// Ponto de entrada na Vercel: todas as rotas (páginas e API) chegam aqui pelo rewrite do vercel.json.
// Reaproveita o mesmo app do servidor local; o envio de SMS avança a cada requisição (sem processo contínuo).
import { criarApp } from '../src/app.js';

const app = criarApp({ serverless: true });

export default function handler(req, res) {
  return app.tratar(req, res);
}
