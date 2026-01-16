require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const { parse } = require("csv-parse");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 4000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : false,
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set("view engine", "ejs");
app.set("views", "./views");

// Multer for file uploads
const upload = multer({ dest: "uploads/" });

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

// GET home page
app.get("/", (req, res) => {
  res.render("index", { message: null, report: null });
});

// POST /import route
app.post("/import", upload.single("csv"), (req, res) => {
  if (!req.file)
    return res.render("index", { message: "No file uploaded", report: null });

  const batch_id = uuidv4();
  const rows = [];
  const report = [];

  fs.createReadStream(req.file.path)
    .pipe(
      parse({
        trim: true,
        skip_empty_lines: true,
        columns: true, // Use CSV headers verbatim
      })
    )
    .on("data", (r) => rows.push(r))
    .on("end", async () => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const row_number = i + 2; // CSV header + 1-index

        const control_number = r["CONTROL_NUMBER"]?.trim();
        const family_comments = r["FAMILY_COMMENTS"]?.trim() || null;

        if (!control_number) {
          report.push({
            row_number,
            status: "error",
            error: "Missing CONTROL_NUMBER",
          });
          continue;
        }

        // Build children array
        const children = [];
        let n = 1;
        while (r[`GENDER${n}`] && r[`AGE${n}`]) {
          const genderRaw = r[`GENDER${n}`].trim().toUpperCase();
          const ageStr = r[`AGE${n}`].trim();
          const specialRequests = r[`COMMENTS${n}`]?.trim() || null;

          if (genderRaw && /^\d+$/.test(ageStr)) {
            const gender = genderRaw.includes("M") ? "Boy" : "Girl";
            const age = parseInt(ageStr, 10);
            children.push({ gender, age, special_requests: specialRequests });
          }
          n++;
        }

        if (children.length === 0) {
          report.push({
            row_number,
            status: "error",
            error: "No valid children",
          });
          continue;
        }

        // Insert into staging_import
        try {
          await pool.query(
            `INSERT INTO workflow.staging_import
             (batch_id, row_number, control_number, family_comments, children)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              batch_id,
              row_number,
              control_number,
              family_comments,
              JSON.stringify(children),
            ]
          );
          report.push({ row_number, status: "inserted", control_number });
        } catch (err) {
          report.push({ row_number, status: "error", error: err.message });
        }
      }

      fs.unlinkSync(req.file.path);
      res.redirect(`/batch/${batch_id}`);
    })
    .on("error", (err) => {
      res.render("index", {
        message: `Error reading CSV: ${err.message}`,
        report: null,
      });
    });
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
