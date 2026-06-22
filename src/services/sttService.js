import axios from "axios";
import FormData from "form-data";

export const speechToText = async (audioBuffer) => {
  const formData = new FormData();
  formData.append("audio", audioBuffer, { filename: "audio.webm", contentType: "audio/webm" });

  const response = await axios.post(
    "https://api.elevenlabs.io/v1/speech-to-text",
    formData,
    {
      headers: {
        "xi-api-key": process.env.ELEVEN_API_KEY,
        ...formData.getHeaders(),
      },
    }
  );

  return response.data.text;
};
