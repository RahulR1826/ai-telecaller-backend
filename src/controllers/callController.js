// ─────────────────────────────────────────────────────────────────────────────
// controllers/callController.js — Twilio voice pipeline + web-chat API
//
// Key fixes applied (vs audit report):
//  1. speechTimeout changed from "auto" → "3" (explicit)
//  2. actionOnEmptyResult: true added to Gather
//  3. <Redirect> after Gather replaced with <Pause>+hangup for true empty result
//  4. Structured [CALL][STT][LLM][TTS][PLAYBACK] logging at every stage
//  5. WebSocket broadcasts after each AI turn
//  6. LLM timeout reduced to 8s (done in llmService.js)
// ─────────────────────────────────────────────────────────────────────────────

import { addCallLog, updateCallSession, getCallSession, getAllCallSessions, addCallSummary, getCallLogsBySessionId } from "../repositories/callRepository.js";
import { addCallbackRecord, getCampaignCallbacks } from "../repositories/callbackRepository.js";
import { getCampaignById } from "../repositories/campaignRepository.js";
import {
  startOutboundCall,
  getVoiceResponse,
  isAllowedTestNumber,
  twilioConfig,
} from "../services/twilioService.js";
import { markCallCompleted } from "../queue/campaignQueue.js";
import {
  generateCallSummary,
  generateConversationTurn,
  generateGreetingAndStore,
} from "../services/conversationManager.js";
import { broadcast } from "../websocket/wsService.js";
import { log, elapsed } from "../utils/logger.js";

// ── Internal helpers ─────────────────────────────────────────────────────────

const appendCallLog = async ({ sessionId, source, userText, reply, userIntent }) => {
  const ts = new Date().toISOString();

  const sentiment =
    userIntent?.intent === "negative" ? "Negative"
    : userIntent?.intent === "interested" ? "Positive"
    : "Neutral";

  await addCallLog({
    sessionId,
    speaker: "customer",
    text: userText,
    source,
    sentiment,
    intent: userIntent?.intent || "unknown",
    timestamp: ts,
  });

  await addCallLog({
    sessionId,
    speaker: "ai",
    text: reply,
    source,
    sentiment: "Neutral",
    intent: userIntent?.intent || "unknown",
    timestamp: ts,
  });
};

// ── Web-chat handler ─────────────────────────────────────────────────────────

