import axios from "axios";

export const textToSpeech = async (text) => {
  const apiKey = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || process.env.ELEVEN_VOICE_ID;

  if (!apiKey || !voiceId) {
    return Buffer.alloc(0); // return empty buffer if TTS not configured
  }
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    { text },
    {
      headers: { "xi-api-key": apiKey },
      responseType: "arraybuffer",
    }
  );
  return response.data;
};
