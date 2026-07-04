import http from 'http';
import { createApp } from './app.js';
import { initSocket } from './sockets/index.js';
import { env } from './config/env.js';
import { startAutoCloseJourneysJob } from './jobs/autoCloseJourneys.js';

const app = createApp();
const server = http.createServer(app);
initSocket(server);
startAutoCloseJourneysJob();

server.listen(env.port, () => {
  console.log(`Transdier v2 API escuchando en puerto ${env.port}`);
});
