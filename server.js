// Import packages
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");

const app = express();
const PORT = process.env.PORT || 5000;
const BASE_URL = process.env.BASE_URL || "https://swiftshare-backend-jxag.onrender.com";

const DATA_FILE = path.join(__dirname, "fileGroups.json");

// ==========================
// 🚨 CORS FIX & Middleware
// ==========================
app.use(
    cors({
        origin: "*",
        methods: ["POST", "GET"],
    })
);

app.use(express.json());

app.use(express.urlencoded({ extended: true, limit: "500mb" }));

// Create uploads folder if not exists
const uploadFolder = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadFolder)) {
    fs.mkdirSync(uploadFolder);
}

function loadFileGroupMap() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, "utf8");
            // Return parsed data or an empty object if file is empty
            return JSON.parse(data || "{}");
        }
    } catch (error) {
        console.error("❌ Error loading file group map:", error.message);
    }
    // Return empty map if file doesn't exist or on error
    return {};
}

/**
 * Writes the current file group map to the JSON file.
 * @param {Object} map - The map to save.
 */
function saveFileGroupMap(map) {
    try {
        // Use 2 spaces for readable JSON formatting
        fs.writeFileSync(DATA_FILE, JSON.stringify(map, null, 2), "utf8");
    } catch (error) {
        console.error("❌ Error saving file group map:", error.message);
    }
}

// 🆕 Load map into memory on server start
let fileGroupMap = loadFileGroupMap();

// ===================================
// 💾 MULTER CONFIGURATION AND LIMITS
// ===================================

// Define Limits
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 5 MB limit per file
const MAX_FILE_COUNT = 4; // 2 files limit

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadFolder);
    },
    filename: (req, file, cb) => {
        // Filename format: [uniqueID]-[originalname]
        const uniqueName =
            Date.now().toString(36) +
            Math.random().toString(36).substring(2, 5) +
            "-" +
            file.originalname;
        cb(null, uniqueName);
    },
});

// Configure Multer with limits
const upload = multer({
    storage: storage,
    limits: {
        fileSize: MAX_FILE_SIZE, // Apply file size limit
        files: MAX_FILE_COUNT, // Apply max file count limit
    },
});

// =========================================
// 📤 Robust Upload Route with Error Handling
// =========================================
app.post(
    "/upload",
    (req, res, next) => {
        // 1. Run Multer middleware (handling array of files, limits applied via config)
        upload.array("files")(req, res, async function(err) {
            // 🚨 Multer Error Handling
            if (err instanceof multer.MulterError) {
                console.error("🚨 Multer Error:", err.code);
                let message = "A file upload error occurred.";

                if (err.code === "LIMIT_FILE_SIZE") {
                    message = `File too large. Maximum size is ${
            MAX_FILE_SIZE / (1024 * 1024)
          }MB.`;
                } else if (
                    err.code === "LIMIT_UNEXPECTED_FILE" ||
                    err.code === "LIMIT_FILE_COUNT"
                ) {
                    message = `Too many files selected. Maximum is ${MAX_FILE_COUNT}.`;
                }

                // Return a 400 Bad Request for client-side errors (limits)
                return res.status(400).json({
                    error: message,
                    code: err.code,
                });
            }

            // 🚨 General Server Error Handling
            if (err) {
                console.error("🚨 General Upload Error:", err);
                return res
                    .status(500)
                    .json({ error: "An unknown server error occurred during upload." });
            }

            // If no error, continue to the next middleware (main route logic)
            next();
        });
    },
    async(req, res) => {
        // 2. Main route logic (executed only if Multer succeeded)
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No files uploaded" });
        }

        const fileCount = req.files.length;
        let downloadLink;

        if (fileCount > 1) {
            // --- MULTIPLE FILES: Generate a single ZIP link ---
            const uploadedFilenames = req.files.map((f) => f.filename);
            // GroupID is the unique timestamp from the first file's filename
            const groupID = uploadedFilenames[0].split("-")[0];

            // 💾 Update in-memory map AND save it to file (MODIFIED)
            fileGroupMap[groupID] = uploadedFilenames;
            saveFileGroupMap(fileGroupMap); // <--- ADDED PERSISTENCE STEP

            downloadLink = `${BASE_URL}/download-group/${groupID}`;
            console.log(
                `[UPLOAD] New Group (${groupID}) of ${fileCount} files uploaded.`
            );
        } else {
            // --- SINGLE FILE: Generate a direct download link ---
            const singleFilename = req.files[0].filename;
            downloadLink = `${BASE_URL}/download-file/${singleFilename}`;
        }

        // Generate QR Code for the single resulting link
        const qrCode = await QRCode.toDataURL(downloadLink);
        res.setHeader("Content-Type", "application/json; charset=utf-8");

        res.json({
            message: "File(s) processed successfully",
            file_count: fileCount,
            download_link: downloadLink,
            qr_code: qrCode,
            uploaded_files: req.files.map((f) => f.originalname),
        });
    }
);

