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

// mongoose.connect(dburl, {
//   useNewUrlParser: true,
//   useUnifiedTopology: true,
// });

// mongoose.connection.on("connected", () => {
//   console.log("Connected to MongoDB");
// });

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
app.post('/api/upload', upload.array('files'), async (req, res) => {
  try {
    const files = req.files;
    const { fileNames, user_name } = req.body;

    if (!user_name) {
      return res.status(400).json({
        message: 'Missing user_name',
      });
    }

    if (!files || !fileNames) {
      return res.status(400).json({
        message: 'Missing required fields',
      });
    }

    const parsedFileNames = JSON.parse(fileNames);

    if (files.length !== parsedFileNames.length) {
      return res.status(400).json({
        message: 'File count and fileNames count mismatch',
      });
    }

    const fileURLs = await Promise.all(
      files.map(async (file, index) => {
        const originalFileName = parsedFileNames[index];
        const contentType = file.mimetype;

        const storagePath = `files/${user_name}/${Date.now()}_${originalFileName}`;
        const fileRef = bucket.file(storagePath);

        await fileRef.save(file.buffer, {
          contentType,
          resumable: false,
        });

        const [fileURL] = await fileRef.getSignedUrl({
          action: 'read',
          expires: '03-09-2491',
        });

        await db.collection('files').add({
          fileName: originalFileName,
          storagePath,
          fileURL,
          userName: user_name,
          uploadDate: new Date(),
          contentType,
        });

        return fileURL;
      })
    );

    return res.status(200).json({
      message: 'Files uploaded successfully',
      fileURLs,
    });
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({
      message: 'Failed to upload files',
    });
  }
});


// Get Files Route
app.get('/api/files', async (req, res) => {
  try {
    const { user_name } = req.query;

    if (!user_name) {
      return res.status(400).json({
        message: 'Missing user_name',
      });
    }

    const snapshot = await db
      .collection('files')
      .where('userName', '==', user_name)
      .orderBy('uploadDate', 'desc')
      .get();

    const files = snapshot.docs.map((doc) => {
      const data = doc.data();

      return {
        id: doc.id,
        ...data,
        uploadDate: data.uploadDate
          ? data.uploadDate.toDate().toLocaleString()
          : null,
      };
    });

    return res.status(200).json(files);
  } catch (error) {
    console.error('Error fetching files:', error);
    return res.status(500).json({
      message: 'Failed to fetch files',
    });
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
app.delete('/api/files/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_name } = req.query;

    if (!user_name) {
      return res.status(400).json({ message: 'Missing user_name' });
    }

    const fileDocRef = db.collection('files').doc(id);
    const fileSnap = await fileDocRef.get();

    if (!fileSnap.exists) {
      return res.status(404).json({ message: 'File not found' });
    }

    const fileData = fileSnap.data();

    // 🔒 Ownership check
    if (fileData.userName !== user_name) {
      return res.status(403).json({ message: 'Unauthorized delete attempt' });
    }

    // ✅ Delete from storage using exact path
    if (fileData.storagePath) {
      await bucket.file(fileData.storagePath).delete();
    }

    // ✅ Delete Firestore record
    await fileDocRef.delete();

    res.status(200).json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ message: 'Failed to delete file' });
  }
});


// Statistics Endpoint
app.get('/api/statistics', async (req, res) => {
  try {
    const { user_name } = req.query;

    if (!user_name) {
      return res.status(400).json({ message: 'Missing user_name' });
    }

    // 1️⃣ Total downloads (UNCHANGED)
    const downloadsSnapshot = await db
      .collection('downloads')
      .where('userName', '==', user_name)
      .get();

    const totalDownloads = downloadsSnapshot.size;

    // 2️⃣ User files (count + size)
    const filesSnapshot = await db
      .collection('files')
      .where('userName', '==', user_name)
      .get();

    const totalFiles = filesSnapshot.size;

    let totalUsedBytes = 0;

    await Promise.all(
      filesSnapshot.docs.map(async (doc) => {
        const { storagePath } = doc.data();
        if (!storagePath) return;

        try {
          const [metadata] = await bucket.file(storagePath).getMetadata();
          if (metadata?.size) {
            totalUsedBytes += Number(metadata.size);
          }
        } catch (err) {
          console.error(`Metadata error for ${storagePath}`, err);
        }
      })
    );
    // console.log(totalUsedBytes)
    // const storageUsed = (totalUsedBytes / (1024 ** 2)).toFixed(2); // GB

    res.json({
      totalFiles,
      totalUsedBytes,
      totalDownloads,
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});


// File Formats Endpoint
app.get('/api/file-formats', async (req, res) => {
  try {
    const { user_name } = req.query;

    if (!user_name) {
      return res.status(400).json({ message: 'Missing user_name' });
    }

    const snapshot = await db
      .collection('files')
      .where('userName', '==', user_name)
      .get();

    const formats = new Map();

    snapshot.docs.forEach((doc) => {
      const { contentType } = doc.data();
      if (!contentType) return;

      const format =
        mimeTypeMapping[contentType] || contentType.split('/')[1] || 'unknown';

      formats.set(format, (formats.get(format) || 0) + 1);
    });

    res.json({
      formats: Array.from(formats.entries()),
    });
  } catch (error) {
    console.error('Error fetching file formats:', error);
    res.status(500).json({ error: 'Failed to fetch file formats' });
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
