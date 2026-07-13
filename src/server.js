import "dotenv/config";

import express from "express";
import http from "http";
import cors from "cors";
import cookieParser from "cookie-parser";
import { Server } from "socket.io";

import { connectDatabase } from "./config/db.js";

// Routes
import userRoutes from "./routes/users.js";
import performanceRoutes from "./routes/performance.js";

const app = express();
const server = http.createServer(app);

/* =====================================
   ENVIRONMENT CHECK
===================================== */

console.log("======================================");
console.log("Environment configuration");
console.log("Working directory:", process.cwd());
console.log(
  "Kronos API URL loaded:",
  Boolean(process.env.KRONOS_DATAS_API_URL)
);
console.log(
  "Kronos API key loaded:",
  Boolean(process.env.KRONOS_DATAS_API_KEY)
);
console.log(
  "Kronos auth mode:",
  process.env.KRONOS_DATAS_AUTH_MODE || "not configured"
);
console.log("======================================");

/* =====================================
   CORS
===================================== */

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  : [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error(`Origin is not allowed by CORS: ${origin}`)
      );
    },
    credentials: true,
  })
);

/* =====================================
   MIDDLEWARE
===================================== */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* =====================================
   SOCKET.IO
===================================== */

export const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

/* =====================================
   API ROUTES
===================================== */

app.use("/api/users", userRoutes);

app.use("/api/performance", performanceRoutes);

/* =====================================
   ROOT
===================================== */

app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    project: "SiBS US Visa KPI API",
    version: "1.0.0",
    status: "Running",
  });
});

/* =====================================
   HEALTH CHECK
===================================== */

app.get("/api/health", (req, res) => {
  return res.status(200).json({
    success: true,
    database: "Connected",
    server: "Running",
    uptime: process.uptime(),
    timestamp: new Date(),
  });
});

/* =====================================
   KRONOS ENVIRONMENT CHECK
   Does not expose the API key
===================================== */

app.get("/api/health/kronos", (req, res) => {
  const apiUrlConfigured = Boolean(
    String(process.env.KRONOS_DATAS_API_URL || "").trim()
  );

  const apiKeyConfigured = Boolean(
    String(process.env.KRONOS_DATAS_API_KEY || "").trim()
  );

  return res.status(
    apiUrlConfigured && apiKeyConfigured ? 200 : 500
  ).json({
    success: apiUrlConfigured && apiKeyConfigured,
    kronos: {
      apiUrlConfigured,
      apiKeyConfigured,
      authMode:
        process.env.KRONOS_DATAS_AUTH_MODE || "not configured",
      requestMethod:
        process.env.KRONOS_DATAS_API_METHOD || "get",
      pageLimit: Number(
        process.env.KRONOS_DATAS_PAGE_LIMIT || 25
      ),
    },
  });
});

/* =====================================
   404
===================================== */

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

/* =====================================
   GLOBAL ERROR HANDLER
===================================== */

app.use((error, req, res, next) => {
  console.error("[GLOBAL SERVER ERROR]", error);

  return res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal Server Error",
  });
});

/* =====================================
   START SERVER
===================================== */

const PORT = Number(process.env.PORT || 5000);

async function startServer() {
  try {
    await connectDatabase();

    server.listen(PORT, () => {
      console.log("======================================");
      console.log(" SiBS US Visa KPI API");
      console.log("======================================");
      console.log(` Server      : http://localhost:${PORT}`);
      console.log(
        ` Environment : ${
          process.env.NODE_ENV || "development"
        }`
      );
      console.log("======================================");
    });
  } catch (error) {
    console.error("Failed to start server.");
    console.error(error);
    process.exit(1);
  }
}

startServer();