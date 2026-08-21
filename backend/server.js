require("dotenv").config();
const authRoutes = require("./routes/auth.routes");
const express     = require("express");
const multer      = require("multer");
const cors        = require("cors");
const fs          = require("fs");
const path        = require("path");
const pdfParse    = require("pdf-parse");
const crypto      = require("crypto");
const Razorpay    = require("razorpay");
const cron        = require("node-cron");
const bcrypt      = require("bcrypt");
const http        = require("http");

const db          = require("./database/db");
const { getIO, initSocket } = require("./server/socket");
const adminRoutes = require("./routes/admin.routes");
const customerRoutes = require("./routes/customer.routes");
const vendorRoutes   = require("./routes/vendor.routes");
const demoRoutes = require("./routes/demo.routes");
const { optionalCustomerToken } = require("./middleware/verifyCustomerToken");
const app    = express();
const server = http.createServer(app);

/* ── ENV CHECK ── */
console.log("ENV CHECK — RAZORPAY_KEY_ID:", process.env.RAZORPAY_KEY_ID ? "OK" : "MISSING");
console.log("ENV CHECK — DB_HOST:", process.env.DB_HOST || process.env.MYSQLHOST || "NOT SET");

/* ── GLOBAL ERROR HANDLERS ── */
process.on("uncaughtException",  (err) => console.error("UNCAUGHT EXCEPTION:",  err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));

/* ── RAZORPAY (optional — routes return 503 if missing) ── */
let razorpay = null;
console.log("KEY_ID:", process.env.RAZORPAY_KEY_ID);
console.log("KEY_SECRET:", process.env.RAZORPAY_KEY_SECRET);
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.log("✅ Razorpay initialized");
} else {
  console.warn("⚠️  Razorpay keys missing — payment routes disabled");
}

// const SERVER_API_BASE = process.env.REACT_APP_API_BASE || "http://localhost:5000/api";
const SERVER_API_BASE =process.env.API_BASE_URL || "https://uploadsnapprints-production.up.railway.app/api";

/* ── SOCKET.IO ── */
initSocket(server);

/* ── CORS ── */
const allowedOrigins = [
  "https://www.snapprints.in",
  "https://upload.snapprints.in",
  "https://snap-prints.vercel.app",
  "https://snapprints-eight.vercel.app"
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    if (
      allowedOrigins.includes(origin) ||
      origin.endsWith(".vercel.app") ||
      /^http:\/\/localhost:\d+$/.test(origin) ||
      /^http:\/\/192\.168\.\d+\.\d+:\d+$/.test(origin)
    ) {
      return callback(null, true);
    }

    console.warn("CORS blocked:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/api/admin", adminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/vendor", vendorRoutes);
app.use("/api/request-demo", demoRoutes);
/* ── UPLOADS DIR ── */
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

/* ── ALLOWED UPLOAD FILE TYPES ──
   Must match what the frontend's <input accept="..."> allows.
   Mapped by MIME type since that's what multer/browsers report reliably. */
const ALLOWED_MIMETYPES = new Set([
  "application/pdf",
  "application/msword",                                                        // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",   // .docx
  "text/plain",                                                                // .txt
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/bmp",
  "image/webp",
  "image/tiff",
]);

// Fallback map in case a browser sends a generic/empty mimetype (some do for .doc/.tiff)
const EXT_TO_MIME_FALLBACK = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    // Preserve the real extension instead of hardcoding ".pdf" —
    // otherwise every non-PDF file gets saved with a wrong/misleading extension.
    const ext = path.extname(file.originalname).toLowerCase() || "";
    cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB cap — tune as needed
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimetype = ALLOWED_MIMETYPES.has(file.mimetype)
      ? file.mimetype
      : EXT_TO_MIME_FALLBACK[ext];

    if (mimetype) return cb(null, true);
    return cb(new Error("Unsupported file type. Allowed: PDF, DOC, DOCX, TXT, JPG, PNG, GIF, BMP, WEBP, TIFF"));
  },
});

/* ── HELPERS ── */
const generateOTP      = () => Math.floor(1000 + Math.random() * 9000).toString();
const generateQrToken  = () => crypto.randomBytes(32).toString("hex");

