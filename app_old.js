require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const { parse } = require("csv-parse/sync");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 4000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : false,
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set("view engine", "ejs");
app.set("views", "./views");

const upload = multer({ dest: "uploads/" });

function mapGender(raw) {
  const value = String(raw || "")
    .trim()
    .toUpperCase();
  if (!value) return { gender: null, error: null };
  if (["F", "FEMALE", "GIRL"].includes(value)) return { gender: "Girl", error: null };
  if (["M", "MALE", "BOY"].includes(value)) return { gender: "Boy", error: null };
  return {
    gender: null,
    error: `Unrecognized gender "${raw.trim()}". Use F/M, Female/Male, or Girl/Boy.`,
  };
}

function headerNames(headerRow) {
  return headerRow.map((h) => String(h || "").trim());
}

function isNumberedHeader(names) {
  const upper = names.map((n) => n.toUpperCase().replace(/\s+/g, "_"));
  return upper.includes("GENDER1") || upper.includes("CONTROL_NUMBER");
}

function parseNumberedRow(record) {
  const control =
    record.CONTROL_NUMBER ||
    record["CONTROL NUMBER"] ||
    record.control_number ||
    "";
  const family =
    record.FAMILY_COMMENTS ||
    record["FAMILY COMMENTS"] ||
    record.COMMENTS ||
    record.family_comments ||
    "";

  const children = [];
  const errors = [];
  for (let n = 1; n <= 20; n++) {
    const genderRaw = record[`GENDER${n}`] || record[`Gender${n}`] || "";
    const ageRaw = record[`AGE${n}`] || record[`Age${n}`] || "";
    const comments = record[`COMMENTS${n}`] || record[`Comments${n}`] || "";
    if (!String(genderRaw).trim() && !String(ageRaw).trim()) continue;

    const mapped = mapGender(genderRaw);
    if (mapped.error) errors.push(`child ${n}: ${mapped.error}`);
    const ageStr = String(ageRaw).trim();
    if (!/^\d+$/.test(ageStr)) errors.push(`child ${n}: age must be a whole number`);
    if (!mapped.error && /^\d+$/.test(ageStr)) {
      children.push({
        gender: mapped.gender,
        age: parseInt(ageStr, 10),
        special_requests: String(comments).trim() || null,
      });
    }
  }
  return {
    control_number: String(control).trim(),
    family_comment: String(family).trim() || null,
    children,
    errors,
  };
}

function parseRepeatingRow(cells) {
  const control = cells[0] || "";
  const family = cells[1] || "";
  const children = [];
  const errors = [];
  for (let col = 2, n = 1; col < cells.length; col += 3, n++) {
    const genderRaw = cells[col] || "";
    const ageRaw = cells[col + 1] || "";
    const comments = cells[col + 2] || "";
    if (!String(genderRaw).trim() && !String(ageRaw).trim() && !String(comments).trim()) {
      continue;
    }
    const mapped = mapGender(genderRaw);
    if (mapped.error) errors.push(`child ${n}: ${mapped.error}`);
    const ageStr = String(ageRaw).trim();
    if (!/^\d+$/.test(ageStr)) errors.push(`child ${n}: age must be a whole number`);
    if (!mapped.error && /^\d+$/.test(ageStr)) {
      children.push({
        gender: mapped.gender,
        age: parseInt(ageStr, 10),
        special_requests: String(comments).trim() || null,
      });
    }
  }
  return {
    control_number: String(control).trim(),
    family_comment: String(family).trim() || null,
    children,
    errors,
  };
}

