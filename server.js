// Load environment variables
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib'); // For file compression

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

// Configure multer storage with optimized settings
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Make sure the uploads directory exists
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Use original filename but ensure it's unique
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || ''; // Handle files without extension
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

// Error handling for multer
const multerErrorHandler = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    // A Multer error occurred when uploading
    console.error('Multer error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'File too large. Maximum file size is 100MB.'
      });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  } else if (err) {
    // An unknown error occurred
    console.error('Unknown upload error:', err);
    return res.status(500).json({ error: 'Server error during upload' });
  }
  next();
};

// Optimize multer for better performance
const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // Increased to 100MB limit
    files: 1, // Only allow one file at a time
  },
  preservePath: false, // Don't preserve the full path of the uploaded file
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
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Log the upload request
    console.log(`Processing upload request for file: ${req.file.originalname}, size: ${req.file.size} bytes`);

    // Add a unique identifier to the filename to prevent duplicates in the results
    // This doesn't change the original filename shown to users
    const timestamp = Date.now();
    const uniqueId = Math.random().toString(36).substring(2, 8);

    // Store the original filename
    const originalFilename = req.file.originalname;

    // Check if compression was requested
    let compress = req.body.optimized === 'true';

    // Don't compress very small files (< 10KB) as it's not worth it
    if (compress && req.file.size < 10 * 1024) {
      console.log(`File too small for compression: ${originalFilename} (${req.file.size} bytes)`);
      compress = false;
    }

    let finalFilePath = req.file.path;
    let finalSize = req.file.size;
    let compressionRatio = null;
    let finalMimetype = req.file.mimetype;

    // If compression is requested, compress the file
    if (compress) {
      try {
        console.log(`Compressing file: ${req.file.originalname} (${req.file.size} bytes)`);

        // Create a compressed version of the file
        const compressedFilePath = `${req.file.path}.gz`;

        // Use a promise to handle the compression process
        await new Promise((resolve, reject) => {
          const readStream = fs.createReadStream(req.file.path);
          const writeStream = fs.createWriteStream(compressedFilePath);
          const gzip = zlib.createGzip({ level: 6 });

          // Set up error handlers
          readStream.on('error', (err) => {
            console.error('Read stream error:', err);
            reject(err);
          });

          writeStream.on('error', (err) => {
            console.error('Write stream error:', err);
            reject(err);
          });

          gzip.on('error', (err) => {
            console.error('Compression error:', err);
            reject(err);
          });

          // Pipe the file through compression
          readStream.pipe(gzip).pipe(writeStream);

          // Wait for compression to complete
          writeStream.on('finish', resolve);
        });

        // Check if the compressed file exists and has content
        if (!fs.existsSync(compressedFilePath) || fs.statSync(compressedFilePath).size === 0) {
          throw new Error('Compressed file is empty or does not exist');
        }

        // Get the compressed file size
        const stats = fs.statSync(compressedFilePath);
        finalSize = stats.size;

        // Only use compression if it actually reduces the file size
        if (finalSize >= req.file.size) {
          console.log(`Compression did not reduce file size: ${req.file.size} -> ${finalSize} bytes. Using original file.`);
          fs.unlinkSync(compressedFilePath);
          compress = false;
        } else {
          // Calculate compression ratio
          compressionRatio = (req.file.size / finalSize).toFixed(2);
          console.log(`File compressed: ${req.file.size} -> ${finalSize} bytes (${compressionRatio}x ratio)`);

          // Delete the original file and use the compressed one
          fs.unlinkSync(req.file.path);
          finalFilePath = compressedFilePath;
          finalMimetype = 'application/gzip';

          // Rename the compressed file to remove the .gz extension from the stored path
          const newPath = req.file.path;
          fs.renameSync(compressedFilePath, newPath);
          finalFilePath = newPath;
        }
      } catch (compressError) {
        console.error('Compression error:', compressError);
        // If compression fails, continue with the original file
        compress = false;
      }
    }

    // Generate a unique code (6 characters)
    const code = crypto.randomBytes(3).toString('hex');

    // Create a unique internal ID for this file
    const internalId = `${timestamp}-${uniqueId}`;

    // Log the file details
    console.log(`File upload successful: ${originalFilename}, size: ${finalSize} bytes, code: ${code}`);

    // Save file info to our database
    const db = getDb();
    db.files.push({
      id: code,
      internalId: internalId,
      filename: originalFilename,
      storedFilename: path.basename(finalFilePath),
      mimetype: finalMimetype,
      originalMimetype: compress ? req.file.mimetype : null,
      size: finalSize,
      originalSize: compress ? req.file.size : null,
      compressed: !!compress,
      compressionRatio: compressionRatio,
      uploadDate: new Date().toISOString()
    });
    saveDb(db);

    res.status(201).json({
      success: true,
      code,
      filename: originalFilename,
      size: finalSize,
      originalSize: compress ? req.file.size : null,
      compressed: !!compress,
      compressionRatio: compressionRatio,
      uploadTime: timestamp // Include the timestamp to help identify this specific upload
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
      originalSize: fileInfo.originalSize,
      compressed: !!fileInfo.compressed,
      compressionRatio: fileInfo.compressionRatio,
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

    // Create a read stream for the file
    const fileStream = fs.createReadStream(filePath);

    // If the file is compressed, decompress it on-the-fly
    if (fileInfo.compressed) {
      console.log(`Decompressing file for download: ${fileInfo.filename}`);

      // Use the original mimetype for the decompressed file
      res.setHeader('Content-Type', fileInfo.originalMimetype || 'application/octet-stream');

      // Create a gunzip stream and pipe the file through it
      const gunzip = zlib.createGunzip();
      fileStream.pipe(gunzip).pipe(res);

      // Handle errors
      gunzip.on('error', (err) => {
        console.error('Decompression error:', err);
        // If decompression fails, try to send the raw file
        if (!res.headersSent) {
          res.setHeader('Content-Type', fileInfo.mimetype);
          fs.createReadStream(filePath).pipe(res);
        }
      });
    } else {
      // For non-compressed files, just send as-is
      res.setHeader('Content-Type', fileInfo.mimetype);
      fileStream.pipe(res);
    }

    // Log the download
    console.log(`File download: ${fileInfo.filename}, size: ${fileInfo.size} bytes${fileInfo.compressed ? ', compressed' : ''}`);
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
