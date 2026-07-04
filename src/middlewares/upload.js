import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { env } from '../config/env.js';

const uploadRoot = path.resolve(process.cwd(), env.uploadDir);
const defaultFolders = ['payments', 'boarding', 'companies', 'trips', 'expenses'];
fs.mkdirSync(uploadRoot, { recursive: true });
for (const folder of defaultFolders) fs.mkdirSync(path.join(uploadRoot, folder), { recursive: true });

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const folder = req.uploadFolder || 'payments';
    const dest = path.join(uploadRoot, folder);
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '.jpg') || '.jpg';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

export function setUploadFolder(folder) {
  return (req, _res, next) => {
    req.uploadFolder = folder;
    next();
  };
}

export const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Solo se permiten imágenes.'));
    cb(null, true);
  }
});

export function publicUploadPath(folder, filename) {
  if (!filename) return null;
  return `/uploads/${folder}/${filename}`;
}