function validateAndParseCsv(filePath) {
  const raw = fs.readFileSync(filePath);
  const records = parse(raw, {
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });

  if (!records.length) {
    return { ok: false, families: [], report: [{ row_number: 1, error: "File is empty" }] };
  }

  const names = headerNames(records[0]);
  const numbered = isNumberedHeader(names);
  const families = [];
  const report = [];
  const seen = new Map();

  for (let i = 1; i < records.length; i++) {
    const row_number = i + 1;
    const parsed = numbered
      ? parseNumberedRow(
          Object.fromEntries(names.map((name, idx) => [name, records[i][idx] || ""]))
        )
      : parseRepeatingRow(records[i]);

    const rowErrors = [...parsed.errors];
    if (!parsed.control_number) {
      rowErrors.push("Missing CONTROL NUMBER");
    } else if (!/^\d{7}$/.test(parsed.control_number)) {
      rowErrors.push(
        `CONTROL NUMBER must be 7 digits (got "${parsed.control_number}")`
      );
    } else if (seen.has(parsed.control_number)) {
      rowErrors.push(
        `Duplicate CONTROL NUMBER (also on row ${seen.get(parsed.control_number)})`
      );
    } else {
      seen.set(parsed.control_number, row_number);
    }

    if (parsed.children.length === 0) {
      rowErrors.push("No valid children");
    }

    if (rowErrors.length) {
      report.push({
        row_number,
        control_number: parsed.control_number || "",
        status: "error",
        error: rowErrors.join("; "),
      });
    } else {
      families.push({
        row_number,
        control_number: parsed.control_number,
        family_comment: parsed.family_comment,
        children: parsed.children,
      });
      report.push({
        row_number,
        control_number: parsed.control_number,
        status: "ok",
        error: "",
      });
    }
  }

  return { ok: report.every((r) => r.status === "ok"), families, report };
}

async function getBatchSummary(batchId) {
  const { rows } = await pool.query(
    `
    SELECT
      batch_id,
      COUNT(*) AS family_count,
      COALESCE(SUM(jsonb_array_length(children)), 0) AS child_count,
      COUNT(*) FILTER (WHERE is_valid = true) AS valid_count,
      COUNT(*) FILTER (WHERE is_valid = false) AS invalid_count,
      MIN(created_at) AS imported_at
    FROM workflow.staging_import
    WHERE batch_id = $1
    GROUP BY batch_id
    `,
    [batchId]
  );
  return rows[0] || null;
}

app.get("/", (req, res) => {
  res.render("index", { message: null, report: null, blocked: false });
});

app.post("/import", upload.single("csv"), async (req, res) => {
  if (!req.file) {
    return res.render("index", {
      message: "No file uploaded",
      report: null,
      blocked: false,
    });
  }

  const filePath = req.file.path;
  try {
    const parsed = validateAndParseCsv(filePath);

    if (!parsed.ok) {
      const errorCount = parsed.report.filter((r) => r.status === "error").length;
      return res.render("index", {
        message: `File is not clean (${errorCount} problem row(s)). Nothing was written to staging.`,
        report: parsed.report,
        blocked: true,
      });
    }

    const batch_id = uuidv4();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const family of parsed.families) {
        await client.query(
          `INSERT INTO workflow.staging_import
           (batch_id, row_number, control_number, family_comments, children, is_valid)
           VALUES ($1, $2, $3, $4, $5, true)`,
          [
            batch_id,
            family.row_number,
            family.control_number,
            family.family_comment,
            JSON.stringify(family.children),
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[IMPORT] staging insert failed:", err);
      return res.render("index", {
        message: `Staging insert failed; transaction rolled back. ${err.message}`,
        report: parsed.report,
        blocked: true,
      });
    } finally {
      client.release();
    }

    return res.redirect(`/batch/${batch_id}`);
  } catch (err) {
    console.error("[IMPORT] parse failed:", err);
    return res.render("index", {
      message: `Error reading CSV: ${err.message}`,
      report: null,
      blocked: true,
    });
  } finally {
    fs.unlink(filePath, () => {});
  }
});

app.get("/batch/:batchId", async (req, res) => {
  try {
    const summary = await getBatchSummary(req.params.batchId);
    if (!summary) {
      return res.status(404).send("Batch not found");
    }
    res.render("batch-summary", { summary });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading batch summary");
  }
});

app.listen(PORT, () =>
  console.log(`CSV Importer running at http://localhost:${PORT}`)
);
