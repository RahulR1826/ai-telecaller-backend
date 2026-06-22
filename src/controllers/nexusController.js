import { processNexusChat } from "../services/nexusService.js";
import { log } from "../utils/logger.js";

export const handleNexusChat = async (req, res) => {
  try {
    const { messages, context } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid messages format" });
    }

    const reply = await processNexusChat(messages, context || {});
    res.json({ reply });
  } catch (error) {
    log.error("Error in handleNexusChat:", error);
    res.status(500).json({ error: "Internal server error during Nexus AI processing." });
  }
};
