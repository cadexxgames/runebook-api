export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const email = event.data.object.customer_details?.email || event.data.object.customer_email;
      if (email) {
        const { data } = await supabase.auth.admin.listUsers();
        const user = data?.users?.find(u => u.email === email);
        if (user) await supabase.from('users').update({ is_pro: true }).eq('id', user.id);
      }
    }
    if (event.type === 'customer.subscription.deleted') {
      const customer = await stripe.customers.retrieve(event.data.object.customer);
      if (customer.email) {
        const { data } = await supabase.auth.admin.listUsers();
        const user = data?.users?.find(u => u.email === customer.email);
        if (user) await supabase.from('users').update({ is_pro: false }).eq('id', user.id);
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export const config = { api: { bodyParser: false } };
