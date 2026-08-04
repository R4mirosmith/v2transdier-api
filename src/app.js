import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from './config/env.js';
import { errorHandler } from './middlewares/errorHandler.js';

import authRoutes from './modules/auth/auth.routes.js';
import catalogRoutes from './modules/catalog/catalog.routes.js';
import journeyRoutes from './modules/journeys/journey.routes.js';
import tripRoutes from './modules/trips/trip.routes.js';
import cashRoutes from './modules/cash/cash.routes.js';
import operationRoutes from './modules/operations/operation.routes.js';
import notificationRoutes from './modules/notifications/notification.routes.js';
import reportRoutes from './modules/reports/report.routes.js';
import userRoutes from './modules/users/user.routes.js';
import companyRoutes from './modules/companies/company.routes.js';
import ferryRoutes from './modules/ferries/ferry.routes.js';
import expenseRoutes from './modules/expenses/expense.routes.js';
import vehicleTypeRoutes from './modules/vehicle-types/vehicleType.routes.js';
import vehicleRoutes from './modules/vehicles/vehicle.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp() {
  const app = express();
  const allowedOrigins = String(env.frontendOrigin || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('CORS_ORIGIN_NOT_ALLOWED'));
    },
    credentials: true
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'transdier-v2' }));
  app.use('/uploads', express.static(path.resolve(process.cwd(), env.uploadDir)));

  app.use('/api/auth', authRoutes);
  app.use('/api/catalog', catalogRoutes);
  app.use('/api/journeys', journeyRoutes);
  app.use('/api/trips', tripRoutes);
  app.use('/api/cash', cashRoutes);
  app.use('/api/operations', operationRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/companies', companyRoutes);
  app.use('/api/ferries', ferryRoutes);
  app.use('/api/expenses', expenseRoutes);
  app.use('/api/vehicle-types', vehicleTypeRoutes);
  app.use('/api/vehicles', vehicleRoutes);

  app.use(errorHandler);
  return app;
}
