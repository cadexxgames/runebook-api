import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Helper to read raw body from request
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const CREDIT_PACKS = {
  'https://buy.stripe.com/8x2aEY2Ggapnfz8e5D33W01': 5,
  'https://buy.stripe.com/4gMbJ2gx6gNL4Uu5z733W02': 15,
  'https://buy.stripe.com/3cI6oI1CcfJH5Yy9Pn33W03': 40,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: 'Could not read body' });
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature: ' + err.message });
  }

  async function findUser(email) {
    const { data } = await supabase.auth.admin.listUsers();
    return data?.users?.find(u => u.email === email);
  }

  async function addCredits(userId, credits) {
    const { data: row } = await supabase
      .from('users')
      .select('data')
      .eq('id', userId)
      .single();
    const userData = row?.data || {};
    userData._bonusCredits = (userData._bonusCredits || 0) + credits;
    await supabase
      .from('users')
      .update({ data: userData })
      .eq('id', userId);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_details?.email || session.customer_email;
      const paymentLink = session.payment_link;

      console.log('Checkout completed:', { email, paymentLink });

      if (!email) {
        console.error('No email in session');
        return res.status(200).json({ received: true });
      }

      const user = await findUser(email);
      if (!user) {
        console.error('User not found for email:', email);
        return res.status(200).json({ received: true });
      }

      const packCredits = CREDIT_PACKS[paymentLink];
      if (packCredits) {
        // Credit pack purchase
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
        const qty = lineItems.data?.[0]?.quantity || 1;
        const totalCredits = packCredits * qty;
        await addCredits(user.id, totalCredits);
        console.log(`Added ${totalCredits} credits to ${email}`);
      } else {
        // Pro subscription
        await supabase
          .from('users')
          .update({ is_pro: true })
          .eq('id', user.id);
        console.log('Pro activated for:', email);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const customer = await stripe.customers.retrieve(
        event.data.object.customer
      );
      if (customer.email) {
        const user = await findUser(customer.email);
        if (user) {
          await supabase
            .from('users')
            .update({ is_pro: false })
            .eq('id', user.id);
          console.log('Pro revoked for:', customer.email);
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: err.message });
  }
}