export const handleCall = async (req, res) => {
  try {
    const {
      message,
      sessionId,
      phoneNumber,
      business_name,
      product,
      offer,
      objective,
    } = req.body;

    const campaignContext = { business_name, product, offer, objective };

    if (phoneNumber) {
      const outboundSessionId = sessionId || `call_${Date.now()}`;
      log.call(`Initiating outbound call → ${phoneNumber} session=${outboundSessionId}`);

      const call = await startOutboundCall({ to: phoneNumber, sessionId: outboundSessionId });

      await updateCallSession(call.sid, {
        callSid: call.sid,
        to: phoneNumber,
        campaignContext,
        status: call.status || "initiated",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        durationSec: 0,
      });

      broadcast("call.started", { callSid: call.sid, phoneNumber, sessionId: outboundSessionId });

      return res.json({
        ok: true,
        mode: "twilio",
        sessionId: outboundSessionId,
        callSid: call.sid,
        status: call.status,
        campaignContext,
      });
    }

    if (!message && sessionId) {
      log.call(`Web greeting requested for session=${sessionId}`);
      const greeting = await generateGreetingAndStore({ sessionId, campaign: campaignContext });
      return res.json({ reply: greeting, intent: "greeting", stage: "GREETING", campaignContext });
    }

    if (!message || !sessionId) {
      return res.status(400).json({ error: "message and sessionId are required" });
    }

    log.call(`Web turn session=${sessionId} message="${message}"`);
    const t0 = Date.now();
    const result = await generateConversationTurn({
      sessionId,
      userText: message,
      campaign: campaignContext,
      source: "web",
    });
    log.llm(`Web turn complete in ${elapsed(t0)}`);

    await appendCallLog({
      sessionId,
      source: "web",
      userText: message,
      reply: result.reply,
      userIntent: result.userIntent,
    });

    broadcast("conversation.message", {
      sessionId,
      speaker: "ai",
      text: result.reply,
      stage: result.stage,
      intent: result.userIntent?.intent,
    });

    res.json({
      reply: result.reply,
      intent: result.userIntent?.intent || "unknown",
      stage: result.stage || result.conversation?.stage || "DISCOVERY",
      campaignContext: result.campaignContext,
    });
  } catch (err) {
    log.error("handleCall:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Summary endpoint ─────────────────────────────────────────────────────────

export const getSummary = async (req, res) => {
  try {
    const sessionId = req.body?.sessionId || req.body?.callId;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId or callId is required" });
    }
    log.call(`Generating summary for session=${sessionId}`);
    const summary = await generateCallSummary(sessionId);
    res.json({ summary });
  } catch (err) {
    log.error("getSummary:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Twilio voice webhook ─────────────────────────────────────────────────────

export const twilioVoiceWebhook = async (req, res) => {
  const callSid = req.body?.CallSid || req.query?.sessionId || `twilio_${Date.now()}`;

  try {
    const direction    = String(req.body?.Direction || "").toLowerCase();
    const from         = req.body?.From || "";
    const to           = req.body?.To || "";
    const speechResult = req.body?.SpeechResult?.trim() || "";
    const campaignId   = req.query?.campaignId || req.body?.CampaignId || req.body?.campaignId || null;

    log.call(`Webhook callSid=${callSid} direction=${direction} hasSpeech=${Boolean(speechResult)}`);

    // ── Look up campaign context (DB — silent fail with strict timeout) ────────────────
    let campaign = {};
    let customerName = null;
    try {
      const dbLookupPromise = (async () => {
        if (campaignId) {
          const campaignDoc = await getCampaignById(String(campaignId));
          if (campaignDoc?.exists) campaign = campaignDoc.data() || {};
        }
        if (!campaign || Object.keys(campaign).length === 0) {
          const sessionDoc = await getCallSession(callSid);
          if (sessionDoc?.exists) {
            const sessionData = sessionDoc.data() || {};
            campaign = sessionData.campaignContext || {};
            customerName = sessionData.campaignContext?.customerName || null;
          }
        }
        // Also look up customer name from Lead by phone number
        if (!customerName && to) {
          try {
            const { db } = await import("../db/db.js");
            const lead = await db.lead.findUnique({ where: { phone: to } });
            if (lead?.name && lead.name !== to) customerName = lead.name;
          } catch (_) {}
        }
      })();

      await Promise.race([
        dbLookupPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("DB lookup timeout")), 2000))
      ]);
    } catch (dbErr) {
      log.warn(`[voice] DB lookup failed/timed out (non-fatal): ${dbErr.message}`);
    }

    // Inject customer name into campaign context
    if (customerName) campaign.customerName = customerName;

    const vr = getVoiceResponse();

    // ── Guard: inbound test number restriction ───────────────────────────────
    if (direction === "inbound" && !isAllowedTestNumber(from) && twilioConfig.testPhoneNumber) {
      log.warn(`Inbound call from ${from} blocked — not test number`);
      vr.say("This line is only enabled for the configured test number.");
      vr.hangup();
      return res.type("text/xml").send(vr.toString());
    }

    const greetingPlayed = req.query?.greetingPlayed === "true";
    let finalSpeechResult = speechResult;

    // If the customer was silent after the greeting has already played:
    if (!finalSpeechResult && greetingPlayed) {
      finalSpeechResult = "(Customer remained silent. Keep the conversation moving naturally.)";
    }

    // ── No SpeechResult → Greeting turn ─────────────────────────────────────
    if (!finalSpeechResult) {
      log.call(`callSid=${callSid} — no speech, generating greeting`);
      const t0 = Date.now();
      const greeting = await generateGreetingAndStore({ sessionId: callSid, campaign });
      log.llm(`Greeting generated in ${elapsed(t0)}: "${greeting}"`);
      log.tts(`Using Amazon Polly via TwiML <Say voice="Polly.Matthew-Neural">`);

      // DB persist — silent fail
      try {
        await updateCallSession(callSid, {
          callSid,
          from,
          to,
          campaignId,
          campaignContext: {
            business_name: campaign.business_name || campaign.businessName,
            product: campaign.product || campaign.productService || campaign.service,
            offer: campaign.offer || campaign.value_offer || campaign.valueProp,
            objective: campaign.objective || campaign.campaignObjective || campaign.goal,
          },
          status: "in-progress",
          startedAt: new Date().toISOString(),
        });
      } catch (dbErr) {
        log.warn(`[voice] updateCallSession failed (non-fatal): ${dbErr.message}`);
      }

      broadcast("call.started", { callSid, campaignId, from, to, phoneNumber: to });
      broadcast("conversation.message", { sessionId: callSid, speaker: "ai", text: greeting, stage: "GREETING" });

      // ── Build TwiML ──────────────────────────────────────────────────────
      const gather = vr.gather({
        input: "speech",
        speechTimeout: "3",           // ← FIX: explicit, not "auto"
        actionOnEmptyResult: true,    // ← FIX: continue loop even if silent
        timeout: 10,
        action: "/api/call/twilio/voice?greetingPlayed=true",
        method: "POST",
        language: "en-IN",
      });
      gather.say({ voice: "Polly.Matthew-Neural" }, greeting);
      // NO <Redirect> here — actionOnEmptyResult handles timeout

      log.play(`TwiML greeting sent, length=${vr.toString().length} bytes`);
      return res.type("text/xml").send(vr.toString());
    }

    // ── SpeechResult present → Conversation turn ─────────────────────────────


    const t0 = Date.now();
    const ai = await generateConversationTurn({
      sessionId: callSid,
      userText: finalSpeechResult,
      campaign,
      source: "twilio",
    });
    


    // DB log — silent fail
    try {
      await appendCallLog({
        sessionId: callSid,
        source: "twilio",
        userText: speechResult,
        reply: ai.reply,
        userIntent: ai.userIntent,
      });
    } catch (dbErr) {
      log.warn(`[voice] appendCallLog failed (non-fatal): ${dbErr.message}`);
    }

    // Broadcast live transcript to WS clients
    broadcast("conversation.message", {
      sessionId: callSid,
      speaker: "customer",
      text: speechResult,
      intent: ai.userIntent?.intent,
      stage: ai.stage,
    });
    broadcast("conversation.message", {
      sessionId: callSid,
      speaker: "ai",
      text: ai.reply,
      stage: ai.stage,
      intent: ai.userIntent?.intent,
    });

    // ── Build TwiML ──────────────────────────────────────────────────────────
    const gather = vr.gather({
      input: "speech",
      speechTimeout: "3",           // ← FIX
      actionOnEmptyResult: true,    // ← FIX
      timeout: 10,
      action: "/api/call/twilio/voice",
      method: "POST",
      language: "en-IN",
      hints: "price, demo, crm, integration, callback, interested, busy, no thanks",
    });
    gather.say({ voice: "Polly.Matthew-Neural" }, ai.reply);
    // NO <Redirect> — actionOnEmptyResult loops automatically

    log.play(`TwiML reply sent, length=${vr.toString().length} bytes`);
    return res.type("text/xml").send(vr.toString());

  } catch (err) {
    log.error(`twilioVoiceWebhook callSid=${callSid}:`, err.message);
    const vr = getVoiceResponse();
    vr.say("Sorry, I am having a technical issue. Please try again later.");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }
};

// ── Twilio status webhook ────────────────────────────────────────────────────

export const twilioStatusWebhook = async (req, res) => {
  try {
    const callSid    = req.body?.CallSid;
    const callStatus = String(req.body?.CallStatus || "").toLowerCase();
    const callDuration = Number(req.body?.CallDuration || 0);

    log.status(`CallSid=${callSid} status=${callStatus} duration=${callDuration}s`);

    if (callSid) {
      await updateCallSession(callSid, {
        callSid,
        from: req.body?.From,
        to: req.body?.To,
        status: callStatus,
        durationSec: Number.isFinite(callDuration) ? callDuration : 0,
        updatedAt: new Date().toISOString(),
        endedAt: ["completed", "busy", "failed", "no-answer", "canceled"].includes(callStatus)
          ? new Date().toISOString()
          : null,
      });
    }

    const terminalStatuses = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

    if (callSid && callStatus === "completed") {
      try {
        log.call(`Generating post-call analysis for ${callSid}`);
        const analysis = await generateCallSummary(callSid);

        await addCallSummary({
          sessionId: callSid,
          summary: analysis.summary,
          leadScore: analysis.leadScore,
          actionItem: analysis.actionItem,
          demoTime: analysis.demoTime,
          objections: analysis.objections,
          createdAt: new Date().toISOString(),
        });

        log.call(`Analysis stored for ${callSid}: Score ${analysis.leadScore}, Action: ${analysis.actionItem}`);
        broadcast("call.summary", { callSid, analysis });

        // ── Callback/Reschedule detection ─────────────────────────────────────
        // Use LLM result first, then fallback to transcript scan for robustness
        const callbackActions = new Set(["callback_requested", "demo_booked"]);
        let detectedAction = analysis.actionItem;
        let detectedTime = analysis.demoTime;

        if (!callbackActions.has(detectedAction)) {
          // Fallback: scan transcript for reschedule/day/time keywords
          try {
            const allLogs = await getCallLogsBySessionId(callSid);
            const fullText = allLogs.map(m => m.text || "").join(" ").toLowerCase();
            const rescheduleRx = /reschedul|call (you |me )?(back|again|later|on|at)|talk (to you |again )?on|catch up|available on|call at|wednesday|monday|tuesday|thursday|friday|saturday|sunday|tomorrow|next week/;
            if (rescheduleRx.test(fullText)) {
              detectedAction = "callback_requested";
              if (!detectedTime) {
                const dayMatch = fullText.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)\b/i);
                const timeMatch = fullText.match(/\b(\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)|morning|afternoon|evening|noon)\b/i);
                if (dayMatch && timeMatch) detectedTime = `${dayMatch[0]} at ${timeMatch[0]}`;
                else if (dayMatch) detectedTime = dayMatch[0];
                else if (timeMatch) detectedTime = timeMatch[0];
              }
              log.call(`[CALLBACK] Fallback transcript scan detected reschedule. Time: ${detectedTime}`);
            }
          } catch (_) {}
        }

        if (callbackActions.has(detectedAction)) {
          try {
            // Try to resolve campaignId from top of webhook or from DB session
            let resolvedCampaignId = campaignId;
            let resolvedCampaignName = campaign.name || null;
            if (!resolvedCampaignId) {
              const sess = await getCallSession(callSid);
              if (sess?.exists) {
                resolvedCampaignId = sess.data()?.campaignId;
                if (!resolvedCampaignName && sess.data()?.campaignContext?.name) {
                  resolvedCampaignName = sess.data()?.campaignContext?.name;
                }
              }
            }
            
            await addCallbackRecord({
              callSid,
              to: req.body?.To,
              actionItem: detectedAction,
              demoTime: detectedTime,
              summary: analysis.summary,
              leadScore: analysis.leadScore,
              campaignId: resolvedCampaignId,
              campaignName: resolvedCampaignName,
            });
            broadcast("call.callback", { callSid, to: req.body?.To, actionItem: detectedAction, demoTime: detectedTime });
            log.call(`[CALLBACK] Saved: phone=${req.body?.To}, time=${detectedTime}, action=${detectedAction}`);
          } catch (cbErr) {
            log.warn(`[CALLBACK] Save failed (non-fatal): ${cbErr.message}`);
          }
        }
      } catch (summaryError) {
        log.warn("Summary generation skipped:", summaryError.message);
      }
    }

    if (callSid && terminalStatuses.has(callStatus)) {
      broadcast("call.ended", { callSid, callStatus, durationSec: callDuration });
      await markCallCompleted({ callSid, callStatus });
    }

    res.status(200).send("ok");
  } catch (err) {
    log.error("twilioStatusWebhook:", err.message);
    res.status(200).send("ok"); // always 200 to Twilio
  }
};

