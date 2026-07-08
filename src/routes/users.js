import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import db from "../config/db.js";

const router = express.Router();

function encryptPass(password) {
  const method = process.env.ENCRYPT_METHOD;
  const secretKey = process.env.ENCRYPT_SECRET_KEY;
  const secretIv = process.env.ENCRYPT_SECRET_IV;

  if (!method || !secretKey || !secretIv) {
    throw new Error("Missing encryption environment variables");
  }

  const key = Buffer.from(
    crypto.createHash("sha256").update(secretKey).digest("hex"),
    "utf8"
  ).slice(0, 32);

  const iv = Buffer.from(
    crypto.createHash("sha256").update(secretIv).digest("hex").substring(0, 16),
    "utf8"
  );

  const cipher = crypto.createCipheriv(method, key, iv);

  let encrypted = cipher.update(password, "utf8", "base64");
  encrypted += cipher.final("base64");

  return Buffer.from(encrypted, "utf8").toString("base64");
}

/* =====================================
   LOGIN
===================================== */

router.post("/login", async (req, res) => {
  console.log("================================");
  console.log("LOGIN ROUTE HIT");
  console.log("Body:", req.body);
  console.log("================================");

  try {
    const { sibs_id, password } = req.body;

    if (!sibs_id || !password) {
      return res.status(400).json({
        success: false,
        message: "SIBS ID and password are required.",
        body: req.body,
      });
    }

    const [rows] = await db.query(
      `
      SELECT *
      FROM us_visa_users
      WHERE sibs_id = ?
      AND is_active = 1
      LIMIT 1
      `,
      [sibs_id]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "User not found.",
      });
    }

    const user = rows[0];

    const encryptedPassword = encryptPass(password);

    if (encryptedPassword !== user.password) {
      return res.status(401).json({
        success: false,
        message: "Invalid SIBS ID or password.",
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        sibs_id: user.sibs_id,
        role: user.role,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN || "8h",
      }
    );

    await db.query(
      "UPDATE us_visa_users SET last_login = NOW() WHERE id = ?",
      [user.id]
    );

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        sibs_id: user.sibs_id,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
      },
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

export default router;