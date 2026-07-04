import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

let ioInstance = null;

export function initSocket(server) {
  ioInstance = new Server(server, {
    cors: { origin: env.frontendOrigin, credentials: true }
  });

  ioInstance.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('NO_TOKEN'));
    try {
      socket.user = jwt.verify(token, env.jwtSecret);
      next();
    } catch (_e) {
      next(new Error('INVALID_TOKEN'));
    }
  });

  ioInstance.on('connection', (socket) => {
    socket.join(`user:${socket.user.id}`);
    if (socket.user.role === 'ADMIN') socket.join('admins');
    socket.emit('socket:ready', { ok: true });
  });

  return ioInstance;
}

export function emitToAdmins(event, payload) {
  if (ioInstance) ioInstance.to('admins').emit(event, payload);
}

export function emitToUser(userId, event, payload) {
  if (ioInstance) ioInstance.to(`user:${userId}`).emit(event, payload);
}
