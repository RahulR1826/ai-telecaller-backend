import express from "express";
import {
  createCampaign,
  getCampaigns,
  editCampaign,
  removeCampaign,
  uploadCampaignContacts,
  startCampaignQueue,
  getCampaignQueueStatus,
  pauseCampaignQueue,
  resumeCampaignQueue,
  stopCampaignQueue,
} from "../controllers/campaignController.js";

const router = express.Router();

router.post("/", createCampaign);
router.get("/", getCampaigns);
router.put("/:id", editCampaign);
router.delete("/:id", removeCampaign);
router.post("/:id/upload", uploadCampaignContacts);
router.post("/:id/start", startCampaignQueue);
router.get("/:id/queue", getCampaignQueueStatus);
router.post("/:id/pause", pauseCampaignQueue);
router.post("/:id/resume", resumeCampaignQueue);
router.post("/:id/stop", stopCampaignQueue);

export default router;

