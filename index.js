import express from "express";
import admin from "firebase-admin";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import mongoose from "mongoose";
import dotenv from "dotenv";
import fetch from "node-fetch"; // Import node-fetch if using it
import { mimeTypeMapping } from "./mimeTypes.js"; // Adjust path as needed
import NodeCache from "node-cache";
const app = express();
dotenv.config(); // Load environment variables
const dburl = process.env.MONGO_URI;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});
//console.log(dburl);
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
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://server.anasib.tech');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE'); // Specify allowed methods
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // Specify allowed headers
  next();
});
app.use(express.json());
app.use(bodyParser.json({ limit: "200mb" }));
app.use(bodyParser.urlencoded({ limit: "200mb", extended: true }));
const cache = new NodeCache();

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

        // Store the file URL in the cache
        cache.set(fileName, fileURL);

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
    if (cache.has("files")) {
      return res.status(200).json(JSON.parse(cache.get("files")));
    }

    const snapshot = await db.collection("files").get();
    const files = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      uploadDate: doc.data().uploadDate.toDate().toLocaleString(),
    }));

    // Cache the files list
    cache.set("files", JSON.stringify(files));

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

    // Store the file URL in the cache
    cache.set(fileName, fileURL);

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

    // Clear the cache for the files list
    cache.del("files");

    res.status(200).send({ message: "File deleted successfully" });
  } catch (error) {
    console.error("Error deleting file:", error);
    res.status(500).send({ message: "Failed to delete file" });
  }
});

// Statistics Endpoint
app.get("/api/statistics", async (req, res) => {
  try {
    if (cache.has("statistics")) {
      return res.json(JSON.parse(cache.get("statistics")));
    }

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

    // Cache the statistics
    cache.set("statistics", JSON.stringify(statistics));

    res.json(statistics);
  } catch (error) {
    console.error("Error fetching statistics:", error);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

// File Formats Endpoint
app.get("/api/file-formats", async (req, res) => {
  try {
    if (cache.has("file-formats")) {
      return res.json(JSON.parse(cache.get("file-formats")));
    }

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

    // Cache the file formats
    cache.set("file-formats", JSON.stringify(result));

    res.json(result);
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

// Note Schema
const noteSchema = new mongoose.Schema({
  title: { type: String, required: true },
  text: { type: String, required: true },
});

const Note = mongoose.model("Note", noteSchema);

// API Endpoints
app.get("/api/notes", async (req, res) => {
  try {
    // Check if notes are cached
    if (cache.has("notes")) {
      // Fetch notes from cache
      const cachedNotes = cache.get("notes");
      return res.json(JSON.parse(cachedNotes));
    } else {
      // Fetch notes from the database
      const notes = await Note.find();
      // Cache the notes
      cache.set("notes", JSON.stringify(notes));
      return res.json(notes);
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/notes", async (req, res) => {
  try {
    const { title, text } = req.body;
    if (!title || !text) {
      return res.status(400).json({ message: "Title and text are required" });
    }

    const newNote = new Note({
      title,
      text,
    });
    await newNote.save();

    // Update the cache
    const cachedNotes = JSON.parse(cache.get("notes") || "[]");
    cachedNotes.push(newNote);
    cache.set("notes", JSON.stringify(cachedNotes));

    res.json(newNote);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.put("/api/notes/:id", async (req, res) => {
  try {
    const { title, text } = req.body;
    const updatedNote = await Note.findByIdAndUpdate(
      req.params.id,
      { title, text },
      { new: true }
    );
    if (!updatedNote) {
      return res.status(404).json({ message: "Note not found" });
    }

    // Update the cache
    const cachedNotes = JSON.parse(cache.get("notes") || "[]");
    const noteIndex = cachedNotes.findIndex(
      (note) => note._id.toString() === req.params.id
    );
    if (noteIndex !== -1) {
      cachedNotes[noteIndex] = updatedNote; // Update the specific note
      cache.set("notes", JSON.stringify(cachedNotes));
    }

    res.json(updatedNote);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.delete("/api/notes/:id", async (req, res) => {
  try {
    const deletedNote = await Note.findByIdAndDelete(req.params.id);
    if (!deletedNote) {
      return res.status(404).json({ message: "Note not found" });
    }

    // Update the cache
    const cachedNotes = JSON.parse(cache.get("notes") || "[]");
    const updatedCachedNotes = cachedNotes.filter(
      (note) => note._id.toString() !== req.params.id
    );
    cache.set("notes", JSON.stringify(updatedCachedNotes));

    res.json(deletedNote);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});
// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
