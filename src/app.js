import express from "express";
import cors from "cors";
import callRoutes from "./routes/callRoutes.js";
import campaignRoutes from "./routes/campaignRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import nexusRoutes from "./routes/nexusRoutes.js";
import leadRoutes from "./routes/leadRoutes.js";
import { wsClientCount } from "./websocket/wsService.js";

const app = express();

const allowedOrigins = new Set([
	process.env.FRONTEND_URL || "http://localhost:3000",
	"http://localhost:5173",
	"http://127.0.0.1:5173",
	"http://localhost:3000",
	"http://127.0.0.1:3000",
	"http://localhost:3001",
	"http://127.0.0.1:3001",
	"null",
]);

app.use(
	cors({
		origin: (origin, callback) => {
			if (!origin) {
				callback(null, true);
				return;
			}

			if (
				allowedOrigins.has(origin) ||
				origin.endsWith(".ngrok-free.app") ||
				origin.endsWith(".ngrok-free.dev") ||
				origin.endsWith(".vercel.app") ||
				origin.endsWith(".railway.app")
			) {
				callback(null, true);
				return;
			}

			callback(new Error(`CORS blocked for origin: ${origin}`));
		},
	})
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/api/health", (_, res) => res.json({ status: "ok", wsClients: wsClientCount() }));
app.use("/api/call", callRoutes);
app.use("/api/campaign", campaignRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/nexus", nexusRoutes);
app.use("/api/lead", leadRoutes);

export default app;
