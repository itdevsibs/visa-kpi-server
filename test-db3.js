import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

function withTimeout(promise, ms, label) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function testDb3({ ssl }) {
  console.log("=====================================");
  console.log(`Testing DB3 with SSL: ${ssl ? "ON" : "OFF"}`);
  console.log("=====================================");

  let connection;

  try {
    console.log("DB3 config:", {
      host: process.env.DB3_HOST,
      port: process.env.DB3_PORT,
      user: process.env.DB3_USER,
      database: process.env.DB3_NAME,
      passwordExists: Boolean(process.env.DB3_PASSWORD),
    });

    connection = await withTimeout(
      mysql.createConnection({
        host: process.env.DB3_HOST,
        port: Number(process.env.DB3_PORT || 3306),
        user: process.env.DB3_USER,
        password: process.env.DB3_PASSWORD,
        database: process.env.DB3_NAME,
        connectTimeout: 5000,
        enableKeepAlive: false,
        ssl: ssl
          ? {
              rejectUnauthorized: false,
            }
          : undefined,
      }),
      8000,
      `DB3 SSL ${ssl ? "ON" : "OFF"} connection`,
    );

    const [rows] = await withTimeout(
      connection.query("SELECT DATABASE() AS dbName, NOW() AS currentTime"),
      8000,
      `DB3 SSL ${ssl ? "ON" : "OFF"} query`,
    );

    console.log("✅ DB3 CONNECTED SUCCESSFULLY");
    console.log(rows);
  } catch (error) {
    console.error("❌ DB3 TEST FAILED");
    console.error({
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState,
      fatal: error.fatal,
    });
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch {
        connection.destroy?.();
      }
    }
  }
}

await testDb3({ ssl: false });
await testDb3({ ssl: true });

console.log("=====================================");
console.log("DB3 test finished.");
console.log("=====================================");