export const analyzeLead = (text) => {
  text = text.toLowerCase();

  if (text.includes("interested")) {
    return { intent: "Interested", sentiment: "Positive" };
  } else if (text.includes("not interested")) {
    return { intent: "Not Interested", sentiment: "Negative" };
  } else if (text.includes("later")) {
    return { intent: "Callback", sentiment: "Neutral" };
  }

  return { intent: "Unknown", sentiment: "Neutral" };
};
