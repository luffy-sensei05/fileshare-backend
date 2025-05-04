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
  origin: [FRONTEND_URL, 'https://file-share-app.vercel.app'], // Add your Vercel domain here
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

// Routes
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

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Server is accessible at http://localhost:${PORT}`);
  console.log('To make this accessible over the internet, you need to:');
  console.log('1. Configure your router to forward port ' + PORT);
  console.log('2. Use your public IP address or set up a domain name');
});
