const http = require('http');
const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();

// ── Body parsing ──────────────────────────────────────────────
app.use(express.json());

// ── API routes ────────────────────────────────────────────────
// messages exports { router, wss, upgradeHandler } — destructure here.
const { router: messagesRouter, upgradeHandler } = require('./routes/messages');

app.use('/api/auth',     require('./routes/auth'));
app.use('/api/messages', messagesRouter);
app.use('/api/images',   require('./routes/images'));
app.use('/api/friends',  require('./routes/friends'));
app.use('/api/groups',   require('./routes/groups'));
app.use('/api/matching', require('./routes/matching'));
app.use('/api/payments', require('./routes/payments'));

// ── Serve React client build in production ────────────────────
// Vite outputs to client/dist. Express serves the static assets
// and falls back to index.html for all non-API routes so React
// Router handles client-side navigation.
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// ── HTTP server + WebSocket upgrade ──────────────────────────
// The ws WebSocketServer is noServer — it does not bind its own
// port. We create an http.Server from the Express app and route
// WebSocket upgrade requests (ws://host/ws?token=...) through
// the upgradeHandler exported by messages.js.
const httpServer = http.createServer(app);
httpServer.on('upgrade', upgradeHandler);

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});
