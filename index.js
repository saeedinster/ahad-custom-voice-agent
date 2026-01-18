require('dotenv').config();
const express = require('express');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const OpenAI = require('openai');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: true }));

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
      phone: null,
      booking_completed: false,
      conversation_ended: false
    };
  }
  const memory = conversationMemory[callSid];

  // OpenAI logic (matches your YML)
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: `You are a friendly CPA receptionist for Ahad and Co. Greet: "Thanks for calling Ahad and Co CPA Firm. How can I help you today?" Handle tax requests (personal, business, info, consultation) by offering free 15-min consultation. Collect info slowly (spell email/phone letter by letter). Ask previous client once. Ask referral once if not returning. Ask call reason. Book appointment. Send to n8n on booking. End with one "Goodbye". Remember context.` },
      { role: "user", content: userSpeech || "start" },
      { role: "assistant", content: `Current memory: ${JSON.stringify(memory)}` }
    ],
  });
  let agentText = completion.choices[0].message.content.trim();

  // Update memory (parse from LLM)
  if (agentText.toLowerCase().includes("previous client")) memory.previous_client = agentText.includes("Yes") ? "Yes" : "No";
  if (agentText.toLowerCase().includes("referral")) memory.referral_source = agentText.match(/referral: (.*)/)?.[1] || null;
  if (agentText.toLowerCase().includes("first name")) memory.first_name = agentText.match(/first name: (.*)/)?.[1] || null;
  if (agentText.toLowerCase().includes("last name")) memory.last_name = agentText.match(/last name: (.*)/)?.[1] || null;
  if (agentText.toLowerCase().includes("email")) memory.email = agentText.match(/email: (.*)/)?.[1] || null;
  if (agentText.toLowerCase().includes("phone")) memory.phone = agentText.match(/phone: (.*)/)?.[1] || null;
  if (agentText.toLowerCase().includes("reason")) memory.call_reason = agentText.match(/reason: (.*)/)?.[1] || null;

  // Twilio <Say> voice (warm, slow, professional - Joanna is free & reliable)
  twiml.say({
    voice: "Polly.Joanna-Neural",  // Warm American female (free in Twilio)
    language: "en-US",
    rate: "slow"  // Slow for email/phone spelling
  }, agentText);

  // Send to n8n if booked
  if (agentText.toLowerCase().includes("booked") || agentText.toLowerCase().includes("appointment is booked")) {
    memory.booking_completed = true;
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

  // End call if ended
  if (agentText.toLowerCase().includes("goodbye")) memory.conversation_ended = true;

  res.type('text/xml');
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
