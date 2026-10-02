import dotenv from 'dotenv';
dotenv.config();

export const env = {
  port: Number(process.env.PORT || 4010),
  nodeEnv: process.env.NODE_ENV || 'development',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'transdier_v2'
  },
  jwtSecret: process.env.JWT_SECRET || 'dev_secret_change_me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:4010',
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  camview: {
    // Confianza minima del OCR para mostrar una lectura como 'vista sin ticket'.
    // Las lecturas se guardan todas; esto solo filtra el ruido en pantalla y conteos.
    unmatchedMinConfidence: Math.min(1, Math.max(0, Number(process.env.CAMVIEW_UNMATCHED_MIN_CONFIDENCE || 0.8) || 0.8))
  },
  webPush: {
    subject: process.env.VAPID_SUBJECT || '',
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || ''
  }
};