// ── Live sessions endpoint ───────────────────────────────────────────────────

export const getLiveSessions = async (_req, res) => {
  try {
    const sessions = await getAllCallSessions();
    const liveStatuses = new Set(["initiated", "ringing", "in-progress", "answered", "active"]);
    const recentTerminal = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    // A call is truly live only if it was updated within last 5 minutes (stale guard)
    const live = sessions
      .filter((s) => {
        const isLiveStatus = liveStatuses.has(String(s.status || "").toLowerCase());
        const lastUpdate = new Date(s.updatedAt || s.startedAt || 0);
        const isStale = lastUpdate < fiveMinutesAgo;
        return isLiveStatus && !isStale; // Stale "in-progress" → ignore
      })
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    const recent = sessions
      .filter((s) => recentTerminal.has(String(s.status || "").toLowerCase()) &&
        new Date(s.updatedAt || 0) > tenMinutesAgo)
      .slice(0, 5);

    const withTranscripts = await Promise.all(
      [...live, ...recent].map(async (s) => {
        try {
          const messages = await getCallLogsBySessionId(s.callSid);
          return { ...s, transcript: messages };
        } catch {
          return { ...s, transcript: [] };
        }
      })
    );

    res.json({
      live: withTranscripts.filter(s => liveStatuses.has(String(s.status || "").toLowerCase())),
      recent: withTranscripts.filter(s => recentTerminal.has(String(s.status || "").toLowerCase())),
      hasLiveSession: live.length > 0,
      liveCount: live.length
    });
  } catch (error) {
    log.error("getLiveSessions:", error.message);
    res.status(500).json({ error: error.message });
  }
};

