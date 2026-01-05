// routes/testEmail.route.js
import express from 'express';
import transporter from '../services/mailer.js'; // your configured nodemailer instance
const router = express.Router();

router.post('/test-email', async (req, res) => {
  try {
    const { to, subject, text } = req.body;
    const info = await transporter.sendMail({
      from: `"Awdiz Admissions" <${process.env.SMTP_USER}>`,
      to, subject, text
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
