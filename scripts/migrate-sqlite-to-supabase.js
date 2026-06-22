import Database from "better-sqlite3";
import { PrismaClient } from "@prisma/client";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, "../../telecaller.sqlite");

const sqlite = new Database(dbPath, { fileMustExist: false });
const prisma = new PrismaClient();

const parseData = (data) => {
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
};

async function migrate() {
  console.log("Starting migration from SQLite to Supabase PostgreSQL...");

  try {
    // Migrate Campaigns
    console.log("Migrating Campaigns...");
    const campaignsRows = sqlite.prepare(`SELECT * FROM "campaigns"`).all();
    for (const row of campaignsRows) {
      const parsed = parseData(row.data);
      await prisma.campaign.upsert({
        where: { id: row.id },
        update: {},
        create: {
          id: row.id,
          name: parsed.name || parsed.business_name || "Unknown Campaign",
          businessName: parsed.business_name || parsed.businessName || null,
          product: parsed.product || parsed.productService || null,
          offer: parsed.offer || parsed.value_offer || parsed.valueProp || null,
          objective: parsed.objective || parsed.campaignObjective || parsed.goal || null,
          adminName: parsed.admin_name || parsed.adminName || null,
          status: parsed.status || "draft",
          createdAt: parsed.createdAt ? new Date(parsed.createdAt) : new Date(),
        }
      });
    }

    // Migrate Leads
    console.log("Migrating Leads...");
    const leadsRows = sqlite.prepare(`SELECT * FROM "leads"`).all();
    for (const row of leadsRows) {
      const parsed = parseData(row.data);
      await prisma.lead.upsert({
        where: { id: row.id },
        update: {},
        create: {
          id: row.id,
          campaignId: parsed.campaignId || null,
          name: parsed.name || null,
          phone: parsed.phone,
          status: parsed.status || "new",
          leadScore: parsed.leadScore || 0,
          notes: parsed.notes || null,
          nextAction: parsed.nextAction || null,
          callbackTime: parsed.callbackTime || null,
          createdAt: parsed.createdAt ? new Date(parsed.createdAt) : new Date(),
        }
      });
    }

    // Migrate Call Sessions to Calls
    console.log("Migrating Call Sessions...");
    const sessionsRows = sqlite.prepare(`SELECT * FROM "callSessions"`).all();
    for (const row of sessionsRows) {
      const parsed = parseData(row.data);
      await prisma.call.upsert({
        where: { callSid: row.id }, // assuming id is callSid
        update: {},
        create: {
          callSid: row.id,
          campaignId: parsed.campaignId || null,
          to: parsed.to || null,
          from: parsed.from || null,
          status: parsed.status || "initiated",
          durationSec: parsed.durationSec || 0,
          campaignContext: parsed.campaignContext || null,
          history: parsed.history || null,
          lastAiResponses: parsed.lastAiResponses || null,
          stage: parsed.stage || null,
          turnCount: parsed.turnCount || 0,
          questionCount: parsed.questionCount || 0,
          userIntent: parsed.userIntent || null,
          source: parsed.source || null,
          startedAt: parsed.startedAt ? new Date(parsed.startedAt) : new Date(),
          updatedAt: parsed.updatedAt ? new Date(parsed.updatedAt) : new Date(),
          endedAt: parsed.endedAt ? new Date(parsed.endedAt) : null,
        }
      });
    }

    // Migrate Call Logs (Transcripts)
    console.log("Migrating Transcripts...");
    const logsRows = sqlite.prepare(`SELECT * FROM "callLogs"`).all();
    for (const row of logsRows) {
      const parsed = parseData(row.data);
      await prisma.transcript.upsert({
        where: { id: row.id },
        update: {},
        create: {
          id: row.id,
          callId: parsed.sessionId || "unknown", // Transcript relates to Call or CallSession, we map it via callId (which represents callSid)
          speaker: parsed.speaker || "unknown",
          text: parsed.text || "",
          source: parsed.source || null,
          sentiment: parsed.sentiment || null,
          intent: parsed.intent || null,
          timestamp: parsed.timestamp ? new Date(parsed.timestamp) : new Date(),
        }
      }).catch(err => {
         console.warn(`Could not migrate transcript ${row.id} - possible missing foreign key callId ${parsed.sessionId}`);
      });
    }

    // Migrate Summaries
    console.log("Migrating Summaries...");
    const summariesRows = sqlite.prepare(`SELECT * FROM "callSummaries"`).all();
    for (const row of summariesRows) {
      const parsed = parseData(row.data);
      await prisma.summary.upsert({
        where: { id: row.id },
        update: {},
        create: {
          id: row.id,
          callId: parsed.sessionId, // relates to CallSid
          summary: parsed.summary || "",
          leadScore: parsed.leadScore || null,
          actionItem: parsed.actionItem || null,
          demoTime: parsed.demoTime || null,
          objections: parsed.objections || null,
          createdAt: parsed.createdAt ? new Date(parsed.createdAt) : new Date(),
        }
      }).catch(err => {
         console.warn(`Could not migrate summary ${row.id} - possible missing foreign key callId ${parsed.sessionId}`);
      });
    }

    // Migrate Queues
    console.log("Migrating Queues...");
    const queuesRows = sqlite.prepare(`SELECT * FROM "queues"`).all();
    for (const row of queuesRows) {
      const parsed = parseData(row.data);
      await prisma.queueState.upsert({
        where: { campaignId: row.id },
        update: {},
        create: {
          campaignId: row.id,
          status: parsed.status || "completed",
          pending: parsed.pending || [],
          completed: parsed.completed || [],
          failed: parsed.failed || [],
          retryCount: parsed.retryCount || {},
          inProgress: parsed.inProgress || false,
          currentPhoneNumber: parsed.currentPhoneNumber || null,
          activeCallSid: parsed.activeCallSid || null,
          startedAt: parsed.startedAt ? new Date(parsed.startedAt) : new Date(),
          updatedAt: parsed.updatedAt ? new Date(parsed.updatedAt) : new Date(),
        }
      });
    }

    console.log("Migration complete!");
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    await prisma.$disconnect();
  }
}

migrate();