function calculatePrice(job) {
  const bw     = job.color === "bw";
  const duplex = job.print_side === "duplex";
  const rate   = bw ? (duplex ? 4 : 2) : (duplex ? 10 : 5);
  const units  = duplex ? Math.ceil(job.total_pages / 2) * job.copies : job.total_pages * job.copies;
  return { units, rate, total: units * rate, paise: units * rate * 100 };
}

// audit_logs.action_type is a fixed-value MySQL enum — it does NOT include
// every event label used around this file (HEARTBEAT, UNLOCK_FAILED,
// JOB_UNLOCKED aren't in it). Previously logAudit() also wrote to a column
// called `action`, which doesn't exist at all (the real column is
// `action_type`) — every call was silently failing. Fixed here: unknown
// labels map to 'OTHER' (or 'JOB_PRINTING' for JOB_UNLOCKED, which is the
// same event semantically), and the original label is preserved in
// `details` so nothing's lost.
const AUDIT_ACTION_TYPES = new Set([
  "MACHINE_CREATED", "MACHINE_UPDATED", "MACHINE_DISABLED", "MACHINE_API_KEY_ROTATED",
  "JOB_CREATED", "JOB_PRICED", "JOB_PAID", "JOB_PRINTING", "JOB_PRINTED", "JOB_FAILED", "JOB_EXPIRED",
  "ALERT_CREATED", "ALERT_RESOLVED", "PRICING_RULE_CREATED", "PRICING_RULE_UPDATED",
  "ADMIN_LOGIN", "ADMIN_LOGOUT", "OTHER",
]);

async function logAudit(machineId, jobId, action, details = null) {
  try {
    const actionType = AUDIT_ACTION_TYPES.has(action)
      ? action
      : (action === "JOB_UNLOCKED" ? "JOB_PRINTING" : "OTHER");

    const mergedDetails = actionType === action
      ? details
      : { event: action, ...(details || {}) };

    await db.query(
      `INSERT INTO audit_logs (machine_id, job_id, action_type, details) VALUES (?, ?, ?, ?)`,
      [machineId, jobId, actionType, JSON.stringify(mergedDetails)]
    );
  } catch (err) {
    console.error("AUDIT LOG ERROR:", err.message);
  }
}

/* Best-effort page count for a file that just landed on disk.
   - PDF: parsed exactly via pdf-parse.
   - Everything else (doc/docx/txt/images): we don't have a reliable
     in-process page counter, so we default to 1 page. If you need
     accurate page counts for docx, you'd need to either:
       a) convert it to PDF first (e.g. via LibreOffice headless / a
          conversion microservice) and then run pdf-parse on the result, or
       b) use a docx-specific library and estimate pages from content length
          (unreliable — Word's actual pagination depends on fonts/margins).
   Until one of those is added, non-PDF jobs are priced as 1 page. */
async function getPageCount(filePath, ext) {
  if (ext === ".pdf") {
    const pdf = await pdfParse(fs.readFileSync(filePath));
    return pdf.numpages;
  }
  return 1;
}

/* ── MACHINE AUTH MIDDLEWARE ── */
async function verifyMachine(req, res, next) {
  try {
    const machineId = req.headers["x-machine-id"];
    const timestamp = req.headers["x-timestamp"];
    const signature = req.headers["x-signature"];
    const apiKey    = req.headers["x-api-key"];

    if (!machineId || !timestamp || !signature || !apiKey)
      return res.status(401).json({ error: "Missing auth headers" });

    if (Math.abs(Date.now() - parseInt(timestamp)) > 5 * 60 * 1000)
      return res.status(401).json({ error: "Request expired" });

    const [[machine]] = await db.query(
      `SELECT * FROM machines WHERE machine_id=? AND status='ACTIVE'`, [machineId]
    );
    if (!machine) return res.status(403).json({ error: "Invalid machine" });

    const valid = await bcrypt.compare(apiKey, machine.api_key_hash);
    if (!valid) return res.status(403).json({ error: "Key mismatch" });

    const expected = crypto
      .createHmac("sha256", apiKey)
      .update(machineId + timestamp + JSON.stringify(req.body || {}))
      .digest("hex");
    if (expected !== signature) return res.status(403).json({ error: "Invalid signature" });

    req.machine = machine;
    next();
  } catch (err) {
    console.error("AUTH ERROR:", err);
    res.status(500).json({ error: "Auth failed" });
  }
}

/* ═══════════════════════════════════════════════════════════
   HEALTH CHECK  — Railway pings this to confirm app is alive
═══════════════════════════════════════════════════════════ */
app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

