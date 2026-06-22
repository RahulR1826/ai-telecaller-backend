import { getSession, updateSession } from "../repositories/sessionRepository.js";
import {
  TELECALLER_SYSTEM_PROMPT,
  buildCampaignInjection,
  generateConversationResponse,
  generateSummaryResponse,
} from "./llmService.js";

const sessions = new Map();

const emptyCampaign = {
  business_name: "AI Tele Caller",
  product: "AI calling automation",
  offer: "a free demo",
  objective: "check if this could be useful",
};

const normalizeText = (value = "") =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const classifyUserIntent = (text = "") => {
  const normalized = normalizeText(text);

  if (!normalized) return { intent: "silent", stage: "DISCOVERY" };
  if (/\b(bye|goodbye|talk to you later|catch you later|thanks bye|see ya)\b/.test(normalized)) {
    return { intent: "goodbye", stage: "GOODBYE" };
  }
  // Customer says bad time at greeting ("no", "not now", "bad time", "busy", "in a meeting")
  if (/\b(no\b|not now|not a good time|bad time|busy|in a meeting|meeting|driving|can(not|'t) talk|not right now)\b/.test(normalized)) {
    return { intent: "bad_time", stage: "SCHEDULING" };
  }
  if (/\b(call me later|callback|call back|later|tomorrow|next week)\b/.test(normalized)) {
    return { intent: "busy", stage: "SCHEDULING" };
  }
  if (/\b(not interested|no thanks|stop|remove me|do not call|unsubscribe|don t call|not looking|we are good|we're good)\b/.test(normalized)) {
    return { intent: "negative", stage: "OBJECTION" };
  }
  if (/\b(interested|demo|schedule|book|sure|okay|let s do it|sounds good|yes|yeah|why not|tell me more|let's do it|perfect|go ahead|of course)\b/.test(normalized)) {
    return { intent: "interested", stage: "BOOKED" };
  }
  // Customer says yes to greeting → move to PITCH
  if (/\b(yes|yeah|sure|ok|okay|go ahead|of course|absolutely|fine|alright)\b/.test(normalized)) {
    return { intent: "good_time", stage: "PITCH" };
  }
  if (/\b(weather|sports|joke|off topic|random)\b/.test(normalized)) {
    return { intent: "off_topic", stage: "PITCH" };
  }
  if (/\b(what|how|why|which|when|where|who|cost|price|pricing|integrat|crm|process|workflow|compare|competitor|better|difference)\b/.test(normalized)) {
    return { intent: "question", stage: "DISCOVERY" };
  }

  return { intent: "neutral", stage: "PITCH" };
};


export const getCampaignContext = (campaign = {}) => {
  const normalized = buildCampaignInjection(campaign);
  return {
    ...emptyCampaign,
    ...normalized,
  };
};

export const getConversation = (sessionId) => {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      messages: [{ role: "system", content: TELECALLER_SYSTEM_PROMPT }],
      lastAiResponses: [],
      stage: "GREETING",
      turnCount: 0,
      questionCount: 0,
      campaignContext: { ...emptyCampaign },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return sessions.get(sessionId);
};

export const hydrateConversation = async (sessionId, campaign = {}) => {
  const conversation = getConversation(sessionId);

  if (!conversation._hydrated) {
    try {
      const snapshot = await getSession(sessionId);
      if (snapshot.exists) {
        const data = snapshot.data() || {};
        if (Array.isArray(data.history) && data.history.length > 0) {
          conversation.messages = data.history;
        }
        if (Array.isArray(data.lastAiResponses)) {
          conversation.lastAiResponses = data.lastAiResponses.slice(-3);
        }
        if (data.stage) conversation.stage = data.stage;
        if (typeof data.turnCount === "number") conversation.turnCount = data.turnCount;
        if (typeof data.questionCount === "number") conversation.questionCount = data.questionCount;
        if (data.campaignContext) {
          conversation.campaignContext = {
            ...emptyCampaign,
            ...data.campaignContext,
          };
        }
      }
    } catch (error) {
      console.warn("[conversation] hydrate failed:", error.message);
    }

    conversation._hydrated = true;
  }

  if (campaign && Object.keys(campaign).length > 0) {
    conversation.campaignContext = getCampaignContext({
      ...conversation.campaignContext,
      ...campaign,
    });
  } else {
    conversation.campaignContext = getCampaignContext(conversation.campaignContext);
  }
  conversation.updatedAt = new Date().toISOString();
  return conversation;
};

export const buildGreeting = (campaign = {}) => {
  const context = getCampaignContext(campaign);
  const name = campaign.customerName || campaign.customer_name || null;
  const businessName = context.business_name || "our company";
  const nameStr = name ? `, ${name}` : "";
  const greeting = `Hi${nameStr}! This is Alex calling from ${businessName}. Is this a good time to speak for just two minutes?`;
  return greeting.replace(/\s+/g, " ").trim();
};


const appendConversationMessage = (conversation, role, content) => {
  conversation.messages.push({ role, content });
  conversation.updatedAt = new Date().toISOString();
};

const buildConversationPayload = ({ conversation, userText, campaignContext, stage, forceQuestion = false }) => {
  const recentMessages = conversation.messages
    .filter((message) => message.role !== "system")
    .slice(-30);

  const campaignBlock = JSON.stringify({
    ...emptyCampaign,
    ...campaignContext
  });
  const recentAi = conversation.lastAiResponses.slice(-3).join(" | ") || "none";
  
  const customPlaybooks = [];
  if (campaignContext?.objection_playbook) customPlaybooks.push(`Objection Playbook: ${campaignContext.objection_playbook}`);
  if (campaignContext?.faqs) customPlaybooks.push(`FAQs: ${campaignContext.faqs}`);

  const stageInstructions = {
    GREETING: "You just asked if it's a good time. Wait for their answer. Do NOT pitch yet.",
    PITCH: "They said it's a good time. Give ONE short sentence about what you offer and why it could help them. Then ask ONE open question to learn about their needs.",
    DISCOVERY: "Ask a targeted, open-ended question to understand their current workflow or pain points.",
    OBJECTION: "Acknowledge their concern empathetically. Do not argue. Provide a short pivot.",
    SCHEDULING: "They said it's not a good time right now. Politely say 'No problem at all!' and ask ONE question: 'When would be a better time for me to call you back?' Then confirm the time they give and end the call warmly.",
    CLOSING: "Confirm the next steps and politely end the conversation.",
    BOOKED: "Great! They showed interest or booked. Now explicitly confirm the appointment, summarize briefly what will be discussed, and start wrapping up. Do NOT ask any new discovery questions.",
    CONFIRMED: "The appointment is confirmed. Say a polite goodbye and end the conversation naturally.",
    GOODBYE: "Say goodbye politely. DO NOT ask any questions.",
    END_CALL: "The conversation is completely over. Do not say anything else."
  };
  
  const currentStageInstruction = stageInstructions[stage] || stageInstructions.DISCOVERY;

  const instructions = [
    TELECALLER_SYSTEM_PROMPT,
    `Campaign context: ${campaignBlock}`,
    `Current stage: ${stage} - ${currentStageInstruction}`,
    `Previous AI responses: ${recentAi}`,
    customPlaybooks.length > 0 ? customPlaybooks.join("\n") : "",
    forceQuestion
      ? "Ask exactly ONE short question after answering."
      : "If natural, you may ask ONE short question. Never ask more than one.",
    "Do not repeat phrases or reuse the previous wording.",
    "Use 1-3 sentences only."
  ].join("\n\n");

  return [
    { role: "system", content: instructions },
    ...recentMessages,
    ...(userText ? [{ role: "user", content: userText }] : []),
  ];
};

const enforceQuestionRule = (reply, conversation) => {
  return reply;
};

export const generateGreetingAndStore = async ({ sessionId, campaign = {} }) => {
  const conversation = await hydrateConversation(sessionId, campaign);
  if (conversation.messages.length > 1) {
    // Already past greeting
    return "I'm still here whenever you're ready.";
  }
  const greeting = buildGreeting(campaign);
  appendConversationMessage(conversation, "assistant", greeting);
  conversation.lastAiResponses.push(greeting);
  conversation.turnCount = 1;
  conversation.stage = "PITCH";
  await persistConversation(sessionId, conversation);
  return greeting;
};

export const generateConversationTurn = async ({ sessionId, userText, campaign = {}, source = "twilio" }) => {
  const conversation = await hydrateConversation(sessionId, campaign);
  const userIntent = classifyUserIntent(userText);
  
  const isTerminal = ["BOOKED", "CONFIRMED", "GOODBYE", "END_CALL"].includes(conversation.stage);

  if (isTerminal) {
    if (conversation.stage === "BOOKED" && userIntent.stage !== "OBJECTION") {
      conversation.stage = "CONFIRMED";
    } else if (conversation.stage === "CONFIRMED") {
      conversation.stage = "GOODBYE";
    } else if (conversation.stage === "GOODBYE") {
      conversation.stage = "END_CALL";
    }
  } else {
    if (conversation.turnCount <= 1 && userIntent.stage !== "BOOKED" && userIntent.stage !== "OBJECTION" && userIntent.stage !== "GOODBYE") {
      conversation.stage = "DISCOVERY";
    } else if (userIntent.stage) {
      conversation.stage = userIntent.stage;
    }
  }

  appendConversationMessage(conversation, "user", userText);

  const promptMessages = buildConversationPayload({
    conversation,
    userText,
    campaignContext: conversation.campaignContext,
    stage: conversation.stage,
    forceQuestion: conversation.questionCount % 2 === 1 && !isTerminal,
  });



  let reply = await generateConversationResponse({
    messages: promptMessages,
    previousResponses: conversation.lastAiResponses,
  });

  reply = enforceQuestionRule(reply, conversation);



  if (conversation.lastAiResponses.length > 0) {
    conversation.lastAiResponses = conversation.lastAiResponses.slice(-3);
  }
  conversation.lastAiResponses.push(reply);
  conversation.lastAiResponses = conversation.lastAiResponses.slice(-3);
  conversation.turnCount += 1;
  conversation.questionCount += reply.includes("?") ? 1 : 0;
  conversation.stage = userIntent.stage === "CLOSING" ? "CLOSING" : conversation.stage;

  appendConversationMessage(conversation, "assistant", reply);
  await persistConversation(sessionId, conversation, source, userIntent);


  return {
    reply,
    conversation,
    userIntent,
    stage: conversation.stage,
    campaignContext: conversation.campaignContext,
  };
};

export const generateCallSummary = async (sessionId) => {
  const conversation = await hydrateConversation(sessionId, {});
  const transcript = conversation.messages.filter((message) => message.role !== "system");
  return generateSummaryResponse({ messages: transcript });
};

export const persistConversation = async (sessionId, conversation, source = "twilio", userIntent = null) => {
  try {
    await updateSession(sessionId, {
      history: conversation.messages,
      campaignContext: conversation.campaignContext,
      lastAiResponses: conversation.lastAiResponses,
      stage: conversation.stage,
      turnCount: conversation.turnCount,
      questionCount: conversation.questionCount,
      updatedAt: conversation.updatedAt,
      source,
      userIntent: userIntent?.intent || null,
    });
  } catch (err) {
    console.warn("[conversation] persistConversation DB failed (non-fatal):", err.message);
  }
};

export const getConversationSnapshot = (sessionId) => {
  const conversation = getConversation(sessionId);
  return {
    sessionId: conversation.sessionId,
    stage: conversation.stage,
    turnCount: conversation.turnCount,
    questionCount: conversation.questionCount,
    campaignContext: conversation.campaignContext,
    lastAiResponses: conversation.lastAiResponses,
    messages: conversation.messages,
  };
};
