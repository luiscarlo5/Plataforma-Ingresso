// Ponto de entrada da API (MVC): src/app.js monta o Express e as rotas de cada módulo.
const app = require('./src/app');
const bootstrap = require('./src/bootstrap');
const { PORT } = require('./src/config');

app.locals.ready = bootstrap().then(() => {
  app.locals.initialized = true;
});
app.locals.ready.catch((err) => {
  console.error('[Bootstrap] Falha ao inicializar a API:', err.message);
  process.exit(1);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`API em execução na porta ${PORT}`);
  });
}

module.exports = app;
