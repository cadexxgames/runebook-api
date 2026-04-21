export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Verify Stripe signature
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Credit pack URLs → how many credits they give
  const CREDIT_PACKS = {
    'https://buy.stripe.com/8x2aEY2Ggapnfz8e5D33W01': 5,
    'https://buy.stripe.com/4gMbJ2gx6gNL4Uu5z733W02': 15,
    'https://buy.stripe.com/3cI6oI1CcfJH5Yy9Pn33W03': 40,
  };

  async function findUser(email) {
    const { data } = await supabase.auth.admin.listUsers();
    return data?.users?.find(u => u.email === email);
  }

  async function addCredits(userId, credits) {
    const { data: row } = await supabase.from('users').select('data').eq('id', userId).single();
    const userData = row?.data || {};
    userData._bonusCredits = (userData._bonusCredits || 0) + credits;
    await supabase.from('users').update({ data: userData }).eq('id', userId);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_details?.email || session.customer_email;
      const paymentLink = session.payment_link;
      const quantity = session.amount_total && session.amount_subtotal 
        ? Math.round(session.amount_total / (session.amount_subtotal / (session.line_items?.data?.[0]?.quantity || 1)))
        : 1;

      if (!email) return res.status(200).json({ received: true });

      const user = await findUser(email);
      if (!user) {
        console.error('User not found for email:', email);
        return res.status(200).json({ received: true });
      }

      // Check if this is a credit pack purchase
      const packCredits = CREDIT_PACKS[paymentLink];
      if (packCredits) {
        // Get the quantity they bought and multiply credits
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
        const qty = lineItems.data?.[0]?.quantity || 1;
        const totalCredits = packCredits * qty;
        await addCredits(user.id, totalCredits);
        console.log(`Added ${totalCredits} credits to ${email}`);
      } else {
        // Regular Pro subscription
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

export const config = { api: { bodyParser: false } };
