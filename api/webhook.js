import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const CREDIT_PACK_URLS = {
  'https://buy.stripe.com/8x2aEY2Ggapnfz8e5D33W01': 5,
  'https://buy.stripe.com/4gMbJ2gx6gNL4Uu5z733W02': 15,
  'https://buy.stripe.com/3cI6oI1CcfJH5Yy9Pn33W03': 40,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  let rawBody;
  try { rawBody = await getRawBody(req); }
  catch (err) { return res.status(400).json({ error: 'Could not read body' }); }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  async function findUser(email) {
    const { data } = await supabase.auth.admin.listUsers();
    return data?.users?.find(u => u.email === email);
  }

  async function addCredits(userId, credits) {
    // Read current bonus_credits from dedicated column
    const { data: row } = await supabase
      .from('users')
      .select('bonus_credits, data')
      .eq('id', userId)
      .single();
    
    const currentCredits = row?.bonus_credits || 0;
    const newCredits = currentCredits + credits;
    
    // Update both the column AND the JSON data for consistency
    const userData = row?.data || {};
    userData._bonusCredits = newCredits;
    
    await supabase
      .from('users')
      .update({ bonus_credits: newCredits, data: userData })
      .eq('id', userId);
    
    console.log(`Credits: ${currentCredits} + ${credits} = ${newCredits} for user ${userId}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_details?.email || session.customer_email;
      const paymentLinkId = session.payment_link;

      console.log('Checkout completed:', { email, paymentLinkId, mode: session.mode });

      if (!email) return res.status(200).json({ received: true });

      const user = await findUser(email);
      if (!user) {
        console.error('User not found:', email);
        return res.status(200).json({ received: true });
      }

      let isCredits = false;
      let creditAmount = 0;

      if (paymentLinkId) {
        try {
          const paymentLink = await stripe.paymentLinks.retrieve(paymentLinkId);
          const linkUrl = paymentLink.url;
          console.log('Payment link URL:', linkUrl);
          for (const [url, credits] of Object.entries(CREDIT_PACK_URLS)) {
            if (linkUrl && linkUrl.includes(url.split('/').pop())) {
              isCredits = true;
              creditAmount = credits;
              break;
            }
          }
        } catch (err) {
          console.error('Could not retrieve payment link:', err.message);
        }
      }

      // Fallback: one-time payment = credit pack
      if (!isCredits && session.mode === 'payment') {
        const amount = session.amount_total;
        if (amount <= 200) { isCredits = true; creditAmount = 5; }
        else if (amount <= 500) { isCredits = true; creditAmount = 15; }
        else if (amount <= 1000) { isCredits = true; creditAmount = 40; }
      }

      if (isCredits && creditAmount > 0) {
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
        const qty = lineItems.data?.[0]?.quantity || 1;
        const total = creditAmount * qty;
        await addCredits(user.id, total);
        console.log(`Added ${total} credits to ${email}`);
      } else {
        await supabase.from('users').update({ is_pro: true }).eq('id', user.id);
        console.log('Pro activated for:', email);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const customer = await stripe.customers.retrieve(event.data.object.customer);
      if (customer.email) {
        const user = await findUser(customer.email);
        if (user) {
          await supabase.from('users').update({ is_pro: false }).eq('id', user.id);
          console.log('Pro revoked for:', customer.email);
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
}
