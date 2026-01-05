import axios from "axios";

export async function sendOtpSms(mobile, otp) {
  const isDummy = String(process.env.SMS_DUMMY || "true") === "true";

  // Dummy mode for local/dev testing
  if (isDummy) {
    console.log(`🧪 [SMS-DUMMY] OTP to ${mobile}: ${otp}`);
    return { ok: true };
  }

  try {
    const WATI_BASE_URL = process.env.WATI_BASE_URL;   // e.g. https://app.wati.io
    const WATI_API_KEY = process.env.WATI_API_KEY;
    const TEMPLATE = process.env.WATI_TEMPLATE_NAME || "mobile_verification_otp";

    // Normalize number
    const cleanMobile = String(mobile).replace(/\D/g, "");

    // Validate number length
    if (cleanMobile.length !== 10) {
      console.error("❌ Invalid mobile format:", cleanMobile);
      return { ok: false, error: "Invalid mobile format" };
    }

    // 🔥 WATI DEMANDS FULL E.164 FORMAT → 91XXXXXXXXXX
    const whatsappNumber = `91${cleanMobile}`;

    console.log("📤 Sending WhatsApp OTP →", whatsappNumber);

    const payload = {
      template_name: TEMPLATE,
      broadcast_name: TEMPLATE,
      parameters: [
        {
          name: "1",
          value: otp,
        }
      ],
      // recipients should be array of WhatsApp numbers only
      recipients: [whatsappNumber]
    };

    const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=91${cleanMobile}`;

    const res = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WATI_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    console.log("📨 WATI Response:", res.data);

    // WhatsApp registration check
    if (res.data?.validWhatsAppNumber === false) {
      console.error("❌ Number is NOT a valid WhatsApp number");
      return {
        ok: false,
        error: "Number is not registered on WhatsApp",
      };
    }

    return { ok: true };

  } catch (err) {
    console.error("❌ WATI OTP Failed:", err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}
