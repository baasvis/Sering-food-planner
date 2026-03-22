const router = require('express').Router();
const { prisma } = require('../lib/db');

router.post('/', async (req, res) => {
  const { type, text, screen, user, timestamp, userAgent } = req.body;
  if (!text) return res.status(400).json({ error: 'Feedback text required' });

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
    console.error('Feedback save error:', e.message);
    res.status(500).json({ error: 'Could not save feedback' });
  }
});

module.exports = router;