/* ═══════════════════════════════════════════════════════════
   MACHINE STATUS
   Uses SELECT * to avoid any column-name mismatch issues
═══════════════════════════════════════════════════════════ */
app.get("/api/machines/:machineId/status", async (req, res) => {
  const { machineId } = req.params;

  // Step 1 — get machine row
  let machine = null;
  try {
    const [rows] = await db.query(
      `SELECT * FROM machines WHERE machine_id=?`, [machineId]
    );
    machine = rows && rows.length ? rows[0] : null;
  } catch (err) {
    console.error("STATUS machines query error:", err.message);
    return res.status(500).json({ error: "DB error" });
  }

  if (!machine) return res.status(404).json({ error: "Machine not found" });

  // Step 2 — get latest heartbeat (safe — table might be empty)
  let isOnline = false, paperLevel = null;
  try {
    const [hb] = await db.query(
      `SELECT paper_level, created_at FROM machine_heartbeat_logs
       WHERE machine_id=? ORDER BY created_at DESC LIMIT 1`,
      [machineId]
    );
    if (hb && hb.length > 0) {
      const diff = (Date.now() - new Date(hb[0].created_at).getTime()) / 1000;
      isOnline   = diff < 120;
      paperLevel = hb[0].paper_level ?? null;
    }
  } catch (err) {
    console.warn("STATUS heartbeat query warn:", err.message);
  }

  // Step 3 — always respond
  // last_seen_at OR last_seen — handle both column names gracefully
  return res.json({
    machine_id:      machine.machine_id,
    is_online:       isOnline,
    paper_level:     paperLevel,
    is_print_locked: machine.is_print_locked,
  });
});

/* ═══════════════════════════════════════════════════════════
   HEARTBEAT
═══════════════════════════════════════════════════════════ */
app.post("/api/kiosk/heartbeat", verifyMachine, async (req, res) => {
  try {
    const machineId = req.machine.machine_id;
    const { cpu_usage, paper_level, ink_level, status } = req.body;

    await db.query(
      `INSERT INTO machine_heartbeat_logs (machine_id, cpu_usage, paper_level, ink_level, status)
       VALUES (?, ?, ?, ?, ?)`,
      [machineId, cpu_usage ?? null, paper_level ?? null, ink_level ?? null, status || "ONLINE"]
    );

    // Update last_seen — use last_seen_at if that's the column, fallback gracefully
    try {
      await db.query(
        `UPDATE machines SET last_seen_at=NOW(), last_ip=? WHERE machine_id=?`,
        [req.ip, machineId]
      );
    } catch {
      await db.query(
        `UPDATE machines SET last_seen=NOW(), last_ip=? WHERE machine_id=?`,
        [req.ip, machineId]
      );
    }

    const [[machine]] = await db.query(
      `SELECT paper_threshold, critical_paper_threshold FROM machines WHERE machine_id=?`,
      [machineId]
    );
    const lowThreshold      = machine.paper_threshold          || 10;
    const criticalThreshold = machine.critical_paper_threshold || 5;

    if (paper_level != null) {
      if (paper_level <= criticalThreshold) {
        await db.query(`UPDATE machines SET is_print_locked=TRUE WHERE machine_id=?`, [machineId]);
      }
      if (paper_level <= lowThreshold) {
        const [[existing]] = await db.query(
          `SELECT id FROM machine_alerts WHERE machine_id=? AND alert_type='LOW_PAPER' AND is_resolved=FALSE`,
          [machineId]
        );
        if (!existing) {
          await db.query(
            `INSERT INTO machine_alerts (machine_id, alert_type, message) VALUES (?, 'LOW_PAPER', ?)`,
            [machineId, `Paper level is ${paper_level}%`]
          );
        }
      } else {
        await db.query(
          `UPDATE machine_alerts SET is_resolved=TRUE, resolved_at=NOW()
           WHERE machine_id=? AND alert_type='LOW_PAPER' AND is_resolved=FALSE`,
          [machineId]
        );
      }
    }

    await logAudit(machineId, null, "HEARTBEAT");
    getIO().emit("machine_update", { machineId, paper_level, status });
    res.json({ status: "alive" });
  } catch (err) {
    console.error("HEARTBEAT ERROR:", err);
    res.status(500).json({ error: "Heartbeat failed" });
  }
});

