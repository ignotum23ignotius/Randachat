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
app.use('/api/users',    require('./routes/users'));

// ── Serve landing page + static assets ───────────────────────
// server/public contains index.html (landing page) and hero.png.
// Served unconditionally so the landing page works in all envs.
app.use(express.static(path.join(__dirname, 'public')));

// ── Serve React client build in production ────────────────────
// Vite builds with base: '/app/' so all assets are under /app/.
// The catch-all only handles /app/* so the landing page at /
// is unaffected.
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use('/app', express.static(clientDist));
  app.get('/app/*', (req, res) => {
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
