import express from "express";
import {
	handleCall,
	getSummary,
	getLiveSessions,
	getTranscript,
	getCallHistory,
	getCallbacks,
	twilioVoiceWebhook,
	twilioStatusWebhook,
} from "../controllers/callController.js";

const router = express.Router();

router.post("/", handleCall);
router.post("/summary", getSummary);
router.get("/live", getLiveSessions);
router.get("/history", getCallHistory);
router.get("/callbacks", getCallbacks);
router.get("/:sessionId/transcript", getTranscript);
router.post("/twilio/voice", twilioVoiceWebhook);
router.get("/twilio/voice", twilioVoiceWebhook);
router.post("/twilio/status", twilioStatusWebhook);

export default router;