/* ═══════════════════════════════════════════════════════════
   UPLOAD JOB
═══════════════════════════════════════════════════════════ */
app.post("/api/upload-job", optionalCustomerToken, upload.single("pdf"), async (req, res) => {
  try {
    const { machineId, color, copies, paperSize, printSide } = req.body;
    const customerId = req.customer ? req.customer.customerId : null;

    const ext = path.extname(req.file.originalname).toLowerCase();
    const totalPages = await getPageCount(req.file.path, ext);

    const jobId = "JOB_" + Date.now();
    await db.query(
      `INSERT INTO print_jobs (job_id, machine_id, customer_id, file_name, file_path, color, copies, paper_size, print_side, total_pages, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED')`,
      [jobId, machineId, customerId, req.file.originalname, req.file.path, color, copies, paperSize, printSide, totalPages]
    );
    getIO().emit("job_created", { jobId, machineId, pages: totalPages });
    res.json({ jobId, pages: totalPages });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});
/* ═══════════════════════════════════════════════════════════
   JOB SUMMARY
═══════════════════════════════════════════════════════════ */
app.get("/api/job-summary/:jobId", async (req, res) => {
  try {
    const [[job]] = await db.query(`SELECT * FROM print_jobs WHERE job_id=?`, [req.params.jobId]);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const price = calculatePrice(job);
    res.json({
      pages: job.total_pages, totalPages: job.total_pages, copies: job.copies,
      printSide: job.print_side, color: job.color,
      units: price.units, rate: price.rate, totalAmount: price.total,
    });
  } catch (err) {
    console.error("JOB SUMMARY ERROR:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/* ═══════════════════════════════════════════════════════════
   UPDATE JOB
═══════════════════════════════════════════════════════════ */
app.patch("/api/job/:jobId", async (req, res) => {
  try {
    const { color, copies, paperSize, printSide } = req.body;
    const [r] = await db.query(
      `UPDATE print_jobs SET color=?, copies=?, paper_size=?, print_side=?,
       amount=NULL, payment_order_id=NULL, status='CREATED'
       WHERE job_id=? AND status IN ('CREATED','PAYING')`,
      [color, copies, paperSize, printSide, req.params.jobId]
    );
    if (!r.affectedRows) return res.status(409).json({ error: "Job locked" });
    res.json({ success: true });
  } catch (err) {
    console.error("UPDATE JOB ERROR:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/* ═══════════════════════════════════════════════════════════
   CREATE PAYMENT
═══════════════════════════════════════════════════════════ */
app.post("/api/create-payment", async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: "Payment service unavailable" });
  try {
    const [[job]] = await db.query(
      `SELECT * FROM print_jobs WHERE job_id=? AND status='CREATED'`, [req.body.jobId]
    );
    if (!job) return res.status(409).json({ error: "Invalid job state" });

    const [[machine]] = await db.query(
      `SELECT is_print_locked FROM machines WHERE machine_id=?`, [job.machine_id]
    );
    if (machine.is_print_locked)
      return res.status(400).json({ error: "Machine out of paper. Payment disabled." });

    const price  = calculatePrice(job);
    const amount = Math.round(price.paise);
    const order  = await razorpay.orders.create({
      amount, currency: "INR", receipt: req.body.jobId + "_" + Date.now(),
    });
    await db.query(
      `UPDATE print_jobs SET amount=?, payment_order_id=?, status='PAYING' WHERE job_id=?`,
      [price.total, order.id, req.body.jobId]
    );
    res.json({ key: process.env.RAZORPAY_KEY_ID, amount, orderId: order.id });
  } catch (err) {
    console.error("CREATE PAYMENT ERROR:", err);
    res.status(500).json({ error: "Payment creation failed" });
  }
});

/* ═══════════════════════════════════════════════════════════
   VERIFY PAYMENT
═══════════════════════════════════════════════════════════ */
app.post("/api/verify-payment", async (req, res) => {
  const connection = await db.getConnection();
  let txStarted = false;

  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment fields" });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid signature" });
    }

    await connection.beginTransaction();
    txStarted = true;

    const [rows] = await connection.query(
      `SELECT * FROM print_jobs
       WHERE payment_order_id=?
       FOR UPDATE`,
      [razorpay_order_id]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(400).json({ error: "Job not found" });
    }

    const job = rows[0];

    if (job.status !== "PAYING") {
      await connection.rollback();
      return res.status(409).json({ error: "Already processed" });
    }

    const otp = generateOTP();
    const qr = generateQrToken();
    const expiry = new Date(Date.now() + 5 * 60 * 1000);

    // Fetch payment method from Razorpay — not included in the verify
    // payload itself, has to be pulled separately. Non-fatal if it fails:
    // the signature already proved the payment is legitimate, we just
    // won't have the method on record for this one job.
    let paymentMethod = null;
    let paymentDetails = null;
    if (razorpay) {
      try {
        const paymentInfo = await razorpay.payments.fetch(razorpay_payment_id);
        paymentMethod = paymentInfo.method || null; // 'upi' | 'card' | 'netbanking' | 'wallet' | 'emi'

        if (paymentMethod === "upi" && paymentInfo.vpa) {
          paymentDetails = { vpa: paymentInfo.vpa };
        } else if (paymentMethod === "card" && paymentInfo.card) {
          paymentDetails = {
            network: paymentInfo.card.network || null,
            last4: paymentInfo.card.last4 || null,
            type: paymentInfo.card.type || null, // credit / debit
          };
        } else if (paymentMethod === "netbanking" && paymentInfo.bank) {
          paymentDetails = { bank: paymentInfo.bank };
        } else if (paymentMethod === "wallet" && paymentInfo.wallet) {
          paymentDetails = { wallet: paymentInfo.wallet };
        }
      } catch (fetchErr) {
        console.error("RAZORPAY PAYMENT FETCH ERROR:", fetchErr.message);
      }
    }

    // Update print job
    await connection.query(
      `UPDATE print_jobs
       SET status='PAID',
           payment_id=?,
           payment_method=?,
           payment_details=?,
           updated_at=NOW()
       WHERE id=?`,
      [
        razorpay_payment_id,
        paymentMethod,
        paymentDetails ? JSON.stringify(paymentDetails) : null,
        job.id,
      ]
    );

    // Store OTP & QR
    await connection.query(
      `INSERT INTO print_job_tokens
      (
        job_id,
        otp,
        otp_verified,
        otp_expires_at,
        qr_token,
        qr_expires_at
      )
      VALUES (?, ?, 0, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
      otp=VALUES(otp),
      otp_verified=0,
      otp_expires_at=VALUES(otp_expires_at),
      qr_token=VALUES(qr_token),
      qr_expires_at=VALUES(qr_expires_at)`,
      [
        job.job_id,
        otp,
        expiry,
        qr,
        expiry,
      ]
    );

    getIO().emit("payment_success", {
      jobId: job.job_id,
      machineId: job.machine_id,
      filePath: job.file_path,
    });

    await connection.commit();

    return res.json({
      success: true,
      otp,
      qrToken: qr,
    });

  } catch (err) {

    if (txStarted) {
      await connection.rollback();
    }

    console.error("VERIFY PAYMENT ERROR:", err);

    return res.status(500).json({
      error: "Payment verification failed",
    });

  } finally {

    connection.release();

  }
});
/* ═══════════════════════════════════════════════════════════
   KIOSK UNLOCK
═══════════════════════════════════════════════════════════ */
app.post("/api/kiosk/unlock", verifyMachine, async (req, res) => {

  const connection = await db.getConnection();

  try {

    const { otp, qrToken } = req.body;
    const machineId = req.machine.machine_id;

    await connection.beginTransaction();

    const now = new Date();

    const [rows] = await connection.query(
      `
      SELECT
          pj.*,
          pjt.otp,
          pjt.otp_verified,
          pjt.otp_expires_at,
          pjt.qr_token,
          pjt.qr_expires_at

      FROM print_jobs pj

      INNER JOIN print_job_tokens pjt
      ON pj.job_id = pjt.job_id

      WHERE
          pj.machine_id=?
      AND pj.status='PAID'
      AND pjt.otp_verified=0
      AND
      (
          (
              pjt.otp IS NOT NULL
              AND pjt.otp=?
              AND pjt.otp_expires_at>?
          )

          OR

          (
              pjt.qr_token IS NOT NULL
              AND pjt.qr_token=?
              AND pjt.qr_expires_at>?
          )
      )

      FOR UPDATE
      `,
      [
        machineId,
        otp || null,
        now,
        qrToken || null,
        now
      ]
    );

    if (!rows.length) {

      await connection.rollback();

      await logAudit(
        machineId,
        null,
        "UNLOCK_FAILED",
        { otp, qrToken }
      );

      return res.status(401).json({
        error: "Invalid or expired OTP / QR"
      });

    }

    const job = rows[0];

    await connection.query(
      `UPDATE print_jobs
       SET status='PRINTING', updated_at=NOW()
       WHERE id=?`,
      [job.id]
    );

    await connection.query(
      `UPDATE print_job_tokens
       SET otp_verified=1
       WHERE job_id=?`,
      [job.job_id]
    );

    await connection.commit();

    await logAudit(machineId, job.job_id, "JOB_UNLOCKED");

    return res.json({
      jobId: job.job_id,
      filePath: job.file_path,
      copies: job.copies,
      color: job.color,
      paperSize: job.paper_size,
      printSide: job.print_side,
    });

  } catch (err) {

    await connection.rollback();

    console.error("KIOSK UNLOCK ERROR:", err);

    return res.status(500).json({
      error: "Internal server error"
    });

  } finally {

    connection.release();

  }

});
/* ═══════════════════════════════════════════════════════════
   MARK PRINTED
═══════════════════════════════════════════════════════════ */
app.post("/api/kiosk/mark-printed", verifyMachine, async (req, res) => {

  try {

    const { jobId } = req.body;
    const machineId = req.machine.machine_id;

    if (!jobId) {
      return res.status(400).json({ error: "Job ID required" });
    }

    const [[job]] = await db.query(
      `SELECT file_path, status
       FROM print_jobs
       WHERE job_id=?`,
      [jobId]
    );

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (job.status !== "PRINTING") {
      return res.status(400).json({ error: "Invalid job state" });
    }

    const [result] = await db.query(
      `UPDATE print_jobs
       SET status='PRINTED',
           printed_at=NOW()
       WHERE job_id=?
       AND status='PRINTING'`,
      [jobId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        error: "State transition failed"
      });
    }

    // Delete OTP / QR token after successful print
    await db.query(
      `DELETE FROM print_job_tokens
       WHERE job_id=?`,
      [jobId]
    );

    await logAudit(
      machineId,
      jobId,
      "JOB_PRINTED"
    );

    // Delete uploaded file
    if (job.file_path && fs.existsSync(job.file_path)) {
      try {
        fs.unlinkSync(job.file_path);
      } catch (e) {
        console.error("FILE DELETE:", e.message);
      }
    }

    getIO().emit("job_printed", {
      jobId
    });

    return res.json({
      success: true
    });

  } catch (err) {

    console.error("MARK PRINTED ERROR:", err);

    return res.status(500).json({
      error: "Internal server error"
    });

  }

});
/* ═══════════════════════════════════════════════════════════
   MARK FAILED
═══════════════════════════════════════════════════════════ */
app.post("/api/kiosk/mark-failed", verifyMachine, async (req, res) => {
  try {
    const { jobId } = req.body;
    const machineId = req.machine.machine_id;
    const [[job]] = await db.query(
      `SELECT payment_id, amount FROM print_jobs WHERE job_id=? AND status='PRINTING'`, [jobId]
    );
    if (!job) return res.status(400).json({ error: "Invalid state" });
    const [r] = await db.query(`UPDATE print_jobs SET status='FAILED' WHERE job_id=? AND status='PRINTING'`, [jobId]);
    if (!r.affectedRows) return res.status(400).json({ error: "State transition failed" });
    if (razorpay && job.payment_id) {
      try {
        await razorpay.payments.refund(job.payment_id, { amount: Math.round(job.amount * 100) });
      } catch (e) { console.error("REFUND ERROR:", e.message); }
    }
    await logAudit(machineId, jobId, "JOB_FAILED");
    res.json({ success: true });
  } catch (err) {
    console.error("MARK FAILED ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ═══════════════════════════════════════════════════════════
   JOB STATUS
═══════════════════════════════════════════════════════════ */
app.get("/api/job-status/:jobId", async (req, res) => {
  try {
    const [[job]] = await db.query(`SELECT status FROM print_jobs WHERE job_id=?`, [req.params.jobId]);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ status: job.status });
  } catch (err) {
    console.error("JOB STATUS ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ═══════════════════════════════════════════════════════════
   PENDING JOBS
═══════════════════════════════════════════════════════════ */
app.get("/api/kiosk/pending-jobs", verifyMachine, async (req, res) => {

  try {

    const [jobs] = await db.query(
      `
      SELECT
          pj.job_id,
          pj.file_path

      FROM print_jobs pj

      INNER JOIN print_job_tokens pjt
      ON pj.job_id = pjt.job_id

      WHERE
          pj.machine_id=?
      AND pj.status='PAID'
      AND pjt.otp_verified=0
      AND pjt.otp_expires_at > NOW()
      `,
      [req.machine.machine_id]
    );

    res.json({ jobs });

  } catch (err) {

    console.error("PENDING JOBS ERROR:", err);

    res.status(500).json({
      error: "Internal server error"
    });

  }

});
/* ═══════════════════════════════════════════════════════════
   REGISTER MACHINE
═══════════════════════════════════════════════════════════ */

 
app.post("/api/register-machine", async (req, res) => {
  try {
    const { deviceSerial } = req.body;
    if (!deviceSerial) return res.status(400).json({ error: "Device serial required" });
 
    const [[existing]] = await db.query(
      `SELECT * FROM machines WHERE device_serial=?`, [deviceSerial]
    );
 
    if (existing) {
      // ✅ FIX: Return the SAME key if we stored it, otherwise issue a new one
      // and save it so next time we can return it again.
      let apiKey = existing.api_key_plain; // stored plain key from previous registration
 
      if (!apiKey) {
        // First time after adding the column — generate and store
        apiKey = crypto.randomBytes(32).toString("hex");
        await db.query(
          `UPDATE machines SET api_key_hash=?, api_key_plain=?, last_seen_at=NOW()
           WHERE machine_id=?`,
          [await bcrypt.hash(apiKey, 10), apiKey, existing.machine_id]
        );
        console.log(`🔑 New key issued and stored for ${existing.machine_id}`);
      } else {
        // ✅ Return the existing key — no DB write needed, Pi gets same key always
        console.log(`🔑 Returning existing key for ${existing.machine_id}`);
      }
 
      return res.json({
        MACHINE_ID: existing.machine_id,
        API_KEY:    apiKey,
        API_BASE:   SERVER_API_BASE,
      });
    }
 
    // Brand new device — assign from pool
    const [[machine]] = await db.query(
      `SELECT * FROM machines WHERE assigned=FALSE AND status='PENDING' LIMIT 1`
    );
    if (!machine) {
      return res.status(400).json({
        error: "No available machines. Create one from the admin panel first."
      });
    }
 
    const apiKey = crypto.randomBytes(32).toString("hex");
    await db.query(
      `UPDATE machines
       SET assigned=TRUE, status='ACTIVE', device_serial=?,
           api_key_hash=?, api_key_plain=?, last_seen_at=NOW()
       WHERE machine_id=?`,
      [deviceSerial, await bcrypt.hash(apiKey, 10), apiKey, machine.machine_id]
    );
 
    console.log(`✅ New machine registered: ${machine.machine_id} → serial ${deviceSerial}`);
    res.json({
      MACHINE_ID: machine.machine_id,
      API_KEY:    apiKey,
      API_BASE:   SERVER_API_BASE,
    });
 
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});
/* ═══════════════════════════════════════════════════════════
   CLEANUP CRON
═══════════════════════════════════════════════════════════ */
cron.schedule("*/5 * * * *", async () => {
  try {
    const [rows] = await db.query("SELECT DATABASE() AS db");
    console.log("CRON DATABASE:", rows[0].db);
    console.log("STEP 1");
    await db.query(`DELETE FROM print_jobs WHERE status='CREATED' AND created_at < NOW() - INTERVAL 30 MINUTE`);

    console.log("STEP 2");

await db.query(`
UPDATE print_jobs pj
INNER JOIN print_job_tokens pjt
ON pj.job_id=pjt.job_id
SET pj.status='EXPIRED'
WHERE
pj.status='PAID'
AND pjt.otp_expires_at < NOW()
`);

await db.query(`
DELETE FROM print_job_tokens
WHERE otp_expires_at < NOW()
`);

    console.log("STEP 3");
    await db.query(`DELETE FROM print_jobs WHERE status='PRINTED' AND created_at < NOW() - INTERVAL 1 DAY`);

    console.log("STEP 4");
  } catch (err) {
    console.error("CLEANUP ERROR FULL:", err);
  }
});

/* ═══════════════════════════════════════════════════════════
   START
═══════════════════════════════════════════════════════════ */
const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ API_BASE: ${SERVER_API_BASE}`);
});