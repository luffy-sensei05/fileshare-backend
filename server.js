// Load environment variables
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Middleware
// Configure CORS to allow requests from the frontend
app.use(cors({
  origin: [FRONTEND_URL, 'https://fileshare-app-eight.vercel.app', 'https://fileshare-backend-pa0n.onrender.com'], // Your domains
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json());

// Create a public directory for frontend files
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Serve static files from the public directory
app.use(express.static(publicDir));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Create chunks directory for chunked uploads
const chunksDir = path.join(__dirname, 'chunks');
if (!fs.existsSync(chunksDir)) {
  fs.mkdirSync(chunksDir, { recursive: true });
}

// Create database file if it doesn't exist
const dbPath = path.join(__dirname, 'db.json');
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, JSON.stringify({ files: [] }));
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Use original filename but ensure it's unique
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  }
});

// Helper function to read/write to our simple JSON database
const getDb = () => {
  const data = fs.readFileSync(dbPath, 'utf8');
  return JSON.parse(data);
};

const saveDb = (data) => {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
};

// Store upload metadata for chunked uploads
const chunkedUploads = {};

// Routes
// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running' });
});

// Initialize a chunked upload
app.post('/api/upload/init', express.json(), (req, res) => {
  try {
    const { uploadId, filename, totalChunks, fileSize, mimeType } = req.body;

    // Create directory for this upload's chunks
    const uploadChunksDir = path.join(chunksDir, uploadId);
    if (!fs.existsSync(uploadChunksDir)) {
      fs.mkdirSync(uploadChunksDir, { recursive: true });
    }

    // Store metadata
    chunkedUploads[uploadId] = {
      filename,
      totalChunks: parseInt(totalChunks),
      receivedChunks: 0,
      fileSize: parseInt(fileSize),
      mimeType,
      uploadChunksDir,
      createdAt: Date.now()
    };

    res.json({ success: true, message: 'Upload initialized' });
  } catch (error) {
    console.error('Upload initialization error:', error);
    res.status(500).json({ error: 'Failed to initialize upload' });
  }
});

// Handle chunk upload
const chunkUpload = multer({
  dest: path.join(chunksDir, 'temp'),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB per chunk
}).single('chunk');

app.post('/api/upload/chunk', (req, res) => {
  chunkUpload(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      const { uploadId, chunkIndex } = req.body;

      if (!chunkedUploads[uploadId]) {
        // Clean up the temporary file
        if (req.file && req.file.path) {
          fs.unlinkSync(req.file.path);
        }
        return res.status(400).json({ error: 'Invalid upload ID' });
      }

      // Move chunk from temp to the upload's chunks directory
      const chunkPath = path.join(chunkedUploads[uploadId].uploadChunksDir, chunkIndex);
      fs.renameSync(req.file.path, chunkPath);

      // Update received chunks count
      chunkedUploads[uploadId].receivedChunks++;

      res.json({
        success: true,
        receivedChunks: chunkedUploads[uploadId].receivedChunks,
        totalChunks: chunkedUploads[uploadId].totalChunks
      });
    } catch (error) {
      console.error('Chunk upload error:', error);
      res.status(500).json({ error: 'Failed to process chunk' });
    }
  });
});

