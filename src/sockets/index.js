import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

let ioInstance = null;

function allowedOrigins() {
  return String(env.frontendOrigin || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function initSocket(server) {
  const origins = allowedOrigins();
  ioInstance = new Server(server, {
    cors: {
      origin: origins.length > 1 ? origins : origins[0],
      credentials: true
    },
    transports: ['websocket', 'polling'],
    pingInterval: 10000,
    pingTimeout: 20000,
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: false
    }
  });

  ioInstance.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('NO_TOKEN'));
    try {
      socket.user = jwt.verify(token, env.jwtSecret);
      next();
    } catch (_error) {
      next(new Error('INVALID_TOKEN'));
    }
  });

  ioInstance.on('connection', (socket) => {
    const role = String(socket.user.role || '').toUpperCase();
    socket.join(`user:${socket.user.id}`);
    socket.join(`role:${role}`);
    if (role === 'ADMIN') socket.join('admins');
    if (['ADMIN', 'CASHIER', 'OPERATOR'].includes(role)) socket.join('operations');

    socket.emit('socket:ready', {
      ok: true,
      recovered: !!socket.recovered,
      connected_at_utc: new Date().toISOString()
    });

    socket.on('client:ping', (ack) => {
      if (typeof ack === 'function') ack({ ok: true, at_utc: new Date().toISOString() });
    });
  });

  return ioInstance;
}

export function emitToAdmins(event, payload) {
  if (ioInstance) ioInstance.to('admins').emit(event, payload);
}

export function emitToUser(userId, event, payload) {
  if (ioInstance) ioInstance.to(`user:${userId}`).emit(event, payload);
}

export function emitToRoles(roles, event, payload) {
  if (!ioInstance) return;
  const rooms = [...new Set((roles || []).map((role) => `role:${String(role).toUpperCase()}`))];
  if (rooms.length) ioInstance.to(rooms).emit(event, payload);
}

export function emitToOperations(event, payload) {
  if (ioInstance) ioInstance.to('operations').emit(event, payload);
}
