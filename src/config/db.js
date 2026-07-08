import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  charset: "utf8mb4",
  timezone: "+08:00",
});

/**
 * Test Database Connection
 */
export async function connectDatabase() {
  try {
    const connection = await db.getConnection();

    console.log("✅ MySQL Connected");
    console.log(`📦 Database : ${process.env.DB_NAME}`);
    console.log(`🖥️ Host     : ${process.env.DB_HOST}:${process.env.DB_PORT}`);

    connection.release();
  } catch (error) {
    console.error("❌ Database Connection Failed");
    console.error(error.message);
    process.exit(1);
  }
}

export default db;