require('dotenv').config();
const express = require('express');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const { ElevenLabsClient } = require('elevenlabs');
const OpenAI = require('openai');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: true }));

const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const n8nWebhook = process.env.N8N_WEBHOOK;

// Simple memory per call
const conversationMemory = {};

app.post('/voice', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || '';

  if (!conversationMemory[callSid]) {
    conversationMemory[callSid] = {
      step: 'greeting',
      previous_client: null,
      referral_source: null,
      call_reason: null,
      first_name: null,
      last_name: null,
      email: null,
      phone: null
    };
  }
  const memory = conversationMemory[callSid];

  // LLM logic (like your YML)
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: `You are a friendly CPA receptionist for Ahad and Co. Greet: "Thanks for calling Ahad and Co CPA Firm. How can I help you today?" Handle personal/business tax requests by offering free 15-min consultation. Collect info slowly (spell email/phone letter by letter). Remember previous_client, referral_source. Book via Cal.com if possible. Send to n8n on booking. End call with one "Goodbye".` },
      { role: "user", content: userSpeech },
      { role: "assistant", content: `Current memory: ${JSON.stringify(memory)}` }
    ],
  });
  const agentText = completion.choices[0].message.content;

  // Update memory from LLM (simple)
  if (agentText.includes("returning client")) memory.previous_client = "Yes";
  if (agentText.includes("referral")) memory.referral_source = agentText.match(/referral: (.*)/)?.[1] || null;
  if (agentText.includes("first name")) memory.first_name = agentText.match(/first name: (.*)/)?.[1] || null;
  // Add more parsing as needed

  // TTS with ElevenLabs
  const audioStream = await elevenlabs.generate({
    voice: process.env.ELEVENLABS_VOICE_ID,
    text: agentText,
    model_id: "eleven_multilingual_v2",
  });

  twiml.play({ url: audioStream.url });

  // Send to n8n on booking
  if (agentText.includes("booked")) {
    await axios.post(n8nWebhook, {
      type: "appointment_booking",
      first_name: memory.first_name || "Unknown",
      last_name: memory.last_name || "Unknown",
      phone: memory.phone || req.body.From,
      email_address: memory.email || "unknown@example.com",
      selected_slot: "2026-01-20T11:00:00", // Replace with real later
      call_reason: memory.call_reason || "Tax consultation",
      referral_source: memory.referral_source || "Unknown",
      previous_client: memory.previous_client || "No",
      summary: agentText,
      timestamp: new Date().toISOString(),
      booking_status: "confirmed"
    });
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));