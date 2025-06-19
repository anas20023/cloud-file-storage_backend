import express from "express";
import admin from "firebase-admin";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import mongoose from "mongoose";
import dotenv from "dotenv";
import fetch from "node-fetch"; // Import node-fetch if using it
import { mimeTypeMapping } from "./mimeTypes.js"; // Adjust path as needed
const app = express();
dotenv.config(); // Load environment variables
const dburl = process.env.MONGO_URI;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

mongoose.connect(dburl, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

mongoose.connection.on("connected", () => {
  console.log("Connected to MongoDB");
});

const allowedOrigins = [
  "http://localhost:5173",
  "https://filepanel.vercel.app",
  "https://server.anasib.tech",
  "https://www.anasib.tech",
  "https://anasib.tech",
  "https://www.server.anasib.tech",
];

const corsOptions = {
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE"],
};

app.use(cors(corsOptions));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});
app.use(express.json());
app.use(bodyParser.json({ limit: "200mb" }));
app.use(bodyParser.urlencoded({ limit: "200mb", extended: true }));

// Initialize Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

// API Endpoints

// Upload File
app.post("/api/upload", upload.array("files"), async (req, res) => {
  const files = req.files;
  const fileNames = JSON.parse(req.body.fileNames);

  if (!files || !fileNames || files.length !== fileNames.length) {
    return res
      .status(400)
      .send({ message: "Missing required fields or mismatch in file count" });
  }

  try {
    const fileURLs = await Promise.all(
      files.map(async (file, index) => {
        const fileName = fileNames[index];
        const contentType = file.mimetype;

        const fileRef = bucket.file(`files/${fileName}`);
        await fileRef.save(file.buffer, { contentType });

        const [fileURL] = await fileRef.getSignedUrl({
          action: "read",
          expires: "03-09-2491",
        });

        await db.collection("files").add({
          fileName,
          uploadDate: new Date(),
          fileURL,
        });

        return fileURL;
      })
    );

    res.status(200).send({ message: "Files uploaded successfully", fileURLs });
  } catch (error) {
    console.error("Error uploading files:", error);
    res.status(500).send({ message: "Failed to upload files" });
  }
});

// Get Files Route
app.get("/api/files", async (req, res) => {
  try {
    const snapshot = await db.collection("files").get();
    const files = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      uploadDate: doc.data().uploadDate.toDate().toLocaleString(),
    }));

    res.status(200).json(files);
  } catch (error) {
    console.error("Error fetching files:", error);
    res.status(500).send({ message: "Failed to fetch files" });
  }
});

// Download File Route
app.get("/api/download/:fileName", async (req, res) => {
  const fileName = req.params.fileName;

  try {
    const fileRef = bucket.file(`files/${fileName}`);
    const [exists] = await fileRef.exists();

    if (!exists) {
      return res.status(404).send({ message: "File not found" });
    }

    const [fileURL] = await fileRef.getSignedUrl({
      action: "read",
      expires: "03-09-2491",
    });

    const response = await fetch(fileURL);

    if (!response.ok) throw new Error("Network response was not ok.");

    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", response.headers.get("Content-Type"));
    response.body.pipe(res);
  } catch (error) {
    console.error("Error downloading file:", error);
    res.status(500).send({ message: "Failed to download file" });
  }
});

// Delete File Route
app.delete("/api/files/:id", async (req, res) => {
  const fileId = req.params.id;

  try {
    const fileDoc = db.collection("files").doc(fileId);
    const fileData = (await fileDoc.get()).data();

    if (!fileData) {
      return res.status(404).send({ message: "File not found" });
    }

    const fileRef = bucket.file(`files/${fileData.fileName}`);
    await fileRef.delete();
    await fileDoc.delete();

    res.status(200).send({ message: "File deleted successfully" });
  } catch (error) {
    console.error("Error deleting file:", error);
    res.status(500).send({ message: "Failed to delete file" });
  }
});

// Statistics Endpoint
app.get("/api/statistics", async (req, res) => {
  try {
    const downloadsSnapshot = await db.collection("downloads").get();
    const totalDownloads = downloadsSnapshot.size;

    let totalUsedBytes = 0;
    const [files] = await bucket.getFiles();

    if (files.length > 0) {
      await Promise.all(
        files.map(async (file) => {
          try {
            const [metadata] = await file.getMetadata();
            if (metadata && metadata.size) {
              totalUsedBytes += parseInt(metadata.size, 10);
            } else {
              console.warn(`No size metadata for file: ${file.name}`);
            }
          } catch (error) {
            console.error(
              `Error retrieving metadata for file ${file.name}:`,
              error
            );
          }
        })
      );
    } else {
      console.warn("No files found in storage.");
    }

    const totalUsedGB = (totalUsedBytes / (1024 * 1024 * 1024)).toFixed(2);
    const totalFiles = files.length;

    const statistics = { totalDownloads, storageUsed: totalUsedGB, totalFiles };

    res.json(statistics);
  } catch (error) {
    console.error("Error fetching statistics:", error);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

// File Formats Endpoint
app.get("/api/file-formats", async (req, res) => {
  try {
    const [files] = await bucket.getFiles();
    const formats = new Map();

    await Promise.all(
      files.map(async (file) => {
        const [metadata] = await file.getMetadata();
        const contentType = metadata.contentType;
        const format =
          mimeTypeMapping[contentType] || contentType.split("/")[1];
        formats.set(format, (formats.get(format) || 0) + 1);
      })
    );

    const result = { formats: Array.from(formats.entries()) };

    res.json(result);
  } catch (error) {
    console.error("Error fetching file formats:", error);
    res.status(500).json({ error: "Failed to fetch file formats" });
  }
});


// Default Route
app.get("/", (req, res) => {
  res.send("Hello from the Express server!");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
