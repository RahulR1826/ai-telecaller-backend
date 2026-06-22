import dotenv from "dotenv";
dotenv.config();

import http from "http";
import app from "./app.js";
import { initWsServer } from "./websocket/wsService.js";
import { log } from "./utils/logger.js";

const port = Number(process.env.PORT || 5000);

// Create raw HTTP server from Express so we can attach WebSocket on same port
const server = http.createServer(app);

// ── WebSocket server (ws://localhost:5000/ws) ────────────────────────────────
initWsServer(server);

// ── Start listening ──────────────────────────────────────────────────────────
server.listen(port, () => {
  log.http(`Server listening on port ${port}`);
  log.http(`REST:  http://localhost:${port}/api`);
  log.http(`WS:    ws://localhost:${port}/ws`);
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    log.warn(`Port ${port} already in use — backend is likely already running.`);
    process.exit(0);
    return;
  }
  log.error("Server failed to start:", error.message);
  process.exit(1);
});
