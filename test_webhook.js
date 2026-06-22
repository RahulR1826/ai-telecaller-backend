import express from 'express';
import { handleCall } from './src/controllers/callController.js';
import twilio from 'twilio';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// mock the dependencies to isolate the controller
import { twilioVoiceWebhook } from './src/controllers/callController.js';

app.post('/test', twilioVoiceWebhook);

app.listen(9999, async () => {
    try {
        const response = await fetch('http://localhost:9999/test', {
            method: 'POST',
            body: new URLSearchParams({
                CallSid: '123',
                Direction: 'outbound-api',
                From: '123',
                To: '456'
            }),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        const text = await response.text();
        console.log("RESPONSE:", response.status, text);
        process.exit(0);
    } catch(e) {
        console.error(e);
        process.exit(1);
    }
});
