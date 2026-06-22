import twilio from "twilio";
const vr = new twilio.twiml.VoiceResponse();
const gather = vr.gather({
  input: "speech",
  speechTimeout: "auto",
  action: "/api/call/twilio/voice",
  method: "POST",
  language: "en-IN",
});
gather.say("Hello");
vr.redirect({ method: "POST" }, "/api/call/twilio/voice");
console.log(vr.toString());
