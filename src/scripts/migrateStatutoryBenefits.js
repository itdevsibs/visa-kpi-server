import { kronosDb, hrisDb } from "../config/db.js";

function cleanValue(value) {
  if (!value) return null;

  const cleaned = String(value)
    .replace(/\r/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || null;
}

function extractField(text, label, nextLabels = []) {
  if (!text) return null;

  const normalized = String(text).replace(/\r/g, "").trim();

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextPattern =
    nextLabels.length > 0
      ? `(?=\\b(?:${nextLabels
          .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|")})\\b\\s*:?|$)`
      : `(?=$)`;

  const regex = new RegExp(
    `${escapedLabel}\\s*:?\\s*([\\s\\S]*?)${nextPattern}`,
    "i"
  );

  const match = normalized.match(regex);
  if (!match?.[1]) return null;

  return cleanValue(match[1]);
}

function parseGovernmentIds(govId, govIdNum) {
  return {
    sss: extractField(govId, "SSS", ["PHIC"]),
    phic: extractField(govId, "PHIC"),
    hdmf: extractField(govIdNum, "HDMF", ["TIN"]),
    tin: extractField(govIdNum, "TIN"),
  };
}

async function migrateStatutoryBenefits() {
  const connection = await hrisDb.getConnection();

  try {
    const [employees] = await kronosDb.query(`
      SELECT
        gy_emp_code,
        gy_gov_id,
        gy_gov_idnum
      FROM gy_employee
      WHERE gy_emp_code IS NOT NULL
    `);

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    await connection.beginTransaction();

    for (const emp of employees) {
      const sibsId = String(emp.gy_emp_code || "").trim();

      if (!sibsId) {
        skipped++;
        continue;
      }

      const { sss, phic, hdmf, tin } = parseGovernmentIds(
        emp.gy_gov_id,
        emp.gy_gov_idnum
      );

      const [existingRows] = await connection.query(
        `
        SELECT id
        FROM statutory_benefits
        WHERE sibs_id = ?
        ORDER BY id ASC
        LIMIT 1
        `,
        [sibsId]
      );

      if (existingRows.length > 0) {
        await connection.query(
          `
          UPDATE statutory_benefits
          SET
            sss = ?,
            phic = ?,
            hdmf = ?,
            tin = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `,
          [sss, phic, hdmf, tin, existingRows[0].id]
        );

        updated++;
      } else {
        await connection.query(
          `
          INSERT INTO statutory_benefits (
            sibs_id,
            sss,
            phic,
            hdmf,
            tin
          )
          VALUES (?, ?, ?, ?, ?)
          `,
          [sibsId, sss, phic, hdmf, tin]
        );

        inserted++;
      }
    }

    await connection.commit();

    console.log("✅ Migration completed");
    console.log({
      totalSourceRows: employees.length,
      inserted,
      updated,
      skipped,
    });
  } catch (error) {
    await connection.rollback();
    console.error("❌ Migration failed:", error);
  } finally {
    connection.release();
    process.exit();
  }
}

migrateStatutoryBenefits();