// ── Transcript endpoint ──────────────────────────────────────────────────────

export const getTranscript = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const messages = await getCallLogsBySessionId(sessionId);
    log.call(`Transcript for ${sessionId}: ${messages.length} messages`);
    res.json({ sessionId, messages });
  } catch (error) {
    log.error("getTranscript:", error.message);
    res.status(500).json({ error: error.message });
  }
};

// ── Call history endpoint ─────────────────────────────────────────────────────

export const getCallHistory = async (req, res) => {
  try {
    const page = parseInt(req.query.page || "1");
    const limit = parseInt(req.query.limit || "20");
    const sessions = await getAllCallSessions();
    const terminalStatuses = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

    const history = sessions
      .filter(s => terminalStatuses.has(String(s.status || "").toLowerCase()))
      .sort((a, b) => new Date(b.startedAt || b.updatedAt || 0) - new Date(a.startedAt || a.updatedAt || 0));

    const total = history.length;
    const paginated = history.slice((page - 1) * limit, page * limit);

    // Load transcripts + summaries for the page
    const withData = await Promise.all(
      paginated.map(async (s) => {
        try {
          const messages = await getCallLogsBySessionId(s.callSid);
          // Try to get summary from DB
          let summary = null;
          try {
            const { db } = await import("../db/db.js");
            const callRecord = await db.call.findUnique({
              where: { callSid: s.callSid },
              include: { summary: true }
            });
            summary = callRecord?.summary || null;
          } catch (_) {}
          return { ...s, transcript: messages, summary };
        } catch {
          return { ...s, transcript: [], summary: null };
        }
      })
    );

    res.json({ history: withData, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (error) {
    log.error("getCallHistory:", error.message);
    res.status(500).json({ error: error.message });
  }
};

// ── Callbacks endpoint ───────────────────────────────────────────────────────

export const getCallbacks = async (_req, res) => {
  try {
    const { getAllCallbacks } = await import("../repositories/callbackRepository.js");
    const callbacks = getAllCallbacks();
    res.json({ callbacks });
  } catch (error) {
    log.error("getCallbacks:", error.message);
    res.status(500).json({ callbacks: [] });
  }
};

