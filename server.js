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
  origin: [FRONTEND_URL, 'https://fileshare-app-eight.vercel.app', 'https://fileshare-backend-pa0n.onrender.com', 'http://localhost:5173'], // Your domains
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
  fs.writeFileSync(dbPath, JSON.stringify({
    files: [],
    groups: [] // Add groups array to store file groups
  }));
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
  try {
    const data = fs.readFileSync(dbPath, 'utf8');
    const db = JSON.parse(data);

    // Ensure groups array exists (for backward compatibility)
    if (!db.groups) {
      db.groups = [];
    }

    return db;
  } catch (error) {
    console.error('Error reading database:', error);
    return {
      files: [],
      groups: []
    };
  }
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
    const { uploadId, filename, totalChunks, fileSize, mimeType, chunkSize } = req.body;

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
      receivedChunksMap: new Set(), // Track which chunks have been received
      fileSize: parseInt(fileSize),
      mimeType,
      uploadChunksDir,
      createdAt: Date.now(),
      chunkSize: chunkSize || (5 * 1024 * 1024) // Default to 5MB if not specified
    };

    console.log(`Upload initialized: ${filename}, ${totalChunks} chunks, ${fileSize} bytes`);
    res.json({ success: true, message: 'Upload initialized' });
  } catch (error) {
    console.error('Upload initialization error:', error);
    res.status(500).json({ error: 'Failed to initialize upload' });
  }
});

// Handle chunk upload with optimized processing
const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // Make sure the temp directory exists
      const tempDir = path.join(chunksDir, 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      cb(null, tempDir);
    },
    filename: (req, file, cb) => {
      // Use a unique filename for each chunk
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, `chunk-${uniqueSuffix}`);
    }
  }),
  limits: {
    fileSize: 15 * 1024 * 1024, // Increased to 15MB per chunk to support larger chunk sizes
    files: 1 // Only one file per request
  }
}).single('chunk');

app.post('/api/upload/chunk', (req, res) => {
  chunkUpload(req, res, (err) => {
    if (err) {
      console.error('Chunk upload error:', err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Chunk too large. Maximum chunk size is 15MB.' });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: 'Unexpected field. Make sure to use "chunk" as the field name.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }

    try {
      const { uploadId, chunkIndex } = req.body;
      const chunkIndexNum = parseInt(chunkIndex);

      if (!chunkedUploads[uploadId]) {
        // Clean up the temporary file
        if (req.file && req.file.path) {
          fs.unlinkSync(req.file.path);
        }
        return res.status(400).json({ error: 'Invalid upload ID' });
      }

      const uploadInfo = chunkedUploads[uploadId];

      // Check if this chunk was already received (for retries)
      if (uploadInfo.receivedChunksMap.has(chunkIndexNum)) {
        // Chunk already processed, just acknowledge it
        if (req.file && req.file.path) {
          fs.unlinkSync(req.file.path); // Clean up duplicate
        }
        return res.json({
          success: true,
          receivedChunks: uploadInfo.receivedChunks,
          totalChunks: uploadInfo.totalChunks,
          duplicate: true
        });
      }

      // Validate the chunk file
      if (!req.file || !req.file.path || !fs.existsSync(req.file.path)) {
        return res.status(400).json({ error: 'No chunk file received or file is invalid' });
      }

      // Check file size - reject empty chunks
      const stats = fs.statSync(req.file.path);
      if (stats.size === 0) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Empty chunk received' });
      }

      // Move chunk from temp to the upload's chunks directory
      try {
        // Make sure the chunks directory exists
        if (!fs.existsSync(uploadInfo.uploadChunksDir)) {
          fs.mkdirSync(uploadInfo.uploadChunksDir, { recursive: true });
        }

        const chunkPath = path.join(uploadInfo.uploadChunksDir, chunkIndex);

        // Use streaming for better performance with large chunks
        const readStream = fs.createReadStream(req.file.path);
        const writeStream = fs.createWriteStream(chunkPath);

        // Set up error handlers
        readStream.on('error', (error) => {
          console.error('Chunk read error:', error);
          // Clean up
          try {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
          } catch (e) {}

          res.status(500).json({ error: 'Failed to read chunk' });
        });

        // Pipe the data
        readStream.pipe(writeStream);

        writeStream.on('finish', () => {
          // Delete the temp file after successful copy
          try {
            fs.unlinkSync(req.file.path);
          } catch (err) {
            console.error('Error deleting temp file:', err);
          }

          // Update received chunks count and map
          uploadInfo.receivedChunks++;
          uploadInfo.receivedChunksMap.add(chunkIndexNum);

          // Log progress periodically
          if (uploadInfo.receivedChunks % 5 === 0 || uploadInfo.receivedChunks === uploadInfo.totalChunks) {
            console.log(`Upload ${uploadId}: ${uploadInfo.receivedChunks}/${uploadInfo.totalChunks} chunks received`);
          }

          res.json({
            success: true,
            receivedChunks: uploadInfo.receivedChunks,
            totalChunks: uploadInfo.totalChunks
          });
        });

        writeStream.on('error', (error) => {
          console.error('Chunk write error:', error);
          // Clean up
          try {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
          } catch (e) {}

          res.status(500).json({ error: 'Failed to save chunk' });
        });
      } catch (error) {
        console.error('Chunk processing error:', error);
        // Clean up
        try {
          if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        } catch (e) {}

        res.status(500).json({ error: 'Failed to process chunk' });
      }

    } catch (error) {
      console.error('Chunk upload error:', error);
      res.status(500).json({ error: 'Failed to process chunk' });
    }
  });
});

