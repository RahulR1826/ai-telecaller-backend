import { getLeads, updateLead } from "../repositories/leadRepository.js";
import { getCalls, getCallsByLeadId } from "../repositories/callRepository.js";
import { addCampaign, getCampaigns } from "../repositories/campaignRepository.js";
import { log } from "../utils/logger.js";
import Groq from "groq-sdk";

export const executeTool = async (name, args, context) => {
  console.log(`[NEXUS] Executing Nexus Tool: ${name} with args:`, args);
  try {
    switch (name) {
      case "searchLeads":
        return await searchLeads(args, context);
      case "searchTranscript":
        return await searchTranscript(args, context);
      case "summarizeCall":
        return await summarizeCall(args, context);
      case "showAnalytics":
        return await showAnalytics(args, context);
      case "createCampaign":
        return await createCampaign(args, context);
      case "generateSalesScript":
        return await generateSalesScript(args, context);
      case "bookCallback":
        return await bookCallback(args, context);
      case "generateFollowup":
        return await generateFollowup(args, context);
      case "prioritizeLeads":
        return await prioritizeLeads(args, context);
      case "campaignAnalysis":
        return await campaignAnalysis(args, context);
      default:
        return { error: `Tool ${name} not found.` };
    }
  } catch (error) {
    log.error(`Tool execution error [${name}]:`, error);
    return { error: error.message };
  }
};

async function searchLeads(args, context) {
  let leads = await getLeads();
  
  if (args.minScore) leads = leads.filter(l => (l.leadScore || 0) >= args.minScore);
  if (args.status) leads = leads.filter(l => l.status === args.status);
  
  return leads.slice(0, 10).map(l => ({
    name: l.name, phone: l.phone, score: l.leadScore, status: l.status
  }));
}

async function searchTranscript(args, context) {
  const calls = await getCalls();
  const results = calls.filter(c => c.transcript && c.transcript.toLowerCase().includes(args.keyword.toLowerCase()));
  return results.slice(0, 5).map(c => ({
    leadName: c.leadName || "Unknown",
    transcriptSnippet: c.transcript.substring(0, 200) + "..."
  }));
}

async function summarizeCall(args, context) {
  let customerId = args.customerId || context?.selectedCustomer;
  if (!customerId) return { error: "No customer selected." };
  
  const calls = await getCallsByLeadId(customerId);
  if (calls.length === 0) return { error: "No calls found for this customer." };
  
  const lastCall = calls[calls.length - 1];
  return {
    summary: lastCall.summary || "No summary available.",
    transcript: lastCall.transcript || "No transcript available.",
    duration: lastCall.duration
  };
}

async function showAnalytics(args, context) {
  const calls = await getCalls();
  const leads = await getLeads();
  
  const totalCalls = calls.length;
  const avgLeadScore = leads.length ? Math.round(leads.reduce((sum, l) => sum + (l.leadScore || 0), 0) / leads.length) : 0;
  
  return {
    totalCalls,
    totalLeads: leads.length,
    avgLeadScore,
    todayCalls: totalCalls // Placeholder for actual today count
  };
}

async function createCampaign(args, context) {
  const newCampaign = {
    name: args.name || "AI Generated Campaign",
    businessName: args.businessName,
    product: args.product,
    offer: args.offer,
    objective: args.objective,
    status: "draft",
    createdAt: new Date().toISOString()
  };
  const result = await addCampaign(newCampaign);
  return { success: true, campaignId: result.id, ...newCampaign };
}

async function generateSalesScript(args, context) {
  return {
    script: `
Greeting: Hi, am I speaking with {name}?
Pitch: I'm calling from ${args.businessName || "our company"} because you expressed interest...
Questions: What are your current challenges?
Closing: Would you be open to a quick demo tomorrow?`
  };
}

async function bookCallback(args, context) {
  let customerId = args.customerId || context?.selectedCustomer;
  if (!customerId) return { error: "No customer selected." };
  
  await updateLead(customerId, {
    nextAction: "callback",
    callbackTime: args.time
  });
  
  return { success: true, message: `Callback booked for ${args.time}` };
}

async function generateFollowup(args, context) {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: "You are an expert sales assistant." },
      { role: "user", content: `Generate a short ${args.type} follow-up message for a customer.` }
    ],
    max_tokens: 150
  });
  return { message: response.choices[0]?.message?.content?.trim() };
}

async function prioritizeLeads(args, context) {
  let leads = await getLeads();
  
  leads.sort((a, b) => (b.leadScore || 0) - (a.leadScore || 0));
  return leads.slice(0, 10).map(l => ({ name: l.name, score: l.leadScore, status: l.status }));
}

async function campaignAnalysis(args, context) {
  let campaignId = args.campaignId || context?.selectedCampaign;
  if (!campaignId) return { error: "No campaign selected." };
  
  return {
    strengths: ["High open rate", "Good initial engagement"],
    weaknesses: ["Low conversion on pitch", "Pricing objections"],
    recommendations: ["Adjust pricing offer", "Shorten the script"]
  };
}

export const nexusToolsDefinition = [
  {
    type: "function",
    function: {
      name: "searchLeads",
      description: "Search for leads based on minimum score or status",
      parameters: {
        type: "object",
        properties: {
          minScore: { type: "number" },
          status: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "searchTranscript",
      description: "Search past call transcripts for a keyword",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string" }
        },
        required: ["keyword"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "summarizeCall",
      description: "Summarize the last call of a customer",
      parameters: {
        type: "object",
        properties: {
          customerId: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "showAnalytics",
      description: "Show overall CRM analytics like call count and lead score",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "createCampaign",
      description: "Create a new campaign automatically",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          businessName: { type: "string" },
          product: { type: "string" },
          offer: { type: "string" },
          objective: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "generateSalesScript",
      description: "Generate a sales script for a campaign or business",
      parameters: {
        type: "object",
        properties: {
          businessName: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bookCallback",
      description: "Book a callback for a specific time",
      parameters: {
        type: "object",
        properties: {
          customerId: { type: "string" },
          time: { type: "string", description: "Time of the callback" }
        },
        required: ["time"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "generateFollowup",
      description: "Generate a follow up message for Email, WhatsApp or SMS",
      parameters: {
        type: "object",
        properties: {
          customerId: { type: "string" },
          type: { type: "string", enum: ["Email", "WhatsApp", "SMS"] }
        },
        required: ["type"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "prioritizeLeads",
      description: "Sort leads by score and interest",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "campaignAnalysis",
      description: "Analyze a campaign's performance",
      parameters: {
        type: "object",
        properties: {
          campaignId: { type: "string" }
        }
      }
    }
  }
];
