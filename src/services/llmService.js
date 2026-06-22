import Groq from "groq-sdk";

export const TELECALLER_SYSTEM_PROMPT = `You are Alex, a senior sales executive.
Persona:
- You are a highly professional, empathetic, and persuasive human sales expert.
- Tone: Confident, warm, consultative, conversational.
- NEVER reveal you are an AI, a bot, or a language model. You are a real person.
- Actively listen. Use natural filler words ("Got it", "Makes sense", "I see") sparingly.

Rules & Guidelines:
1. Conciseness: Keep EVERY response to 1-3 short, punchy sentences. Speak like a human.
2. Contextual Flow: Adapt to the current conversation stage smoothly.
3. Question Frequency: NEVER ask more than ONE question per response. Always answer first, then ask your question second.
4. Pricing: If asked about pricing, provide a brief answer instead of deferring completely (e.g., "Our pricing depends on the package and business size, but I'll explain every option during tomorrow's call.").
5. Terminal States (BOOKED / CONFIRMED / GOODBYE): If the stage is BOOKED or CONFIRMED, transition directly towards ending the call. Confirm the appointment, summarize what will be discussed, and end naturally. DO NOT reopen discovery. After GOODBYE, do not ask any further questions.
6. Objection Handling: Use empathy and pivot gracefully back to value.
7. Repetition: NEVER repeat a sentence or phrase you've already used.
8. Campaign Context: Always use the actual campaign data provided.`;

const normalizeText = (value = "") =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const sentenceCount = (value = "") => {
  const matches = String(value).match(/[.!?]+/g);
  return matches ? matches.length : 1;
};

export const keepShort = (text = "") => {
  const trimmed = String(text).trim();
  if (!trimmed) return trimmed;

  const sentences = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length <= 4) return trimmed; // Allow up to 4 sentences for natural flow
  return `${sentences.slice(0, 3).join(" ").trim()}`; // Truncate to 3 if it gets too long
};

export const isSimilarResponse = (candidate = "", previousResponses = []) => {
  const normalizedCandidate = normalizeText(candidate);
  if (!normalizedCandidate) return false;

  return previousResponses.some((previous) => {
    const normalizedPrevious = normalizeText(previous);
    if (!normalizedPrevious) return false;

    if (normalizedCandidate === normalizedPrevious) return true;
    if (normalizedCandidate.includes(normalizedPrevious) || normalizedPrevious.includes(normalizedCandidate)) {
      return true;
    }

    const candidateTokens = new Set(normalizedCandidate.split(" ").filter(Boolean));
    const previousTokens = new Set(normalizedPrevious.split(" ").filter(Boolean));
    const union = new Set([...candidateTokens, ...previousTokens]);
    let intersection = 0;
    for (const token of candidateTokens) {
      if (previousTokens.has(token)) intersection += 1;
    }

    const jaccard = union.size > 0 ? intersection / union.size : 0;
    return jaccard >= 0.7;
  });
};

export const buildCampaignInjection = (campaign = {}) => {
  const businessName = campaign.business_name || campaign.businessName || campaign.company_name || campaign.companyName || "AI Tele Caller";
  const product = campaign.product || campaign.productService || campaign.service || "AI calling automation";
  const offer = campaign.offer || campaign.value_offer || campaign.valueProp || "a free demo";
  const objective = campaign.objective || campaign.campaignObjective || campaign.goal || "check if this could be useful";
  const objection_playbook = campaign.objection_playbook || campaign.playbook || "";
  const faqs = campaign.faqs || "";

  return {
    business_name: businessName,
    product,
    offer,
    objective,
    objection_playbook,
    faqs
  };
};

