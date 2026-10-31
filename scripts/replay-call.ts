/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// scripts/replay-call.ts
import { createHmac } from 'crypto';
import axios from 'axios';

async function replay() {
  const webhookKey = process.env.TEST_WEBHOOK_KEY || 'test-org-key';
  const webhookSecret = process.env.TEST_WEBHOOK_SECRET || 'test-secret';
  const url = `http://localhost:3000/webhooks/fathom/${webhookKey}`;

  const payload = {
    event_id: `evt_${Date.now()}`,
    event_type: 'call.recording_ready',
    call: {
      id: `fathom_call_${Date.now()}`,
      title: 'Acme Corp - Pricing & Security Review',
      started_at: new Date().toISOString(),
      duration_seconds: 1840,
      host_email: 'ae@ourcompany.com',
      attendees: [
        { name: 'Alex Rep', email: 'ae@ourcompany.com' },
        { name: 'Sara Buyer', email: 'sara@acmecorp.io' },
      ],
    },
  };

  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  const response = await axios.post(url, rawBody, {
    headers: {
      'Content-Type': 'application/json',
      'x-fathom-signature': `sha256=${signature}`,
    },
  });

  console.log('Webhook Response:', response.status, response.data);
}

replay().catch((err) => {
  console.error('Replay failed:', err.response?.data || err.message);
  process.exit(1);
});
