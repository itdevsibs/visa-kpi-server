import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import { Server } from "socket.io";

import { connectDatabase } from "./config/db.js";

// Routes
import userRoutes from "./routes/users.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

/* =====================================
   CORS
===================================== */

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim())
  : [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
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
  console.log(`Socket Connected: ${socket.id}`);

  socket.on("disconnect", () => {
    console.log(`Socket Disconnected: ${socket.id}`);
  });
});

/* =====================================
   API ROUTES
===================================== */

app.use("/api/users", userRoutes);

/* =====================================
   ROOT
===================================== */

app.get("/", (req, res) => {
  res.json({
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
  res.status(200).json({
    success: true,
    database: "Connected",
    server: "Running",
    uptime: process.uptime(),
    timestamp: new Date(),
  });
});

/* =====================================
   404
===================================== */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

/* =====================================
   GLOBAL ERROR HANDLER
===================================== */

app.use((err, req, res, next) => {
  console.error(err);

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
  });
});

/* =====================================
   START SERVER
===================================== */

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDatabase();

    server.listen(PORT, () => {
      console.log("======================================");
      console.log(" SiBS US Visa KPI API");
      console.log("======================================");
      console.log(` Server : http://localhost:${PORT}`);
      console.log(` Environment : ${process.env.NODE_ENV || "development"}`);
      console.log("======================================");
    });
  } catch (error) {
    console.error("Failed to start server");
    console.error(error);
    process.exit(1);
  }
};

startServer();