// Complete chunked upload with optimized processing and optional compression
app.post('/api/upload/complete', express.json(), async (req, res) => {
  try {
    const { uploadId, compress } = req.body;
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

    console.log(`Completing upload: ${uploadInfo.filename}, all ${uploadInfo.totalChunks} chunks received${compress ? ' with compression' : ''}`);

    // Generate a unique code
    const code = crypto.randomBytes(3).toString('hex');

    // Create a unique filename with compression indicator if needed
    const fileExt = path.extname(uploadInfo.filename);
    const compressedExt = compress ? '.gz' : '';
    const storedFilename = `chunked-${Date.now()}-${code}${fileExt}${compressedExt}`;
    const filePath = path.join(uploadsDir, storedFilename);

    // Create write stream for the final file
    const writeStream = fs.createWriteStream(filePath);

    // Don't compress very small files (< 10KB) as it's not worth it
    if (compress && uploadInfo.fileSize < 10 * 1024) {
      console.log(`File too small for compression: ${uploadInfo.filename} (${uploadInfo.fileSize} bytes)`);
      compress = false;
    }

    // Set up compression if requested
    const outputStream = compress
      ? zlib.createGzip({ level: 6 }) // Level 6 is a good balance between speed and compression
      : writeStream;

    // If using compression, pipe the compressed output to the file
    if (compress) {
      // Set up error handlers for compression
      outputStream.on('error', (err) => {
        console.error('Compression error during chunked upload:', err);
        // If compression fails, we'll handle it after all chunks are processed
      });

      outputStream.pipe(writeStream);
    }

    // Use streams for better performance
    const combineChunks = async () => {
      for (let i = 0; i < uploadInfo.totalChunks; i++) {
        const chunkPath = path.join(uploadInfo.uploadChunksDir, i.toString());

        // Check if chunk exists
        if (!fs.existsSync(chunkPath)) {
          throw new Error(`Chunk ${i} is missing`);
        }

        // Use streaming instead of reading entire chunk into memory
        const chunkStream = fs.createReadStream(chunkPath);

        // Wait for this chunk to be fully processed
        await new Promise((resolve, reject) => {
          chunkStream.pipe(outputStream, { end: false });
          chunkStream.on('end', resolve);
          chunkStream.on('error', reject);
        });
      }

      // End the output stream after all chunks have been processed
      outputStream.end();
    };

    // Process chunks and wait for completion
    await combineChunks();

    // Wait for the file to be fully written
    await new Promise(resolve => writeStream.on('finish', resolve));

    // Get the final file size
    const stats = fs.statSync(filePath);
    const finalSize = stats.size;

    // Calculate compression ratio if compression was used
    let compressionRatio = null;
    if (compress) {
      compressionRatio = (uploadInfo.fileSize / finalSize).toFixed(2);
      console.log(`File compressed: ${uploadInfo.fileSize} -> ${finalSize} bytes (${compressionRatio}x ratio)`);
    }

    console.log(`File assembly complete: ${storedFilename}`);

    // Create a unique timestamp and ID for this file
    const timestamp = Date.now();
    const uniqueId = Math.random().toString(36).substring(2, 8);
    const internalId = `${timestamp}-${uniqueId}`;

    // Log the file details
    console.log(`Chunked upload successful: ${uploadInfo.filename}, size: ${finalSize} bytes, code: ${code}`);

    // Save file info to database
    const db = getDb();
    db.files.push({
      id: code,
      internalId: internalId,
      filename: uploadInfo.filename,
      storedFilename,
      mimetype: compress ? 'application/gzip' : uploadInfo.mimeType,
      originalMimetype: compress ? uploadInfo.mimeType : null,
      size: finalSize,
      originalSize: compress ? uploadInfo.fileSize : null,
      compressed: !!compress,
      compressionRatio: compressionRatio,
      uploadDate: new Date().toISOString(),
      chunked: true
    });
    saveDb(db);

    // Clean up chunks asynchronously
    setTimeout(() => {
      try {
        fs.rmSync(uploadInfo.uploadChunksDir, { recursive: true, force: true });
        console.log(`Cleaned up chunks for ${uploadId}`);
      } catch (err) {
        console.error(`Error cleaning up chunks for ${uploadId}:`, err);
      }
    }, 1000);

    delete chunkedUploads[uploadId];

    res.json({
      success: true,
      code,
      filename: uploadInfo.filename,
      size: finalSize,
      originalSize: compress ? uploadInfo.fileSize : null,
      compressed: !!compress,
      compressionRatio: compressionRatio,
      uploadTime: timestamp // Include the timestamp to help identify this specific upload
    });
  } catch (error) {
    console.error('Upload completion error:', error);
    res.status(500).json({ error: 'Failed to complete upload' });
  }
});

