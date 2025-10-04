/**
 * backup.js (Postgres + Backblaze B2)
 *
 * Commands:
 *   node backup.js backup          # Full backup (schema+data)
 *   node backup.js backup-data     # Data-only backup
 *   node backup.js restore [file]  # Restore backup
 *   node backup.js restore-and-dev [file] # Restore then start dev
 */

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const zlib = require("zlib");
const { URL } = require("url");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

// -------------------- Load ENV --------------------
const env = process.env.NODE_ENV || "development";
if (env !== "production") {
  require("dotenv").config({ path: `.env.${env}` });
}

// Parse DATABASE_URL if available
if (process.env.DATABASE_URL) {
  try {
    const dbUrl = new URL(process.env.DATABASE_URL);
    process.env.DB_HOST = dbUrl.hostname;
    process.env.DB_PORT = dbUrl.port || 5432;
    process.env.DB_USERNAME = dbUrl.username;
    process.env.DB_PASSWORD = dbUrl.password;
    process.env.DB_NAME = dbUrl.pathname.slice(1);
  } catch (err) {
    console.error("❌ Failed to parse DATABASE_URL:", err.message);
  }
}

const {
  DB_HOST,
  DB_USERNAME,
  DB_PASSWORD,
  DB_NAME,
  DB_PORT = 5432,
  B2_BUCKET,
  AWS_ENDPOINT,
  AWS_DEFAULT_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
} = process.env;

if (!DB_HOST || !DB_NAME || !DB_USERNAME) {
  console.error("❌ Missing database config! Check Railway Variables.");
  process.exit(1);
}

const BACKUP_DIR = process.env.BACKUP_DIR || "./backups";
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// -------------------- Helpers --------------------
function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      { env: { ...process.env, PGPASSWORD: DB_PASSWORD } },
      (error, stdout, stderr) => {
        if (error) return reject(stderr || error.message);
        resolve(stdout);
      }
    );
  });
}

function getLatestBackup() {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /\.(sql|dump)(\.gz)?$/.test(f))
    .map((f) => ({
      name: f,
      time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.time - a.time);
  return files.length ? path.join(BACKUP_DIR, files[0].name) : null;
}

// -------------------- Backup --------------------
async function backup({ dataOnly = false } = {}) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = dataOnly ? "data-only" : "full";
  const ext = dataOnly ? "sql.gz" : "dump";
  const outFile = path.join(BACKUP_DIR, `${DB_NAME}-${suffix}-${ts}.${ext}`);

  const dumpCmd = dataOnly
    ? `pg_dump -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USERNAME} \
       --data-only --no-owner --no-acl ${DB_NAME}`
    : `pg_dump -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USERNAME} \
       --no-owner --no-acl --clean --if-exists -Fc ${DB_NAME}`;

  console.log(`Creating ${suffix} backup...`);

  if (dataOnly) {
    const dumpProcess = exec(dumpCmd, {
      env: { ...process.env, PGPASSWORD: DB_PASSWORD },
    });
    const gzip = zlib.createGzip();
    const outStream = fs.createWriteStream(outFile);
    dumpProcess.stdout.pipe(gzip).pipe(outStream);
    outStream.on("finish", async () => {
      console.log(`✅ Backup saved: ${outFile}`);
      await uploadToBackblaze(outFile);
    });
  } else {
    await runCommand(`${dumpCmd} -f "${outFile}"`);
    console.log(`✅ Backup saved: ${outFile}`);
    await uploadToBackblaze(outFile);
  }
}

// -------------------- Restore --------------------
async function restore(filePath) {
  console.log(`Restoring from ${filePath}...`);
  let sqlFilePath = filePath;

  if (filePath.endsWith(".gz")) {
    const decompressed = filePath.replace(/\.gz$/, "");
    await new Promise((resolve, reject) =>
      fs
        .createReadStream(filePath)
        .pipe(zlib.createGunzip())
        .pipe(fs.createWriteStream(decompressed))
        .on("finish", resolve)
        .on("error", reject)
    );
    sqlFilePath = decompressed;
  }

  let restoreCmd;
  if (sqlFilePath.endsWith(".dump")) {
    restoreCmd = `pg_restore -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USERNAME} \
      --no-owner --no-acl --clean --if-exists -d ${DB_NAME} "${sqlFilePath}"`;
  } else {
    restoreCmd = `psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USERNAME} \
      -d ${DB_NAME} -f "${sqlFilePath}"`;
  }
  try {
    await runCommand(restoreCmd);
    console.log("✅ Restore complete!");
  } catch (err) {
    console.error("❌ Restore failed:\n", err);
  }

  if (sqlFilePath !== filePath) fs.unlinkSync(sqlFilePath);
}

async function restoreAndDev(filePath) {
  await restore(filePath);
  console.log("Starting dev server...");
  runCommand("npm run dev");
}

// -------------------- Backblaze Upload --------------------
async function uploadToBackblaze(filePath) {
  if (!B2_BUCKET) return;

  const s3 = new S3Client({
    region: AWS_DEFAULT_REGION || "us-east-005",
    endpoint: AWS_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });

  const key = path.basename(filePath);
  const fileStream = fs.createReadStream(filePath);

  try {
    // Upload
    await s3.send(
      new PutObjectCommand({
        Bucket: B2_BUCKET,
        Key: key,
        Body: fileStream,
      })
    );
    console.log(`☁️  Uploaded ${key} → Backblaze B2`);

    // Delete local file
    fs.unlinkSync(filePath);
    console.log(`🗑️  Local file deleted: ${filePath}`);

    // Keep only last 7 in bucket
    const KEEP_LAST = 7;
    const listResp = await s3.send(
      new ListObjectsV2Command({ Bucket: B2_BUCKET })
    );
    if (listResp.Contents && listResp.Contents.length > KEEP_LAST) {
      const sorted = listResp.Contents.sort(
        (a, b) => new Date(b.LastModified) - new Date(a.LastModified)
      );
      const oldFiles = sorted.slice(KEEP_LAST);
      for (const file of oldFiles) {
        await s3.send(
          new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: file.Key })
        );
        console.log(`🗑️  Deleted old backup: ${file.Key}`);
      }
    }
  } catch (err) {
    console.error("❌ Backblaze upload/cleanup failed:", err.message);
  }
}

// -------------------- CLI --------------------
const [, , cmd, file] = process.argv;
(async () => {
  const f = file || getLatestBackup();
  switch (cmd) {
    case "backup":
      return backup();
    case "backup-data":
      return backup({ dataOnly: true });
    case "restore":
      if (!f) return console.error("No backup file found!");
      return restore(f);
    case "restore-and-dev":
      if (!f) return console.error("No backup file found!");
      return restoreAndDev(f);
    default:
      console.log("Commands:");
      console.log(
        "  node backup.js backup          # Full backup (schema+data)"
      );
      console.log("  node backup.js backup-data     # Data-only backup");
      console.log("  node backup.js restore [file]  # Restore backup");
      console.log(
        "  node backup.js restore-and-dev [file] # Restore then start dev"
      );
  }
})();
