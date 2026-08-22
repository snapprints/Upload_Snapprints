// routes/demo.routes.js
const express = require("express");
const router  = express.Router();
const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const INTEREST_LABELS = {
  own_kiosk: "Wants to own a SnapPrints kiosk",
  host_kiosk: "Has a location, wants to host a kiosk",
  custom_solution: "Needs a custom solution",
};

/* ═══════════════════════════════════════════════════════════
   POST /api/request-demo
   body: { interestType, name, phone, email, organisation,
           country, state, city, language, message }
   Sends a notification email via Resend to TO_EMAIL.
═══════════════════════════════════════════════════════════ */
router.post("/", async (req, res) => {
  try {
    if (!resend) {
      console.warn("RESEND_API_KEY not set — demo request not emailed:", req.body);
      return res.status(503).json({ error: "Demo request service unavailable" });
    }

    const {
      interestType,
      name,
      phone,
      email,
      organisation,
      country,
      state,
      city,
      language,
      message,
    } = req.body;

    if (!name || !phone || !email || !organisation || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const interestLabel = INTEREST_LABELS[interestType] || interestType || "—";
    const location = [city, state, country].filter(Boolean).join(", ") || "—";

    await resend.emails.send({
      from: "SnapPrints Demo Requests <onboarding@resend.dev>",
      to: process.env.TO_EMAIL,
      subject: `New demo request — ${organisation}`,
      html: `
        <h2>New Demo Request</h2>
        <p><strong>Interested in:</strong> ${interestLabel}</p>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Organisation:</strong> ${organisation}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Phone:</strong> ${phone}</p>
        <p><strong>Location:</strong> ${location}</p>
        <p><strong>Preferred Language:</strong> ${language || "—"}</p>
        <p><strong>Message:</strong><br/>${message}</p>
      `,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("REQUEST DEMO ERROR:", err);
    res.status(500).json({ error: "Failed to send demo request" });
  }
});

module.exports = router;