// Regular single file upload with optional compression
app.post('/api/upload', upload.single('file'), multerErrorHandler, async (req, res) => {
  try {
    // Add request ID for tracking in logs
    const requestId = Date.now().toString() + '-' + Math.random().toString(36).substring(2, 8);

    if (!req.file) {
      console.error(`[${requestId}] Upload error: No file received in request`);
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Log the upload request with request ID
    console.log(`[${requestId}] Processing upload request for file: ${req.file.originalname}, size: ${req.file.size} bytes, type: ${req.file.mimetype}`);

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
        // Using a callback-based approach instead of await
        const compressionPromise = new Promise((resolve, reject) => {
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

        // Wait for the promise to resolve
        await compressionPromise;

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

    // Log the file details with request ID
    console.log(`[${requestId}] File upload successful: ${originalFilename}, size: ${finalSize} bytes, code: ${code}, compressed: ${compress}`);

    // Add a small delay before responding to ensure file system operations are complete
    await new Promise(resolve => setTimeout(resolve, 100));

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
    const requestId = req.requestId || 'unknown';
    console.error(`[${requestId}] Upload error:`, error);

    // Provide more detailed error message
    let errorMessage = 'File upload failed';
    if (error.message) {
      errorMessage = `Upload failed: ${error.message}`;
    }

    res.status(500).json({ error: errorMessage });
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

// Create a group for multiple files
app.post('/api/group', express.json(), (req, res) => {
  try {
    const { fileIds, groupName } = req.body;

    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({ error: 'No file IDs provided' });
    }

    // Generate a unique code for the group
    const groupCode = crypto.randomBytes(3).toString('hex');

    // Get the database
    const db = getDb();

    // Verify all files exist
    const files = [];
    for (const fileId of fileIds) {
      const fileInfo = db.files.find(file => file.id === fileId);
      if (!fileInfo) {
        return res.status(404).json({ error: `File with ID ${fileId} not found` });
      }
      files.push(fileInfo);
    }

    // Create the group
    const group = {
      id: groupCode,
      name: groupName || `File Group (${files.length} files)`,
      fileIds: fileIds,
      createdAt: new Date().toISOString(),
      fileCount: files.length
    };

    // Add the group to the database
    db.groups.push(group);
    saveDb(db);

    // Return the group info
    res.status(201).json({
      success: true,
      groupCode,
      name: group.name,
      fileCount: files.length,
      files: files.map(file => ({
        id: file.id,
        filename: file.filename,
        size: file.size,
        compressed: !!file.compressed
      }))
    });
  } catch (error) {
    console.error('Group creation error:', error);
    res.status(500).json({ error: 'Failed to create file group' });
  }
});

// Get group info
app.get('/api/group/:code', (req, res) => {
  try {
    const { code } = req.params;

    // Get the database
    const db = getDb();

    // Find the group
    const group = db.groups.find(group => group.id === code);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Get all files in the group
    const files = [];
    for (const fileId of group.fileIds) {
      const fileInfo = db.files.find(file => file.id === fileId);
      if (fileInfo) {
        files.push({
          id: fileInfo.id,
          filename: fileInfo.filename,
          size: fileInfo.size,
          compressed: !!fileInfo.compressed,
          uploadDate: fileInfo.uploadDate
        });
      }
    }

    // Return the group info
    res.json({
      success: true,
      groupCode: group.id,
      name: group.name,
      fileCount: files.length,
      createdAt: group.createdAt,
      files
    });
  } catch (error) {
    console.error('Group info error:', error);
    res.status(500).json({ error: 'Failed to get group information' });
  }
});

app.get('/api/file/:code', (req, res) => {
  try {
    const { code } = req.params;

    // Find file in database
    const db = getDb();
    const fileInfo = db.files.find(file => file.id === code);

    if (!fileInfo) {
      // Check if this is a group code instead
      const group = db.groups.find(group => group.id === code);
      if (group) {
        return res.status(400).json({
          error: 'This is a file group code, not a single file code',
          isGroup: true,
          groupCode: code,
          fileCount: group.fileCount
        });
      }

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
