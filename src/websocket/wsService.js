// ─────────────────────────────────────────────────────────────────────────────
// websocket/wsService.js — Socket.io broadcast server
// ─────────────────────────────────────────────────────────────────────────────

import { Server } from "socket.io";
import { log } from "../utils/logger.js";

/** @type {Server | null} */
let io = null;

/**
 * Attach Socket.io to an existing HTTP server.
 * @param {import("http").Server} httpServer
 */
export const initWsServer = (httpServer) => {
  if (io) {
    log.warn("Socket.io server already initialized");
    return io;
  }

  io = new Server(httpServer, {
    path: "/ws",
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    log.ws(`Client connected: ${socket.id} — total: ${io.engine.clientsCount}`);
    socket.emit("connected", { status: "ok" });

    socket.on("disconnect", () => {
      log.ws(`Client disconnected: ${socket.id}`);
    });

    socket.on("error", (err) => {
      log.warn("Socket.io client error:", err.message);
    });
  });

  io.engine.on("connection_error", (err) => {
    log.error("Socket.io connection error:", err.message);
  });

  log.ws("Socket.io server listening on path /ws");
  return io;
};

/**
 * Broadcast a typed event to all connected clients.
 * @param {string} event  — e.g. "call.started", "conversation.message"
 * @param {object} data   — arbitrary payload
 */
export const broadcast = (event, data = {}) => {
  if (!io) return;
  io.emit(event, data);
  log.ws(`broadcast event="${event}"`);
};

/** Returns current client count */
export const wsClientCount = () => (io ? io.engine.clientsCount : 0);
