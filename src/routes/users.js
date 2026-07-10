import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import db from "../config/db.js";
import {
  getKronosDatasFromApi,
  getKronosDataByIdFromApi,
} from "../services/kronosDatasApiService.js";

const router = express.Router();

/* =====================================
   PASSWORD ENCRYPTION
===================================== */

function encryptPass(password) {
  const method = process.env.ENCRYPT_METHOD;
  const secretKey = process.env.ENCRYPT_SECRET_KEY;
  const secretIv = process.env.ENCRYPT_SECRET_IV;

  if (!method || !secretKey || !secretIv) {
    throw new Error("Missing encryption environment variables.");
  }

  const key = Buffer.from(
    crypto.createHash("sha256").update(secretKey).digest("hex"),
    "utf8"
  ).slice(0, 32);

  const iv = Buffer.from(
    crypto
      .createHash("sha256")
      .update(secretIv)
      .digest("hex")
      .substring(0, 16),
    "utf8"
  );

  const cipher = crypto.createCipheriv(method, key, iv);

  let encrypted = cipher.update(String(password), "utf8", "base64");
  encrypted += cipher.final("base64");

  return Buffer.from(encrypted, "utf8").toString("base64");
}

/* =====================================
   JWT AUTHENTICATION MIDDLEWARE
===================================== */

function authenticateToken(req, res, next) {
  try {
    const authorizationHeader = req.headers.authorization;

    if (!authorizationHeader) {
      return res.status(401).json({
        success: false,
        message: "Authorization token is required.",
      });
    }

    const [scheme, token] = authorizationHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({
        success: false,
        message: "Invalid authorization header.",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;

    return next();
  } catch (error) {
    console.error("[AUTHENTICATION ERROR]", error);

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Your session has expired. Please log in again.",
      });
    }

    return res.status(401).json({
      success: false,
      message: "Invalid authentication token.",
    });
  }
}

/* =====================================
   LOGIN
===================================== */

router.post("/login", async (req, res) => {
  try {
    const sibsId = String(req.body?.sibs_id || "").trim();
    const password = String(req.body?.password || "");

    if (!sibsId || !password) {
      return res.status(400).json({
        success: false,
        message: "SIBS ID and password are required.",
      });
    }

    const [rows] = await db.query(
      `
      SELECT
        id,
        sibs_id,
        first_name,
        last_name,
        role,
        password,
        is_active
      FROM us_visa_users
      WHERE sibs_id = ?
        AND is_active = 1
      LIMIT 1
      `,
      [sibsId]
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid SIBS ID or password.",
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

    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is not configured.");
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
      `
      UPDATE us_visa_users
      SET last_login = NOW()
      WHERE id = ?
      `,
      [user.id]
    );

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      token,
      user: {
        id: user.id,
        sibs_id: user.sibs_id,
        first_name: user.first_name,
        last_name: user.last_name,
        full_name: [user.first_name, user.last_name]
          .filter(Boolean)
          .join(" "),
        role: user.role,
      },
    });
  } catch (error) {
    console.error("[LOGIN ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to log in.",
    });
  }
});

/* =====================================
   GET CURRENT USER
===================================== */

router.get("/me", authenticateToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT
        id,
        sibs_id,
        first_name,
        last_name,
        role,
        is_active,
        last_login
      FROM us_visa_users
      WHERE id = ?
        AND is_active = 1
      LIMIT 1
      `,
      [req.user.id]
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User account was not found.",
      });
    }

    const user = rows[0];

    return res.status(200).json({
      success: true,
      data: {
        id: user.id,
        sibs_id: user.sibs_id,
        first_name: user.first_name,
        last_name: user.last_name,
        full_name: [user.first_name, user.last_name]
          .filter(Boolean)
          .join(" "),
        role: user.role,
        is_active: Boolean(user.is_active),
        last_login: user.last_login,
      },
    });
  } catch (error) {
    console.error("[GET CURRENT USER ERROR]", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to retrieve the current user.",
    });
  }
});

/* =====================================
   GET KRONOS EMPLOYEES
===================================== */

router.get("/kronos-employees", authenticateToken, async (req, res) => {
  try {
    const result = await getKronosDatasFromApi(req.query, req.user);

    return res.status(200).json({
      success: result?.success !== false,
      message:
        result?.message || "Kronos employees retrieved successfully.",
      ...result,
    });
  } catch (error) {
    console.error("[GET KRONOS EMPLOYEES ERROR]", error);

    const statusCode =
      Number(error?.response?.status) >= 400
        ? Number(error.response.status)
        : 500;

    return res.status(statusCode).json({
      success: false,
      message:
        error?.response?.data?.message ||
        error?.message ||
        "Unable to retrieve Kronos employees.",
      data: [],
      pagination: {
        page: 1,
        limit: Number(process.env.KRONOS_DATAS_PAGE_LIMIT || 25),
        total: 0,
        totalPages: 0,
      },
    });
  }
});

/* =====================================
   GET KRONOS EMPLOYEE BY SIBS ID
===================================== */

router.get(
  "/kronos-employees/:sibsId",
  authenticateToken,
  async (req, res) => {
    try {
      const sibsId = String(req.params.sibsId || "").trim();

      if (!sibsId) {
        return res.status(400).json({
          success: false,
          message: "SIBS ID is required.",
          data: null,
        });
      }

      const result = await getKronosDataByIdFromApi(sibsId);

      if (!result?.data) {
        return res.status(404).json({
          success: false,
          message:
            result?.message ||
            `No Kronos employee was found for SIBS ID ${sibsId}.`,
          data: null,
        });
      }

      return res.status(200).json({
        success: true,
        message:
          result?.message || "Kronos employee retrieved successfully.",
        ...result,
      });
    } catch (error) {
      console.error("[GET KRONOS EMPLOYEE ERROR]", error);

      const statusCode =
        Number(error?.response?.status) >= 400
          ? Number(error.response.status)
          : 500;

      return res.status(statusCode).json({
        success: false,
        message:
          error?.response?.data?.message ||
          error?.message ||
          "Unable to retrieve the Kronos employee.",
        data: null,
      });
    }
  }
);

export default router;