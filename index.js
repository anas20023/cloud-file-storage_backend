import express from "express";
import admin from "firebase-admin";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import dotenv from "dotenv";
import fetch from "node-fetch"; // Import node-fetch if using it
import { mimeTypeMapping } from "./mimeTypes.js"; // Adjust path as needed
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

const app = express();
dotenv.config(); // Load environment variables
const allowedOrigins = [
  "http://localhost:5173",
  "https://filepanel.vercel.app",
  "https://server.anasib.tech",
  "https://www.anasib.tech",
  "https://anasib.tech",
  "https://www.server.anasib.tech",
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE"],
};

app.use(cors(corsOptions));

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
  const files = req.files; // Array of files
  const fileNames = JSON.parse(req.body.fileNames); // Parse JSON array

  if (!files || !fileNames || files.length !== fileNames.length) {
    return res
      .status(400)
      .send({ message: "Missing required fields or mismatch in file count" });
  }

  try {
    const fileURLs = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileName = fileNames[i];
      const contentType = file.mimetype;

      const fileRef = bucket.file(`files/${fileName}`);
      await fileRef.save(file.buffer, { contentType });

      const [fileURL] = await fileRef.getSignedUrl({
        action: "read",
        expires: "03-09-2491", // Long expiration date
      });

      fileURLs.push(fileURL);

      await db.collection("files").add({
        fileName,
        uploadDate: new Date(),
        fileURL,
      });
    }

    res.status(200).send({ message: "Files uploaded successfully", fileURLs });
  } catch (error) {
    console.error("Error uploading files:", error);
    res.status(500).send({ message: "Failed to upload files" });
  }
});

// Get Files
app.get("/api/files", async (req, res) => {
  try {
    const snapshot = await db.collection("files").get();
    const files = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        uploadDate: data.uploadDate.toDate().toLocaleString(), // Convert Firestore Timestamp to readable date
      };
    });

    res.status(200).json(files);
  } catch (error) {
    console.error("Error fetching files:", error);
    res.status(500).send({ message: "Failed to fetch files" });
  }
});

// Download File
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
      expires: "03-09-2491", // Long expiration date
    });

    // Fetch the file from the signed URL
    const response = await fetch(fileURL);

    if (!response.ok) {
      throw new Error("Network response was not ok.");
    }

    // Set the appropriate headers
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", response.headers.get("Content-Type"));

    // Pipe the file to the response
    response.body.pipe(res);
  } catch (error) {
    console.error("Error downloading file:", error);
    res.status(500).send({ message: "Failed to download file" });
  }
});

// Delete File
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
  //console.log("API Called");
  try {
    // Total Download Number
    const downloadsSnapshot = await db.collection("downloads").get();
    const totalDownloads = downloadsSnapshot.size;

    // Total Used GB
    let totalUsedBytes = 0;
    const [files] = await bucket.getFiles();

    // Check if there are files
    if (files.length > 0) {
      for (const file of files) {
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
      }
    } else {
      console.warn("No files found in storage.");
    }

    const totalUsedGB = (totalUsedBytes / (1024 * 1024 * 1024)).toFixed(2); // Convert bytes to GB

    // Total Files
    const totalFiles = files.length;

    // Send the statistics as a response
    res.json({
      totalDownloads,
      storageUsed: totalUsedGB,
      totalFiles,
    });
  } catch (error) {
    console.error("Error fetching statistics:", error);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

app.get("/api/file-formats", async (req, res) => {
  try {
    const [files] = await bucket.getFiles();
    const formats = new Map();

    for (const file of files) {
      const [metadata] = await file.getMetadata();
      const contentType = metadata.contentType;
      if (contentType) {
        // Use the mimeTypeMapping to get the simplified format
        const format =
          mimeTypeMapping[contentType] || contentType.split("/")[1];
        formats.set(format, (formats.get(format) || 0) + 1); // Count occurrences of each format
      }
    }

    res.json({ formats: Array.from(formats.entries()) });
  } catch (error) {
    console.error("Error fetching file formats:", error);
    res.status(500).json({ error: "Failed to fetch file formats" });
  }
});
app.get("/api/weather", async (req, res) => {
  const { latitude, longitude } = req.query;
  console.log(latitude, longitude);
  const API_KEY = process.env.WEATHER_API_KEY;
  try {
    const response = await fetch(
      `https://api.weatherapi.com/v1/current.json?key=${API_KEY}&q=${latitude},${longitude}`
    );
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: "Error fetching weather data" });
  }
});
// Get Users
app.post("/api/authenticate", async (req, res) => {
  console.log("Working");
  const { username, password } = req.body;

  try {
    const snapshot = await db
      .collection("users")
      .where("username", "==", username)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(401).json({
        authenticated: false,
        message: "Invalid username or password",
      });
    }

    const user = snapshot.docs[0].data();

    // Assuming passwords are stored as plain text (which is not recommended)
    if (user.password === password) {
      return res.status(200).json({ authenticated: true });
    } else {
      return res.status(401).json({
        authenticated: false,
        message: "Invalid username or password",
      });
    }
  } catch (error) {
    console.error("Error authenticating user:", error);
    return res.status(500).send({ message: "Failed to authenticate user" });
  }
});
app.get("/", async (req, res) => {
  res.send("Hello World");
});
// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