// ==========================
// 📥 Download Single File Route
// ==========================
app.get("/download-file/:filename", (req, res) => {
    const filePath = path.join(uploadFolder, req.params.filename);
    if (fs.existsSync(filePath)) {
        // Extract original name from the server filename for the download header
        const originalName = req.params.filename.split("-").slice(1).join("-");
        res.download(filePath, originalName);
    } else {
        res.status(404).json({ error: "File not found" });
    }
});

// ==========================
// 📦 Download Group Route (The ZIP mechanism)
// ==========================
app.get("/download-group/:groupId", (req, res) => {
    const groupId = req.params.groupId;
    const filesToZip = fileGroupMap[groupId];

    if (!filesToZip || filesToZip.length === 0) {
        return res.status(404).send("File group not found or empty.");
    }

    res.set({
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="SwiftShare_Files_${groupId}.zip"`,
    });

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("warning", (err) => console.warn("Archiver warning:", err));
    archive.on("error", (err) => {
        res.status(500).send({ error: err.message });
    });
    archive.pipe(res);

    filesToZip.forEach((serverFilename) => {
        const filePath = path.join(uploadFolder, serverFilename);
        const originalName = serverFilename.split("-").slice(1).join("-");

        if (fs.existsSync(filePath)) {
            archive.file(filePath, { name: originalName });
        } else {
            console.warn(`File not found on server: ${filePath}`);
        }
    });

    archive.finalize();
});

// ==========================
// 🔍 Group Info Route (for receiver page)
// ==========================
app.get("/group-info/:groupId", (req, res) => {
    const groupId = req.params.groupId;
    const filesInGroup = fileGroupMap[groupId];

    if (!filesInGroup || filesInGroup.length === 0) {
        return res.status(404).json({ error: "File group not found" });
    }

    const fileInfo = filesInGroup.map((serverFilename) => {
        const originalName = serverFilename.split("-").slice(1).join("-");
        return { name: originalName };
    });

    res.json({
        type: "group",
        groupId: groupId,
        files: fileInfo,
        download_link: `${BASE_URL}/download-group/${groupId}`,
    });
});

// ===================================
// 🧹 AUTOMATIC CLEANUP IMPLEMENTATION
// ===================================
// 🧹 Automatic cleanup of old files (Snapdrop-style)
const FILE_EXPIRY_HOURS = 24; // how long files stay alive
const CLEANUP_INTERVAL_MINUTES = 60; // how often to check

function cleanupOldFiles() {
  console.log("🧹 Running cleanup check...");
  const now = Date.now();

  fs.readdir(uploadDir, (err, files) => {
    if (err) return console.error("Cleanup error:", err);

    files.forEach((file) => {
      const filePath = path.join(uploadDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        const ageHours = (now - stats.mtimeMs) / (1000 * 60 * 60);
        if (ageHours > FILE_EXPIRY_HOURS) {
          fs.unlink(filePath, (err) => {
            if (!err) console.log(`🗑️ Deleted expired file: ${file}`);
          });
        }
      });
    });
  });
}

// Run cleanup every hour
setInterval(cleanupOldFiles, CLEANUP_INTERVAL_MINUTES * 60 * 1000);

// Start server
app.listen(PORT, () =>
    console.log(`Server running on ${BASE_URL}`)

);


