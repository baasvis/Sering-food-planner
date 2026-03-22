const router = require('express').Router();
const { prisma } = require('../lib/db');
const { logError } = require('../lib/logger');

router.post('/', async (req, res) => {
  const { type, text, screen, user, timestamp, userAgent } = req.body;
  if (!text) return res.status(400).json({ error: 'Feedback text required' });
  if (typeof text !== 'string' || text.length > 5000) return res.status(400).json({ error: 'Feedback text must be a string under 5000 characters' });

  try {
    await prisma.feedback.create({
      data: {
        timestamp: timestamp || new Date().toISOString(),
        user: user || 'anonymous',
        type: type || 'general',
        screen: screen || '',
        text,
        userAgent: userAgent || '',
      },
    });
    res.json({ ok: true });
  } catch (e) {
    logError('feedback', e, req);
    res.status(500).json({ error: 'Could not save feedback' });
  }
});

module.exports = router;
