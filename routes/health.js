const router = require('express').Router();
const { CONFIG } = require('../lib/config');
const { prisma } = require('../lib/db');

router.get('/', async (req, res) => {
  let dbConnected = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch (e) {}

  res.json({
    status: 'ok',
    dbConnected,
    authConfigured: !!CONFIG.GOOGLE_CLIENT_ID,
    googleClientId: CONFIG.GOOGLE_CLIENT_ID || null,
    allowedEmails: CONFIG.ALLOWED_EMAILS.length,
  });
});

module.exports = router;
