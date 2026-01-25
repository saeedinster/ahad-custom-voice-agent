require('dotenv').config();
const express = require('express');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const { ElevenLabsClient } = require('elevenlabs');
const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check endpoint for Render
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Ahad CPA Voice Agent is running' });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const n8nWebhook = process.env.N8N_WEBHOOK_URL || 'https://scottde.app.n8n.cloud/webhook/nadia';

// Full memory like your Retell context
const conversationMemory = {};

app.post('/voice', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || '';
  const isFirstMessage = !userSpeech;

  console.log(`[${callSid}] Incoming call - Speech: "${userSpeech}"`);

  if (!conversationMemory[callSid]) {
    conversationMemory[callSid] = {
      step: 'greeting',
      first_name: null,
      last_name: null,
      email: null,
      phone: null,
      previous_client: null,
      skip_referral_question: false,
      referral_source: null,
      call_reason: null,
      selected_slot: null,
      selected_slot_iso: null,
      booking_completed: false,
      conversation_ended: false,
      history: []
    };
  }
  const memory = conversationMemory[callSid];

  let agentText = "Sorry, I'm having a technical issue. Please try again later. Goodbye.";

  try {
    // Build conversation history
    const messages = [
      {
        role: "system",
        content: `You are a friendly CPA receptionist for Ahad and Co CPA Firm. Follow this exact flow:

        - FIRST CALL ONLY: Greet warmly: "Thanks for calling Ahad and Co CPA Firm. How can I help you today?"

        - Intent handling:
          - Returning client: "Welcome back!" → ask for details → booking
          - Appointment request: "Great! Let's schedule a free 15-minute consultation." → booking
          - Personal/individual tax: "We'd love to help. Let's schedule a free 15-minute consultation." → booking
          - Business tax/accounting: "We can definitely help. Let's schedule a free 15-minute consultation." → booking
          - Specific person request: "They're unavailable right now. Would you like to book an appointment?" → booking
          - Other: "I can book a free consultation for you. Would you like to schedule one?" → booking

        - Booking flow (collect in this order):
          1. First name: "May I have your first name? Please spell it out slowly."
          2. Last name: "And your last name? Please spell it slowly."
          3. Email: "What's your email address? Please spell it very slowly, one letter at a time."
          4. Phone: "And your phone number?"
          5. Previous client: "Have you worked with Ahad and Co before?" (Yes/No)
          6. Referral: "How did you hear about us?" (Skip if previous client = Yes)
          7. Call reason: "What's the main reason for your call today?"

        - After collecting all info: "Perfect! I'm booking you for [date/time]. You'll receive a confirmation shortly. Is there anything else I can help you with?"
        - End ONCE with: "Thank you for calling Ahad and Co. Goodbye!" then STOP.

        CRITICAL RULES:
        - Extract information from user speech and update memory
        - NEVER repeat questions already answered
        - NEVER say "Goodbye" more than once
        - Keep responses SHORT (1-2 sentences max)
        - Speak naturally, don't sound robotic

        Current memory state: ${JSON.stringify(memory, null, 2)}`
      }
    ];

    // Add conversation history
    if (memory.history.length > 0) {
      memory.history.forEach(msg => messages.push(msg));
    }

    // Add current user input
    if (userSpeech) {
      messages.push({ role: "user", content: userSpeech });
    } else {
      messages.push({ role: "user", content: "FIRST_CALL_START" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.7,
      max_tokens: 150
    });

    agentText = completion.choices[0].message.content.trim();

    // Save to history
    if (userSpeech) {
      memory.history.push({ role: "user", content: userSpeech });
    }
    memory.history.push({ role: "assistant", content: agentText });

    // Extract information from user speech
    if (userSpeech) {
      const lowerSpeech = userSpeech.toLowerCase();

      // Extract name if asking for first name
      if (memory.step === 'collect_first_name' || (agentText.toLowerCase().includes('first name') && !memory.first_name)) {
        memory.first_name = userSpeech.trim();
        memory.step = 'collect_last_name';
      }

      // Extract last name
      if (memory.step === 'collect_last_name' || (agentText.toLowerCase().includes('last name') && !memory.last_name)) {
        memory.last_name = userSpeech.trim();
        memory.step = 'collect_email';
      }

      // Extract email
      if (memory.step === 'collect_email' || (agentText.toLowerCase().includes('email') && !memory.email)) {
        memory.email = userSpeech.replace(/\s/g, '').toLowerCase();
        memory.step = 'collect_phone';
      }

      // Extract phone
      if (memory.step === 'collect_phone' || (agentText.toLowerCase().includes('phone') && !memory.phone)) {
        memory.phone = userSpeech.replace(/\D/g, '');
        memory.step = 'collect_previous_client';
      }

      // Previous client
      if (lowerSpeech.includes('yes') || lowerSpeech.includes('yeah') || lowerSpeech.includes('returning')) {
        memory.previous_client = 'Yes';
        memory.skip_referral_question = true;
      } else if (lowerSpeech.includes('no') || lowerSpeech.includes('nope') || lowerSpeech.includes('new')) {
        memory.previous_client = 'No';
      }

      // Referral source
      if (!memory.skip_referral_question && agentText.toLowerCase().includes('hear about')) {
        memory.referral_source = userSpeech.trim();
      }

      // Call reason
      if (agentText.toLowerCase().includes('reason') || agentText.toLowerCase().includes('help you with')) {
        memory.call_reason = userSpeech.trim();
      }
    }

    console.log(`[${callSid}] Agent: "${agentText}"`);
    console.log(`[${callSid}] Memory:`, JSON.stringify(memory, null, 2));

  } catch (error) {
    console.error(`[${callSid}] Error in AI processing:`, error);
    agentText = "Sorry, there was a technical issue. Please try again later. Goodbye.";
  }

  // Check if booking complete and send to n8n
  const shouldBook = memory.first_name && memory.last_name && memory.email && memory.phone;
  if (shouldBook && !memory.booking_completed) {
    memory.booking_completed = true;
    console.log(`[${callSid}] Sending booking to n8n...`);

    try {
      await axios.post(n8nWebhook, {
        type: "appointment_booking",
        first_name: memory.first_name,
        last_name: memory.last_name,
        phone: memory.phone || req.body.From,
        email_address: memory.email,
        selected_slot: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
        call_reason: memory.call_reason || "Tax consultation",
        referral_source: memory.referral_source || "Unknown",
        previous_client: memory.previous_client || "No",
        summary: `Appointment booked for ${memory.first_name} ${memory.last_name}`,
        timestamp: new Date().toISOString(),
        booking_status: "confirmed",
        call_sid: callSid
      }, {
        timeout: 5000
      });
      console.log(`[${callSid}] Booking sent to n8n successfully`);
    } catch (webhookError) {
      console.error(`[${callSid}] Error sending to n8n:`, webhookError.message);
      // Continue anyway - don't fail the call
    }
  }

  // Check if conversation should end
  const shouldEnd = agentText.toLowerCase().includes("goodbye") || memory.conversation_ended;

  if (shouldEnd) {
    memory.conversation_ended = true;
    console.log(`[${callSid}] Conversation ended`);

    // Say goodbye and hangup
    twiml.say({
      voice: "Polly.Joanna-Neural",
      language: "en-US"
    }, agentText);
    twiml.hangup();

  } else {
    // Continue conversation - gather user input
    const gather = twiml.gather({
      input: 'speech',
      action: '/voice',
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
      speechModel: 'phone_call'
    });

    // Generate and play audio inside gather
    try {
      // Try ElevenLabs TTS if configured
      if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
        const audioStream = await elevenlabs.generate({
          voice: process.env.ELEVENLABS_VOICE_ID,
          text: agentText,
          model_id: "eleven_multilingual_v2",
        });

        // Convert stream to buffer
        const chunks = [];
        for await (const chunk of audioStream) {
          chunks.push(Buffer.from(chunk));
        }
        const audioBuffer = Buffer.concat(chunks);

        // Upload to tmpfiles.org for public MP3 URL
        const formData = new FormData();
        formData.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
        const uploadResponse = await axios.post('https://tmpfiles.org/api/v1/upload', formData, {
          headers: formData.getHeaders(),
          timeout: 10000
        });

        const audioUrl = uploadResponse.data?.data?.url?.replace('tmpfiles.org/', 'tmpfiles.org/dl/') || uploadResponse.data?.files?.file?.url?.full;

        if (audioUrl) {
          gather.play(audioUrl);
          console.log(`[${callSid}] Playing ElevenLabs audio`);
        } else {
          // Fallback to Twilio
          gather.say({
            voice: "Polly.Joanna-Neural",
            language: "en-US"
          }, agentText);
          console.log(`[${callSid}] ElevenLabs URL failed, using Twilio TTS`);
        }
      } else {
        // Use Twilio TTS
        gather.say({
          voice: "Polly.Joanna-Neural",
          language: "en-US"
        }, agentText);
        console.log(`[${callSid}] Using Twilio TTS`);
      }
    } catch (audioError) {
      console.error(`[${callSid}] Audio generation error:`, audioError.message);
      // Fallback to basic Twilio TTS
      gather.say({
        voice: "Polly.Joanna-Neural",
        language: "en-US"
      }, agentText);
    }

    // If no response after timeout, redirect to continue
    twiml.redirect('/voice');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
