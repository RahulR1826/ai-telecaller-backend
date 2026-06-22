import express from "express";
import { getLeads } from "../repositories/leadRepository.js";
import { log } from "../utils/logger.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const leads = await getLeads();
    res.json(leads);
  } catch (error) {
    log.error("Error fetching leads:", error.message);
    res.status(500).json({ error: "Failed to fetch leads" });
  }
});

export default router;
