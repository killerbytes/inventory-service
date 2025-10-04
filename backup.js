/**
 * backup.js (Postgres version, Render-safe)
 *
 * Options:
 *  - backup        (schema + data, safe for Render)
 *  - backup-data   (data-only)
 *  - restore [f]   (restore from latest or given file)
 *  - restore-and-dev [f]
 */

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const zlib = require("zlib");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

// 1️⃣ Load environment
const env = process.env.NODE_ENV || "development";
if (!process.env.DB_HOST) {
  const dotenvPath = `.env.${env}`;
  if (fs.existsSync(dotenvPath)) {
    require("dotenv").config({ path: dotenvPath });
    console.log(`🔑 Loaded env from ${dotenvPath}`);
  } else {
    console.error(`❌ Missing ${dotenvPath} (DB_HOST not set)`);
    process.exit(1);
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

if (!DB_HOST || !DB_USERNAME || !DB_NAME) {
  console.error(
    "❌ Missing database config (DB_HOST, DB_USERNAME, DB_NAME required)"
  );
  process.exit(1);
}

const BACKUP_DIR = process.env.BACKUP_DIR || "./backups";
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Run shell command
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

// Pick latest backup file
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

// 1️⃣ Backup
async function backup({ dataOnly = false } = {}) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = dataOnly ? "data-only" : "full";
  const ext = dataOnly ? "sql.gz" : "dump";
  const outFile = path.join(BACKUP_DIR, `${DB_NAME}-${suffix}-${ts}.${ext}`);

  const dumpCmd = dataOnly
    ? `pg_dump -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USERNAME} --data-only --no-owner --no-acl ${DB_NAME}`
    : `pg_dump -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USERNAME} --no-owner --no-acl --clean --if-exists -Fc ${DB_NAME}`;

  console.log(`📦 Creating ${suffix} backup...`);

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

// 2️⃣ Restore
async function restore(filePath) {
  console.log(`♻️  Restoring from ${filePath}...`);
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

  const restoreCmd = sqlFilePath.endsWith(".dump")
    ? `pg_restore -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USERNAME} --no-owner --no-acl --clean --if-exists -d ${DB_NAME} "${sqlFilePath}"`
    : `psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USERNAME} -d ${DB_NAME} -f "${sqlFilePath}"`;

  try {
    await runCommand(restoreCmd);
    console.log("✅ Restore complete!");
  } catch (err) {
    console.error("❌ Restore failed:\n", err);
  }

  if (sqlFilePath !== filePath) fs.unlinkSync(sqlFilePath);
}

// 3️⃣ Restore and dev
async function restoreAndDev(filePath) {
  await restore(filePath);
  console.log("🚀 Starting dev server...");
  runCommand("npm run dev");
}

// Upload to Backblaze B2
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
    await s3.send(
      new PutObjectCommand({
        Bucket: B2_BUCKET,
        Key: key,
        Body: fileStream,
      })
    );
    console.log(`☁️  Uploaded ${key} → Backblaze B2`);

    fs.unlinkSync(filePath);
    console.log(`🗑️  Local file deleted: ${filePath}`);

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
        console.log(`🗑️  Deleted old backup from B2: ${file.Key}`);
      }
    }
  } catch (err) {
    console.error("❌ Backblaze upload/cleanup failed:", err.message);
  }
}

// CLI
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
