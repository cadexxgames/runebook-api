// api/notify.js — Supabase webhook for new feedback notifications
import nodemailer from 'nodemailer';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body;
    const record = payload.record;

    if (!record) return res.status(400).json({ error: 'No record' });

    const rating = record.rating || 0;
    const email = record.email || 'Unknown';
    const message = record.message || 'No message';
    const stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
    const date = new Date(record.created_at).toLocaleString('en-US', { timeZone: 'America/Chicago' });

    // Zoho SMTP transporter
    const transporter = nodemailer.createTransport({
      host: 'smtp.zoho.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.ZOHO_EMAIL,
        pass: process.env.ZOHO_PASSWORD
      }
    });

    await transporter.sendMail({
      from: `"Runebook" <${process.env.ZOHO_EMAIL}>`,
      to: process.env.ZOHO_EMAIL,
      subject: `New Feedback: ${stars} from ${email}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0518;color:#f0e8ff;padding:24px;border-radius:12px">
          <h2 style="color:#ffd040;font-family:serif;margin-bottom:4px">New Runebook Feedback</h2>
          <p style="color:#a090c0;font-size:13px;margin-top:0">${date} (CST)</p>
          <hr style="border-color:#2a1a40;margin:16px 0">
          <p style="margin:8px 0"><strong style="color:#c080ff">From:</strong> ${email}</p>
          <p style="margin:8px 0"><strong style="color:#c080ff">Rating:</strong> ${stars} (${rating}/5)</p>
          <hr style="border-color:#2a1a40;margin:16px 0">
          <p style="margin:8px 0"><strong style="color:#c080ff">Message:</strong></p>
          <p style="background:#1a0840;padding:14px;border-radius:8px;border-left:3px solid #6030c0;line-height:1.7;margin-top:8px">${message}</p>
          <hr style="border-color:#2a1a40;margin:16px 0">
          <p style="font-size:12px;color:#4a3a70">View all feedback in Supabase → Table Editor → feedback</p>
        </div>
      `
    });

    console.log('Feedback notification sent for:', email);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Notify error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