// Complete chunked upload
app.post('/api/upload/complete', express.json(), async (req, res) => {
  try {
    const { uploadId } = req.body;
    const uploadInfo = chunkedUploads[uploadId];

    if (!uploadInfo) {
      return res.status(400).json({ error: 'Invalid upload ID' });
    }

    // Check if all chunks were received
    if (uploadInfo.receivedChunks !== uploadInfo.totalChunks) {
      return res.status(400).json({
        error: 'Not all chunks received',
        received: uploadInfo.receivedChunks,
        expected: uploadInfo.totalChunks
      });
    }

    // Generate a unique code
    const code = crypto.randomBytes(3).toString('hex');

    // Create a unique filename
    const storedFilename = `chunked-${Date.now()}-${code}${path.extname(uploadInfo.filename)}`;
    const filePath = path.join(uploadsDir, storedFilename);

    // Create write stream for the final file
    const writeStream = fs.createWriteStream(filePath);

    // Combine all chunks
    for (let i = 0; i < uploadInfo.totalChunks; i++) {
      const chunkPath = path.join(uploadInfo.uploadChunksDir, i.toString());
      const chunkBuffer = fs.readFileSync(chunkPath);
      writeStream.write(chunkBuffer);
    }

    writeStream.end();

    // Wait for the file to be written
    await new Promise(resolve => writeStream.on('finish', resolve));

    // Save file info to database
    const db = getDb();
    db.files.push({
      id: code,
      filename: uploadInfo.filename,
      storedFilename,
      mimetype: uploadInfo.mimeType,
      size: uploadInfo.fileSize,
      uploadDate: new Date().toISOString()
    });
    saveDb(db);

    // Clean up chunks
    fs.rmSync(uploadInfo.uploadChunksDir, { recursive: true, force: true });
    delete chunkedUploads[uploadId];

    res.json({
      success: true,
      code,
      filename: uploadInfo.filename,
      size: uploadInfo.fileSize
    });
  } catch (error) {
    console.error('Upload completion error:', error);
    res.status(500).json({ error: 'Failed to complete upload' });
  }
});

// Regular single file upload (keeping for backward compatibility)
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Generate a unique code (6 characters)
    const code = crypto.randomBytes(3).toString('hex');

    // Save file info to our database
    const db = getDb();
    db.files.push({
      id: code,
      filename: req.file.originalname,
      storedFilename: req.file.filename,
      mimetype: req.file.mimetype,
      size: req.file.size,
      uploadDate: new Date().toISOString()
    });
    saveDb(db);

    res.status(201).json({
      success: true,
      code,
      filename: req.file.originalname,
      size: req.file.size
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'File upload failed' });
  }
});

app.get('/api/download/:code', (req, res) => {
  try {
    const { code } = req.params;

    // Find file in database
    const db = getDb();
    const fileInfo = db.files.find(file => file.id === code);

    if (!fileInfo) {
      return res.status(404).json({ error: 'File not found' });
    }

    const filePath = path.join(uploadsDir, fileInfo.storedFilename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on server' });
    }

    // Send file info (without downloading)
    res.json({
      success: true,
      filename: fileInfo.filename,
      size: fileInfo.size,
      uploadDate: fileInfo.uploadDate
    });
  } catch (error) {
    console.error('Download info error:', error);
    res.status(500).json({ error: 'Failed to get file information' });
  }
});

app.get('/api/file/:code', (req, res) => {
  try {
    const { code } = req.params;

    // Find file in database
    const db = getDb();
    const fileInfo = db.files.find(file => file.id === code);

    if (!fileInfo) {
      return res.status(404).json({ error: 'File not found' });
    }

    const filePath = path.join(uploadsDir, fileInfo.storedFilename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on server' });
    }

    // Set headers for file download
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileInfo.filename)}"`);
    res.setHeader('Content-Type', fileInfo.mimetype);

    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'File download failed' });
  }
});

// Serve index.html for any routes not handled by the API
app.use((req, res, next) => {
  // Skip API routes
  if (req.path.startsWith('/api')) {
    return next();
  }

  // Serve index.html for all other routes
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Cleanup job for abandoned chunked uploads (runs every hour)
setInterval(() => {
  const now = Date.now();
  const uploadIds = Object.keys(chunkedUploads);

  for (const uploadId of uploadIds) {
    const uploadInfo = chunkedUploads[uploadId];
    // Remove uploads older than 24 hours
    if (now - uploadInfo.createdAt > 24 * 60 * 60 * 1000) {
      try {
        fs.rmSync(uploadInfo.uploadChunksDir, { recursive: true, force: true });
        delete chunkedUploads[uploadId];
        console.log(`Cleaned up abandoned upload: ${uploadId}`);
      } catch (error) {
        console.error(`Failed to clean up upload ${uploadId}:`, error);
      }
    }
  }
}, 60 * 60 * 1000); // Run every hour

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Server is accessible at http://localhost:${PORT}`);
  console.log('To make this accessible over the internet, you need to:');
  console.log('1. Configure your router to forward port ' + PORT);
  console.log('2. Use your public IP address or set up a domain name');
});
