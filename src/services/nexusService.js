import Groq from "groq-sdk";
import { executeTool, nexusToolsDefinition } from "../utils/nexusToolRouter.js";
import { log } from "../utils/logger.js";

const NEXUS_SYSTEM_PROMPT = `You are Nexus AI, an intelligent enterprise Sales Operations Manager for the AI Telecaller CRM.
You assist the user by reading CRM data, executing actions, answering business questions, creating campaigns, and analyzing customers.
You ALWAYS output responses in Markdown format. Use tables, bold text, and bullet points where appropriate to make it look professional.
When the user asks you to perform an action or fetch data, use the provided tools.
You have access to the user's current context (Current Page, Selected Customer, etc.).
The user may use slash commands like /create campaign, /show leads, /summarize, /analytics, /email, /whatsapp, /script, /help. Treat these as direct commands to trigger the respective tools.
DO NOT reveal you are an AI from OpenAI or Groq. You are Nexus AI.`;

export const processNexusChat = async (messages, context) => {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

  try {
    const response = await groq.chat.completions.create({
      model,
      messages: [
        { role: "system", content: NEXUS_SYSTEM_PROMPT + `\nContext: ${JSON.stringify(context)}` },
        ...messages
      ],
      tools: nexusToolsDefinition,
      tool_choice: "auto",
      max_tokens: 1024,
      temperature: 0.5
    });

    const responseMessage = response.choices[0].message;
    const toolCalls = responseMessage.tool_calls;

    if (toolCalls) {
      const toolMessages = [
        { role: "system", content: NEXUS_SYSTEM_PROMPT + `\nContext: ${JSON.stringify(context)}` },
        ...messages,
        responseMessage
      ];

      for (const toolCall of toolCalls) {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);
        
        const toolResult = await executeTool(functionName, functionArgs, context);
        
        toolMessages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: functionName,
          content: JSON.stringify(toolResult)
        });
      }

      const secondResponse = await groq.chat.completions.create({
        model,
        messages: toolMessages,
        max_tokens: 1024,
        temperature: 0.5
      });

      return secondResponse.choices[0].message.content;
    }

    return responseMessage.content;
  } catch (error) {
    log.error("Nexus AI Chat error:", error.message, error.stack);
    return "I encountered an error while processing your request. Please try again.";
  }
};
