import express from 'express';
import { CONFIG, asyncHandler } from '../lib/config';
import { prisma } from '../lib/db';

const router = express.Router();

router.get('/', asyncHandler(async (_req, res) => {
  let dbConnected = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch (_e) {}

  res.json({
    status: 'ok',
    dbConnected,
    authConfigured: !!CONFIG.GOOGLE_CLIENT_ID,
    googleClientId: CONFIG.GOOGLE_CLIENT_ID || null,
    allowedEmails: CONFIG.ALLOWED_EMAILS.length,
  });
}));

export default router;
