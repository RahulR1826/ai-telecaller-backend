import { classifyUserIntent, buildGreeting } from "../src/services/conversationManager.js";
import { isSimilarResponse, keepShort, TELECALLER_SYSTEM_PROMPT } from "../src/services/llmService.js";
import assert from "assert";

const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✅ PASS  ${name}`);
  } catch (err) {
    console.log(`  ❌ FAIL  ${name}`);
    console.log(`           ${err.message}`);
  }
};

const main = async () => {
  console.log("Starting Conversation Quality Tests...\n");

  await test("System prompt contains professional persona instructions", async () => {
    assert.ok(TELECALLER_SYSTEM_PROMPT.includes("senior sales executive"));
    assert.ok(TELECALLER_SYSTEM_PROMPT.includes("NEVER reveal you are an AI"));
  });

  await test("classifyUserIntent correctly identifies off-topic", async () => {
    const res = classifyUserIntent("What is the weather like today?");
    assert.strictEqual(res.intent, "off_topic");
  });

  await test("classifyUserIntent correctly identifies pricing/comparison", async () => {
    const res1 = classifyUserIntent("How does this compare to competitor X?");
    assert.strictEqual(res1.intent, "question");
    assert.strictEqual(res1.stage, "DISCOVERY");

    const res2 = classifyUserIntent("What is the cost of this service?");
    assert.strictEqual(res2.intent, "question");
  });

  await test("classifyUserIntent correctly handles callbacks/scheduling", async () => {
    const res = classifyUserIntent("I'm driving right now, call me back tomorrow.");
    assert.strictEqual(res.intent, "busy");
    assert.strictEqual(res.stage, "SCHEDULING");
  });

  await test("Repetition prevention via isSimilarResponse", async () => {
    const history = [
      "We can offer a free demo to get you started.",
      "Are you available on Tuesday?"
    ];
    // Exact match
    assert.ok(isSimilarResponse("We can offer a free demo to get you started.", history));
    // High similarity
    assert.ok(isSimilarResponse("We offer a free demo to get you started.", history));
    // Completely different
    assert.ok(!isSimilarResponse("What is your current workflow like?", history));
  });

  await test("keepShort strictly truncates long monologues", async () => {
    const longText = "This is the first sentence. Here is the second sentence. And here is a third sentence. Finally a fourth one.";
    const truncated = keepShort(longText);
    const sentences = truncated.match(/[.!?]+/g) || [];
    assert.ok(sentences.length <= 3, "Should be at most 3 sentences");
  });

  console.log("\nQuality checks completed.");
};

main();