const getGroqClient = () => {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is missing from environment variables");
  }
  return new Groq({
    apiKey: process.env.GROQ_API_KEY,
  });
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const generateWithGroqRetry = async (messages, isJson = false) => {
  const groq = getGroqClient();
  const maxRetries = 3;
  const backoffDelays = [1000, 2000, 4000]; // 1s, 2s, 4s

  const apiKeyPrefix = process.env.GROQ_API_KEY?.substring(0, 10);

  if (apiKeyPrefix === "YOUR_GROQ_" || !apiKeyPrefix) {
    throw new Error(`STOP: Invalid API Key loaded. Prefix is: ${apiKeyPrefix}. Restart the server entirely.`);
  }

  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";


  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await groq.chat.completions.create({
        model: model,
        messages: [
          { role: "system", content: TELECALLER_SYSTEM_PROMPT },
          ...messages,
        ],
        temperature: 0.8,
        presence_penalty: 0.6,
        frequency_penalty: 0.7,
        max_tokens: 120,
        response_format: isJson ? { type: "json_object" } : { type: "text" },
      });

      return response.choices[0]?.message?.content?.trim() || "";
    } catch (error) {
      const status = error?.status || error?.response?.status || error?.status_code;
      const isRetryable = status === 429 || status === 500 || status === 502 || status === 503;
      
      if (attempt < maxRetries && isRetryable) {
        console.warn(`[GROQ] Attempt ${attempt + 1} failed with status ${status}. Retrying in ${backoffDelays[attempt]}ms...`);
        await delay(backoffDelays[attempt]);
        continue;
      }
      
      console.error(`[GROQ] All retries failed or non-retryable error:`, error.message);
      throw error;
    }
  }
};

export const generateConversationResponse = async ({
  messages,
  previousResponses = [],
}) => {
  if (process.env.MOCK_LLM === "true") {
    return "Mocked AI Response to keep the flow moving without hitting Groq API.";
  }

  const safeMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  let reply = "";

  try {
    const rawReply = await generateWithGroqRetry(safeMessages, false);
    reply = keepShort(rawReply);
    
    if (reply && isSimilarResponse(reply, previousResponses)) {
       reply = "Could you tell me a bit more about your current setup?";
    }
  } catch (error) {

    reply = "Could you tell me a bit more about your current setup?";
  }

  if (sentenceCount(reply) > 3) {
    reply = keepShort(reply);
  }

  return reply;
};

export const generateSummaryResponse = async ({ messages }) => {
  const summaryMessages = [
    {
      role: "user",
      content: `You are a CRM data extractor. Analyze this sales call transcript.

STRICT CLASSIFICATION RULES:
1. If the customer asked to reschedule, was busy, agreed to be called back, or a specific day/time was confirmed for the next call → actionItem = "callback_requested"
2. If the customer agreed to a product demo → actionItem = "demo_booked"
3. If the customer was clearly not interested / hung up / said no → actionItem = "not_interested"
4. Otherwise → actionItem = "follow_up_needed"

TIME EXTRACTION (critical):
- Search ALL messages for any mention of days (Monday-Sunday), times (5pm, 10am, morning, afternoon, evening), or relative time (tomorrow, next week)
- If found, extract exactly as spoken e.g. "Wednesday at 5:00 PM", "Tuesday morning", "tomorrow at 10 AM"
- If the AI agent confirmed a callback time, that is the demoTime
- Return null ONLY if absolutely no time/day was mentioned anywhere

Return ONLY valid JSON (no markdown):
{"summary":"<2-3 sentences>","leadScore":<0-100>,"actionItem":"<demo_booked|callback_requested|not_interested|follow_up_needed>","demoTime":"<day and time or null>","objections":"<main objection or null>","nextAction":"<next step>"}`
    },
    ...(Array.isArray(messages) ? messages.slice(-20) : []),
  ];

  try {
    const jsonString = await generateWithGroqRetry(summaryMessages, true);
    const parsed = JSON.parse(jsonString);
    if (Array.isArray(parsed.objections)) parsed.objections = parsed.objections.join(", ");
    return parsed;
  } catch (err) {
    console.error("Failed to generate structured summary:", err.message);
    return {
      summary: "Call completed. Failed to generate structured analysis.",
      leadScore: 0,
      actionItem: "follow_up_needed",
      demoTime: null,
      objections: null,
      nextAction: "Follow up via email"
    };
  }
};

