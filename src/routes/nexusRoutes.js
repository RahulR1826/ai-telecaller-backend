import express from "express";
import { handleNexusChat } from "../controllers/nexusController.js";

const router = express.Router();

router.post("/chat", handleNexusChat);

export default router;
