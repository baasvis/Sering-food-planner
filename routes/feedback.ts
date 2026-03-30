import express, { Request, Response } from 'express';
import { prisma } from '../lib/db';

const router = express.Router();

// GET all feedback (newest first)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.feedback.findMany({ orderBy: { id: 'desc' } });
    res.json(rows);
  } catch (e: any) {
    console.error('Feedback fetch error:', e.message);
    res.status(500).json({ error: 'Could not fetch feedback' });
  }
});

router.post('/', async (req: Request, res: Response) => {
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
  } catch (e: any) {
    console.error('Feedback save error:', e.message);
    res.status(500).json({ error: 'Could not save feedback' });
  }
});

export default router;
